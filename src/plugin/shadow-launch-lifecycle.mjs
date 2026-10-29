import { randomUUID } from 'node:crypto';
import { findNativeShadowRun, nativeReviewPrompt, nativeShadowHeadroom,
  nativeTerminal, parseNativeShadowReview, readNativeShadowRun,
  shadowAgentEligible, shadowTaskKey, sha256 } from './shadow-native.mjs';

const REASON = 'Independent bounded native Shadow review';
const reconciler = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-reconciler'] });
const orchestrator = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-orchestrator'] });
const expired = (launch) => Date.parse(launch.deadlineAt) <= Date.now();

/** Owns the durable Shadow launch: leased effects, recovery and Core reconciliation. */
export function createShadowLaunchLifecycle({ host, engineFor, launches }) {
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

  async function requestStop({ companyId, shadowId, actor, reason = 'Stop requested', idempotencyKey }) {
    const launch = (await launches.list(companyId)).find((item) => item.shadowId === shadowId);
    if (!launch) throw new Error('Active company Shadow launch not found');
    const owner = randomUUID();
    const held = await launches.acquireLease({ companyId, requestKey: launch.requestKey,
      owner, ttlSeconds: 120 });
    if (!held) throw new Error('Shadow launch is busy; retry stop request');
    try {
      const { control } = await engineFor(companyId);
      const stopped = await control.requestShadowStop({ shadowId, actor, reason,
        idempotencyKey: idempotencyKey ?? `shadow-stop:${launch.requestKey}` });
      const updated = await launches.patchData({ companyId, requestKey: launch.requestKey,
        patch: { stopRequested: true, stopReason: stopped.stopReason,
          stopRequestedAt: stopped.stopRequestedAt }, leaseOwner: owner });
      return await drive(updated, owner);
    } finally {
      await launches.releaseLease({ companyId, requestKey: launch.requestKey, owner });
    }
  }

  return { start: (launch) => lease(launch, drive), reconcile, requestStop };
}
