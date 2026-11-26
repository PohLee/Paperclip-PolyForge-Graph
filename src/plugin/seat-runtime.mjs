import { infrastructureFailure } from './model-seats.mjs';

const reported = value => typeof value === 'string' && value.trim() ? value : 'unverified';

export async function reconcileSeatRuntime({ event, host, engine, runs, decisions, dispatch, getDispatch, config }) {
  const { companyId, payload } = event;
  const agentRunId = payload?.runId ?? event.entityId;
  if (!agentRunId) return;
  const actor = { id: host.manifest.id, kind: 'system', roles: [] };
  for (const intent of decisions.filter(item => item.type === 'model-seat-dispatch')) {
    const run = runs[intent.runId];
    const { nodeId } = intent;
    const { attempt, selection } = intent.evidence[0];
    const row = await getDispatch(companyId, intent.runId, nodeId, attempt, 'work');
    if (row?.agent_run_id !== agentRunId || !run) continue;
    const actual = { harness: reported(payload?.adapterType), model: reported(payload?.model) };
    const failure = event.eventType === 'agent.run.failed' ? infrastructureFailure(payload?.error) : null;
    const state = run.nodeStates[nodeId];
    const current = run.status === 'running' && state?.status === 'pending' && state.attempts.length + 1 === attempt;
    let fallback = false;
    if (failure && current) {
      const project = (await host.config?.get(companyId))?.adlcProjects?.[run.input.projectId];
      const issue = row.issue_id && await host.issues.get(row.issue_id, companyId);
      // The issue itself is already known. Only configured read-only tasks can
      // retry without a project-specific check for published PRs or merges.
      fallback = Boolean(issue && project?.sideEffectFreeNodes?.[run.graph.id]?.includes(nodeId)
        && !['done', 'cancelled'].includes(issue.status)
        && !issue.assigneeUserId && issue.assigneeAgentId === row.agent_id);
    }
    const record = await engine.recordDecision({
      type: 'model-seat-runtime', status: 'recorded', actor, runId: run.id, nodeId, issueId: row.issue_id,
      reason: failure ?? 'Paperclip runtime completed',
      evidence: [{ kind: 'model_seat_runtime', attempt, selection, actual, failure, fallback }],
      idempotencyKey: 'seat-runtime:' + agentRunId,
    });
    if (!current || !record.evidence[0].fallback) return;
    const result = await dispatch.retryNode(companyId, engine, {
      runId: run.id, nodeId, actor, reason: 'Infrastructure failure: ' + failure,
      infrastructureDecisionId: record.id, idempotencyKey: 'seat-fallback:' + agentRunId,
    });
    if (result.nextAttempt !== null) await dispatch.dispatchReady(companyId, engine, run.id, config);
    return;
  }
}

