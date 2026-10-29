import { randomUUID } from 'node:crypto';
import { shadowReviewPacket } from './shadow-context.mjs';
import { shadowActorForRun } from './fixture-shadow.mjs';
import { createShadowLaunchStore, shadowRequestFingerprint } from './shadow-launch-store.mjs';
import { getDispatchForIssue } from './store.mjs';
import { findNativeShadowRun, nativeCandidateMaterial, nativeReviewPrompt,
  nativeShadowHeadroom, nativeTerminal, parseNativeShadowReview, readNativeShadowRun,
  shadowAgentEligible, shadowTaskKey, sha256 } from './shadow-native.mjs';

const REASON = 'Independent bounded native Shadow review';
const reconciler = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-reconciler'] });
const orchestrator = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-orchestrator'] });
const presentation = (launch, replayed = false) => ({ status: launch.status,
  shadowId: launch.shadowId, sessionId: launch.sessionId,
  executionId: launch.executionId, deadlineAt: launch.deadlineAt, replayed });
const expired = (launch) => Date.parse(launch.deadlineAt) <= Date.now();

/** Host-backed runtime. No run cancellation or privileged host HTTP access is assumed. */
export function createShadowRuntime({ host, engineFor, getConfig,
  launchStore = createShadowLaunchStore(host.db) }) {
  const launches = launchStore;

  async function lease(launch, fn) {
    const owner = randomUUID();
    const held = await launches.acquireLease({ companyId: launch.companyId,
      requestKey: launch.requestKey, owner, ttlSeconds: 120 });
    if (!held) return launches.get(launch.companyId, launch.requestKey);
    try { return await fn(held, owner); }
    finally { await launches.releaseLease({ companyId: launch.companyId,
      requestKey: launch.requestKey, owner }); }
  }

  async function finish(launch, owner, outcome, reviewResult = null) {
    if (launch.status === 'closed') return launch;
    if (launch.status !== 'closing') {
      launch = await launches.transition({ companyId: launch.companyId, requestKey: launch.requestKey,
        from: launch.status, to: 'closing', outcome, data: { reviewResult }, leaseOwner: owner });
    }
    let resolvedOutcome = launch.outcome ?? outcome;
    let resolvedResult = launch.data?.reviewResult ?? reviewResult;
    if (launch.shadowId) {
      const { control } = await engineFor(launch.companyId);
      let shadow = (await control.getShadows()).find((item) => item.id === launch.shadowId);
      if (shadow?.status !== 'closed') {
        shadow = await control.closeShadow({ shadowId: launch.shadowId, outcome: resolvedOutcome,
          ...(resolvedResult && resolvedOutcome === 'completed' ? { reviewResult: resolvedResult } : {}),
          actor: reconciler(host), reason: launch.data?.reason ?? REASON,
          idempotencyKey: `shadow-close:${launch.requestKey}` });
      }
      if (shadow?.status === 'closed') {
        resolvedOutcome = shadow.outcome;
        resolvedResult = shadow.reviewResult ?? null;
      }
    }
    if (launch.sessionId) {
      try { await host.agents.sessions.close(launch.sessionId, launch.companyId); }
      catch (error) {
        if (!/Session not found/i.test(String(error))) throw error;
      }
    }
    return launches.transition({ companyId: launch.companyId, requestKey: launch.requestKey,
      from: 'closing', to: 'closed', outcome: resolvedOutcome,
      data: { reviewResult: resolvedOutcome === 'completed' ? resolvedResult : null }, leaseOwner: owner });
  }

  async function settled(launch, owner, row) {
    if (!row || !nativeTerminal(row.status)) return launch;
    const finishedAt = Date.parse(row.finished_at ?? row.finishedAt ?? '');
    const deadline = Date.parse(launch.deadlineAt);
    const afterDeadline = !Number.isFinite(finishedAt) || finishedAt > deadline;
    const afterStop = launch.data?.stopRequested === true;
    const outcome = afterStop ? 'cancelled' : afterDeadline ? 'timeout' :
      row.status === 'succeeded' ? 'completed' : row.status === 'cancelled' ? 'cancelled' :
      ['timed_out', 'timeout'].includes(row.status) ? 'timeout' : 'failed';
    // Older launch rows have no pinned packet. A terminal heartbeat proves the
    // native run ended, but cannot prove what candidate its reply reviewed.
    const reviewResult = outcome === 'completed' && launch.data?.packet
      ? parseNativeShadowReview(row, launch.data.packet, launch.data.adapterType)
      : null;
    return finish(launch, owner, outcome === 'completed' && !reviewResult ? 'failed' : outcome,
      reviewResult);
  }

  async function drive(launch, owner) {
    const { companyId, requestKey, agentId } = launch;
    const data = launch.data ?? {};
    if (launch.status === 'closed') return launch;
    if (launch.status === 'closing') return finish(launch, owner, launch.outcome ?? 'failed');

    // A stop before send is final: there is no native run to wait for or wake.
    if (data.stopRequested === true &&
        ['claimed', 'session-created', 'reserved'].includes(launch.status)) {
      return finish(launch, owner, 'cancelled');
    }

    if (launch.status === 'creating') {
      // The SDK create call may have completed before a worker crash. Its list API
      // omits taskKey, so recreating here could fork the session.
      if (expired(launch)) return launches.transition({ companyId, requestKey,
        from: 'creating', to: 'needs-repair', data: { stopRequested: true,
          repairReason: 'session_create_outcome_unknown' }, leaseOwner: owner });
      return launch;
    }
    if (['starting', 'needs-repair'].includes(launch.status) && !launch.executionId && data.taskKey) {
      const found = await findNativeShadowRun(host.db, { companyId, agentId, taskKey: data.taskKey });
      if (found && launch.shadowId) {
        launch = await launches.transition({ companyId, requestKey, from: launch.status,
          to: 'active', executionId: found.id, leaseOwner: owner });
      } else if (expired(launch) && launch.status === 'starting') {
        return launches.transition({ companyId, requestKey, from: 'starting',
          to: 'needs-repair', data: { stopRequested: true,
            repairReason: 'session_send_outcome_unknown' }, leaseOwner: owner });
      } else return launch;
    }
    if (launch.status === 'needs-repair' && launch.executionId) {
      launch = await launches.transition({ companyId, requestKey,
        from: 'needs-repair', to: 'active', leaseOwner: owner });
    }
    if (launch.status === 'claimed') {
      if (expired(launch)) return finish(launch, owner, 'timeout');
      const { control } = await engineFor(companyId);
      const packet = data.packet;
      const context = await control.recordShadowContext({ parentRunId: launch.parentRunId,
        parentTaskId: launch.parentTaskId,
        candidateRefs: packet.candidates.map(({ id, version, digest }) => ({ id, version, digest })),
        payloadDigest: sha256(JSON.stringify(packet)), actor: orchestrator(host),
        reason: data.reason ?? REASON,
        idempotencyKey: `shadow-context:${requestKey}` });
      const contextRef = { sourceRunId: launch.parentRunId, sourceNodeId: launch.parentTaskId,
        snapshotId: context.id, payloadDigest: sha256(JSON.stringify(packet)) };
      launch = await launches.transition({ companyId, requestKey, from: 'claimed', to: 'creating',
        data: { contextRef }, leaseOwner: owner });
      const session = await host.agents.sessions.create(agentId, companyId, {
        taskKey: data.taskKey, reason: REASON });
      launch = await launches.transition({ companyId, requestKey, from: 'creating',
        to: 'session-created', sessionId: session.sessionId, leaseOwner: owner });
    }
    if (launch.status === 'session-created') {
      if (expired(launch)) return finish(launch, owner, 'timeout');
      const { control } = await engineFor(companyId);
      const shadow = await control.prepareShadow({ parentRunId: launch.parentRunId,
        parentTaskId: launch.parentTaskId, role: 'independent-review',
        sessionId: launch.sessionId, parentExecutionId: data.parentExecutionId ?? undefined,
        contextRef: launch.data.contextRef,
        scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1,
          deadlineAt: launch.deadlineAt }, actor: data.actor,
        reason: data.reason ?? REASON, idempotencyKey: `shadow-prepare:${requestKey}` });
      launch = await launches.transition({ companyId, requestKey, from: 'session-created',
        to: 'reserved', shadowId: shadow.id, leaseOwner: owner });
    }
    if (launch.status === 'reserved') {
      if (expired(launch)) return finish(launch, owner, 'timeout');
      const { control } = await engineFor(companyId);
      const policy = await control.getShadowPolicy();
      const reviewer = await host.agents.get(agentId, companyId);
      if (!reviewer || reviewer.companyId !== companyId ||
          !shadowAgentEligible(reviewer, policy) ||
          !(await nativeShadowHeadroom(host.db, companyId, reviewer))) return launch;
      launch = await launches.transition({ companyId, requestKey, from: 'reserved',
        to: 'starting', leaseOwner: owner });
      const sent = await host.agents.sessions.sendMessage(launch.sessionId, companyId, {
        prompt: nativeReviewPrompt(launch.data.packet, launch.data.candidateMaterial),
        reason: REASON });
      launch = await launches.transition({ companyId, requestKey, from: 'starting',
        to: 'active', executionId: sent.runId, leaseOwner: owner });
    }
    if (launch.status === 'active') {
      if (!launch.executionId) return launches.transition({ companyId, requestKey,
        from: 'active', to: 'needs-repair',
        data: { repairReason: 'native_execution_id_missing' }, leaseOwner: owner });
      const { control } = await engineFor(companyId);
      const row = await readNativeShadowRun(host.db, { companyId, agentId,
        executionId: launch.executionId,
        taskKey: data.taskKey ?? shadowTaskKey(host.manifest.id, requestKey) });
      if (!row) return launch; // Missing or mismatched native scope is never completion.
      const shadow = (await control.getShadows()).find((item) => item.id === launch.shadowId);
      if (!data.packet) {
        // Upgrade recovery may only retire a legacy launch after its exact
        // company/Agent/execution heartbeat has reached a terminal state.
        if (!nativeTerminal(row.status)) return launch;
        if (!shadow) return launches.transition({ companyId, requestKey,
          from: 'active', to: 'needs-repair',
          data: { repairReason: 'core_shadow_missing' }, leaseOwner: owner });
        return shadow.status === 'closed'
          ? finish(launch, owner, shadow.outcome ?? 'failed', shadow.reviewResult ?? null)
          : finish(launch, owner, 'failed');
      }
      if (shadow?.status === 'closed') {
        return finish(launch, owner, shadow.outcome ?? 'failed');
      }
      if (shadow?.status === 'reserved' && expired(launch)) {
        if (!nativeTerminal(row.status)) return launch;
        const finishedAt = row.finished_at ?? row.finishedAt;
        const verifiedFinishedAt = finishedAt && Number.isFinite(Date.parse(finishedAt))
          ? new Date(finishedAt).toISOString() : null;
        if (!verifiedFinishedAt || Date.parse(verifiedFinishedAt) > Date.parse(launch.deadlineAt)) {
          return finish(launch, owner, 'timeout');
        }
        // Core accepts a late binding only with a host-verified terminal time.
        await control.bindShadowExecution({ shadowId: launch.shadowId,
          executionId: launch.executionId, finishedAt: verifiedFinishedAt,
          actor: reconciler(host), reason: REASON,
          idempotencyKey: `shadow-bind:${requestKey}` });
        return settled(launch, owner, row);
      }
      if (shadow?.status === 'reserved') {
        await control.bindShadowExecution({ shadowId: launch.shadowId,
          executionId: launch.executionId, actor: reconciler(host), reason: data.reason ?? REASON,
          idempotencyKey: `shadow-bind:${requestKey}` });
      } else if (shadow?.status !== 'active' || shadow.executionId !== launch.executionId) {
        throw new Error('Native Shadow Core binding is inconsistent');
      }
      return settled(launch, owner, row);
    }
    return launch;
  }

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
    try { return presentation(await lease(claim, drive)); }
    catch (error) {
      host.logger?.warn?.('Native Shadow launch requires reconciliation', {
        companyId, requestKey, error: String(error) });
      throw error;
    }
  }

  async function reconcile({ companyId }) {
    const results = [];
    for (const launch of await launches.list(companyId)) {
      try { results.push(await lease(launch, drive)); }
      catch (error) {
        host.logger?.warn?.('Native Shadow reconciliation failed', {
          companyId, requestKey: launch.requestKey, error: String(error) });
        results.push(await launches.get(companyId, launch.requestKey));
      }
    }
    return results;
  }

  async function closeByShadowId({ companyId, shadowId, actor, reason = 'Stop requested', idempotencyKey }) {
    const launch = (await launches.list(companyId)).find((item) => item.shadowId === shadowId);
    if (!launch) throw new Error('Active company Shadow launch not found');
    const { control } = await engineFor(companyId);
    const stopped = await control.requestShadowStop({ shadowId, actor, reason,
      idempotencyKey: idempotencyKey ?? `shadow-stop:${launch.requestKey}` });
    const updated = await launches.patchData({ companyId, requestKey: launch.requestKey,
      patch: { stopRequested: true, stopReason: stopped.stopReason,
        stopRequestedAt: stopped.stopRequestedAt } });
    await reconcile({ companyId });
    return presentation(await launches.get(companyId, launch.requestKey) ?? updated);
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

  return { open, reconcile, closeByShadowId, beforeDispatch, list: (companyId) => launches.list(companyId) };
}
