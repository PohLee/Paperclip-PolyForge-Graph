import { shadowReviewPacket } from './shadow-context.mjs';
import { shadowActorForRun } from './fixture-shadow.mjs';
import { createShadowLaunchStore, shadowRequestFingerprint } from './shadow-launch-store.mjs';
import { createShadowLaunchLifecycle } from './shadow-launch-lifecycle.mjs';
import { getDispatchForIssue } from './store.mjs';
import { nativeCandidateMaterial, nativeShadowHeadroom, shadowAgentEligible, shadowTaskKey } from './shadow-native.mjs';

const REASON = 'Independent bounded native Shadow review';
const orchestrator = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-orchestrator'] });
const presentation = (launch, replayed = false) => ({ status: launch.status,
  shadowId: launch.shadowId, sessionId: launch.sessionId,
  executionId: launch.executionId, deadlineAt: launch.deadlineAt, replayed });

/** Host-backed runtime. No run cancellation or privileged host HTTP access is assumed. */
export function createShadowRuntime({ host, engineFor, getConfig,
  launchStore = createShadowLaunchStore(host.db) }) {
  const launches = launchStore;
  const lifecycle = createShadowLaunchLifecycle({ host, engineFor, launches });

  async function open({ companyId, actor, payload, common, available = true }) {
    if (!available) throw new Error('Native Shadow capability unavailable for this company');
    const requestKey = `${companyId}:${common.idempotencyKey}`;
    const replay = await launches.get(companyId, requestKey);
    if (replay) {
      const fingerprint = shadowRequestFingerprint({ companyId, actor,
        parentRunId: payload.parentRunId, parentTaskId: payload.parentTaskId,
        parentIssueId: payload.parentIssueId ?? null, agentId: payload.agentId,
        reason: common.reason ?? null, snapshotId: replay.data?.packet?.snapshotId });
      if (replay.fingerprint !== fingerprint) throw new Error('Shadow idempotency key reused with different request');
      return presentation(replay, true);
    }
    const { engine, control } = await engineFor(companyId);
    const run = await engine.getRun(payload.parentRunId);
    if (!run || !['running', 'paused'].includes(run.status) ||
        run.input?.paperclipCompanyId !== companyId || !run.input?.projectId ||
        !run.nodeStates?.[payload.parentTaskId] ||
        run.nodeStates[payload.parentTaskId].status === 'completed') {
      throw new Error('Active parent Graph task in this company required');
    }
    const node = run.graph.nodes.find((item) => item.id === payload.parentTaskId);
    if (!node) throw new Error('Parent Graph node not found');
    const policy = await control.getShadowPolicy();
    const graphActor = actor.kind === 'system' && actor.roles?.length === 1 &&
      actor.roles[0] === 'shadow-orchestrator';
    if (graphActor && !(policy.allowGraphTrigger && node.shadow?.trigger === 'before-dispatch' &&
        node.shadow.reviewer === 'same-agent' && node.shadow.required === true)) {
      throw new Error('Graph Shadow declaration or policy unavailable');
    }
    if (actor.kind === 'agent') {
      if (!policy.allowAgentTrigger) throw new Error('Agent Shadow trigger disabled');
      shadowActorForRun(actor, run, node);
      const dispatch = await getDispatchForIssue(host.db, companyId, payload.parentIssueId,
        run.id, node.id);
      if (!dispatch || dispatch.agent_id !== actor.id || dispatch.agent_run_id !== actor.executionId ||
          dispatch.phase !== 'work') throw new Error('Current parent dispatch does not match Agent run');
      await host.issues.assertCheckoutOwner({ issueId: payload.parentIssueId, companyId,
        actorAgentId: actor.id, actorRunId: actor.executionId });
    } else if (!graphActor && (actor.kind !== 'human' || !actor.roles?.includes('human-owner'))) {
      throw new Error('Human owner or owning Graph Agent required');
    }
    const reviewer = await host.agents.get(payload.agentId, companyId);
    if (!reviewer || reviewer.companyId !== companyId || !shadowAgentEligible(reviewer, policy)) {
      throw new Error('Same-Agent native Shadow requires eligible adapter, budget, timeout and concurrent slots');
    }
    const graphConfig = await getConfig?.(host.db, companyId);
    const boundIds = new Set(Object.values(graphConfig?.roleBindings ?? {}));
    if (!boundIds.has(reviewer.id)) throw new Error('Shadow reviewer must be a current company role binding');
    const boundId = graphConfig?.roleBindings?.[`${run.packId}:${node.role}`];
    if (graphActor && reviewer.id !== boundId) throw new Error('Graph Shadow must use bound node Agent');
    if (actor.kind === 'agent' && reviewer.id !== actor.id) throw new Error('Shadow must use the owning Agent');
    if (reviewer.id === actor.id && !policy.allowSameAgent) throw new Error('Same-Agent Shadow is disabled');
    if (graphActor && !policy.allowSameAgent) throw new Error('Same-Agent Graph Shadow is disabled');
    if (!(await nativeShadowHeadroom(host.db, companyId, reviewer))) {
      throw new Error('Native Shadow Agent has no current execution slot');
    }
    const packet = shadowReviewPacket(run, node.id);
    const candidateMaterial = nativeCandidateMaterial(run, packet);
    if (reviewer.adapterType !== 'process' && candidateMaterial.some((item) =>
      item.output == null && !Object.keys(item.artifact ?? {}).length &&
      !(item.evidence?.length > 0))) {
      throw new Error('Shadow candidate source content is unavailable');
    }
    const fingerprint = shadowRequestFingerprint({ companyId, actor,
      parentRunId: run.id, parentTaskId: node.id, agentId: reviewer.id,
      parentIssueId: payload.parentIssueId ?? null, reason: common.reason ?? null,
      snapshotId: packet.snapshotId });
    const deadlineAt = new Date(Date.now() + Math.min(policy.maxDurationSeconds,
      reviewer.adapterConfig.timeoutSec) * 1000).toISOString();
    const claim = await launches.claim({ companyId, requestKey, fingerprint, agentId: reviewer.id,
      parentRunId: run.id, parentTaskId: node.id, deadlineAt,
      data: { actor: graphActor ? orchestrator(host) : shadowActorForRun(actor, run, node),
        parentExecutionId: actor.executionId ?? null, reason: common.reason ?? REASON,
        packet,
        candidateMaterial,
        adapterType: reviewer.adapterType, taskKey: shadowTaskKey(host.manifest.id, requestKey) } });
    if (!claim.created) return presentation(claim, true);
    try { return presentation(await lifecycle.start(claim)); }
    catch (error) {
      host.logger?.warn?.('Native Shadow launch requires reconciliation', {
        companyId, requestKey, error: String(error) });
      throw error;
    }
  }

  async function closeByShadowId(input) {
    return presentation(await lifecycle.requestStop(input));
  }

  async function beforeDispatch({ companyId, engine, run, node, config, agentId, phase = 'work' }) {
    if (!node.shadow) {
      return { ready: true, status: 'not_required' };
    }
    if (node.shadow.trigger !== 'before-dispatch' || node.shadow.reviewer !== 'same-agent' ||
        node.shadow.required !== true) return { ready: false, status: 'invalid_shadow_declaration' };
    if (phase !== 'work') return { ready: true, status: 'not_work_phase' };
    const nodeState = run.nodeStates?.[node.id];
    if (!nodeState || !['pending', 'running'].includes(nodeState.status)) {
      return { ready: false, status: 'not_work_ready' };
    }
    const selectedAgentId = agentId ?? config?.roleBindings?.[`${run.packId}:${node.role}`];
    if (!selectedAgentId) return { ready: false, status: 'unbound' };
    let packet;
    try { packet = shadowReviewPacket(run, node.id); }
    catch (error) { return { ready: false, status: 'source_unavailable', reason: String(error) }; }
    const attempt = (nodeState.attempts?.length ?? 0) + (nodeState.status === 'pending' ? 1 : 0);
    const idempotencyKey = `before-dispatch:${run.id}:${node.id}:${attempt}:${packet.snapshotId}`;
    const requestKey = `${companyId}:${idempotencyKey}`;
    let launch = await launches.get(companyId, requestKey);
    if (!launch) {
      const other = (await launches.list(companyId)).find((item) =>
        item.parentRunId === run.id && item.parentTaskId === node.id);
      if (other) return { ready: false, status: other.status, shadowId: other.shadowId };
      try {
        await open({ companyId, actor: orchestrator(host),
          payload: { parentRunId: run.id, parentTaskId: node.id,
            parentIssueId: run.input?.paperclipIssueId ?? null,
            agentId: selectedAgentId },
          common: { idempotencyKey, reason: `Required independent review before ${node.id} dispatch` } });
      } catch (error) {
        return { ready: false, status: 'unavailable', reason: String(error) };
      }
      launch = await launches.get(companyId, requestKey);
    }
    if (!launch) return { ready: false, status: 'unknown' };
    if (launch.status !== 'closed') return { ready: false, status: launch.status,
      shadowId: launch.shadowId, executionId: launch.executionId };
    const ready = launch.outcome === 'completed' &&
      launch.data?.reviewResult?.verdict === 'accept';
    return { ready, status: ready ? 'accepted' : launch.outcome ?? 'failed',
      shadowId: launch.shadowId, verdict: launch.data?.reviewResult?.verdict ?? null };
  }

  return { open, reconcile: lifecycle.reconcile, closeByShadowId, beforeDispatch,
    list: (companyId) => launches.list(companyId) };
}
