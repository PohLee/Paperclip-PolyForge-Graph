import { getDispatchForRunIssue, hasDispatchForIssue } from './store.mjs';

const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const childTaskKey = value => /^plugin:[^:]+:session:(temporary|shadow):/.test(value ?? '');
const read = (row, snake, camel) => row?.[snake] ?? row?.[camel];
const actorForPack = (actor, pack) => ({ ...actor, roles: [...new Set([
  ...(actor.roles ?? []),
  ...Object.keys(pack?.roles ?? {}).filter(role =>
    actor.roles?.includes(`${pack.id}:${role}`) ||
    pack.id === 'adlc' && actor.roles?.includes(role)),
])] });

/** Resolve a delegation against authenticated, active Paperclip and Graph state. */
export function createTemporaryAgentParentResolver({ host, engineFor, getConfig, dispatch }) {
  return async function resolveParentAuthority({ companyId, actor, request }) {
    const parent = request?.parent;
    if (!nonempty(companyId) || actor?.kind !== 'agent' || !nonempty(actor.id) ||
        !nonempty(actor.executionId) || actor.id !== parent?.agentId ||
        actor.executionId !== parent?.executionId || !nonempty(parent?.taskId)) {
      throw new Error('Authenticated parent Agent execution and native task are required');
    }
    const { engine, control, store } = await engineFor(companyId);
    const config = await getConfig(host.db, companyId);
    const setup = await control.getSetup();
    if (setup.companyId !== companyId || !setup.enabledPacks?.length) {
      throw new Error('Company must have an enabled Pack before Agent delegation');
    }
    const agent = await host.agents.get(actor.id, companyId);
    if (!agent || agent.companyId !== companyId) throw new Error('Parent Agent is not in company');
    const state = await store.read();
    const bound = Object.entries(config.roleBindings ?? {}).some(([key, id]) => {
      if (id !== actor.id) return false;
      if (key === 'ceo') return setup.organization?.ceo?.id === actor.id;
      return setup.enabledPacks.some(({ packId, version }) => {
        const pack = state?.packs?.[`${packId}@${version}`];
        return Boolean(pack?.roles &&
          (key.startsWith(`${packId}:`) && Object.hasOwn(pack.roles, key.slice(packId.length + 1)) ||
            packId === 'adlc' && Object.hasOwn(pack.roles, key)));
      });
    });
    if (!bound) throw new Error('Parent Agent has no enabled company Pack role binding');

    // to_jsonb keeps this query compatible with hosts that have not yet added
    // session_before_id/session_after_id columns to heartbeat_runs.
    const rows = await host.db.query(`SELECT id, status,
      context_snapshot->>'taskKey' AS task_key,
      to_jsonb(hr)->>'session_before_id' AS session_before_id,
      to_jsonb(hr)->>'session_after_id' AS session_after_id
      FROM public.heartbeat_runs hr
      WHERE company_id=$1 AND agent_id=$2 AND id=$3 LIMIT 1`,
    [companyId, actor.id, actor.executionId]);
    const heartbeat = rows[0];
    if (!heartbeat || heartbeat.status !== 'running') throw new Error('Active running parent heartbeat required');
    if (childTaskKey(read(heartbeat, 'task_key', 'taskKey'))) {
      throw new Error('Temporary or legacy Shadow execution cannot delegate');
    }
    const issue = await host.issues.get(parent.taskId, companyId);
    if (!issue || issue.companyId && issue.companyId !== companyId ||
        issue.assigneeAgentId !== actor.id) throw new Error('Parent native issue assignment does not match Agent');
    const checkout = await host.issues.assertCheckoutOwner({ issueId: parent.taskId,
      companyId, actorAgentId: actor.id, actorRunId: actor.executionId });
    if (checkout?.issueId !== parent.taskId || checkout.assigneeAgentId !== actor.id ||
        checkout.checkoutRunId !== actor.executionId) {
      throw new Error('Parent native issue checkout does not match execution');
    }

    const graphBacked = await hasDispatchForIssue(host.db, companyId, parent.taskId);
    if (graphBacked || parent.runId) {
      if (!nonempty(parent.runId)) throw new Error('Graph child delegation requires a parent Graph run');
      const run = await engine.getRun(parent.runId);
      if (!run || run.status !== 'running' ||
          run.input?.paperclipCompanyId !== companyId ||
          !setup.enabledPacks.some(item => item.packId === run.packId && item.version === run.packVersion)) {
        throw new Error('Active pinned company Graph run required');
      }
      const graphDispatch = await getDispatchForRunIssue(host.db, companyId, parent.taskId, run.id);
      const nodeStatus = run.nodeStates?.[graphDispatch?.node_id]?.status;
      const expectedStatus = graphDispatch?.phase === 'supervisor'
        ? nodeStatus === 'awaiting_supervisor_review'
        : ['pending', 'running'].includes(nodeStatus);
      if (!graphDispatch || graphDispatch.agent_id !== actor.id ||
          graphDispatch.agent_run_id !== actor.executionId || graphDispatch.state !== 'woken' ||
          !['work', 'supervisor'].includes(graphDispatch.phase) ||
          parent.nodeId && parent.nodeId !== graphDispatch.node_id ||
          !expectedStatus ||
          !run.graph?.nodes?.some(node => node.id === graphDispatch.node_id)) {
        throw new Error('Current Graph dispatch and active pinned node required');
      }
      if (dispatch?.assertAgentCallback) {
        await dispatch.assertAgentCallback({ companyId, issueId: parent.taskId, run,
          actor: actorForPack(actor, run.pack), nodeId: graphDispatch.node_id,
          operation: graphDispatch.phase === 'supervisor' ? 'review' : 'submit' });
      }
    }

    const nativeSession = read(heartbeat, 'session_before_id', 'sessionBeforeId') ??
      read(heartbeat, 'session_after_id', 'sessionAfterId');
    const parentSessionRef = nonempty(nativeSession)
      ? nativeSession : `native-execution:${actor.executionId}`;
    if (request.context?.parentSessionRef !== undefined &&
        request.context.parentSessionRef !== parentSessionRef) {
      throw new Error('Requested parent context does not match trusted heartbeat');
    }
    if (request.kind === 'shadow-agent' && !nonempty(nativeSession)) {
      throw new Error('Native Shadow fork requires a trusted parent session');
    }
    return { agentId: actor.id, canDelegate: true,
      allowedActions: ['read', 'review', 'research', 'analyze'],
      parentSessionRef, workspace: { allowSharedWrite: false } };
  };
}
