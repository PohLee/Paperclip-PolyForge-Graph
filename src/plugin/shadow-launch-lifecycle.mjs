import { randomUUID } from 'node:crypto';
import { shadowReviewPacket } from './shadow-context.mjs';
import { findNativeShadowRun, NativeShadowAmbiguityError, issueBackedShadow, matchesNativeShadowIssue, nativeReviewPrompt,
  nativeShadowHeadroom, nativeShadowIssueRequest, nativeTerminal, parseNativeShadowReview, readNativeShadowRun,
  shadowAgentEligible, shadowTaskKey, sha256 } from './shadow-native.mjs';

const REASON = 'Independent bounded native Shadow review';
const reconciler = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-reconciler'] });
const orchestrator = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-orchestrator'] });
const expired = (launch) => Date.parse(launch.deadlineAt) <= Date.now();
const WAKEABLE_ISSUE_STATES = new Set(['todo', 'in_progress', 'in_review']);

/** Owns the durable Shadow launch: leased effects, recovery and Core reconciliation. */
export function createShadowLaunchLifecycle({ host, engineFor, launches, getConfig }) {
  async function lease(launch, fn) {
    const owner = randomUUID();
    const held = await launches.acquireLease({ companyId: launch.companyId,
      requestKey: launch.requestKey, owner, ttlSeconds: 120 });
    if (!held) return launches.get(launch.companyId, launch.requestKey);
    try { return await fn(held, owner); }
    finally { await launches.releaseLease({ companyId: launch.companyId,
      requestKey: launch.requestKey, owner }); }
  }

  const issueRequest = (launch) => nativeShadowIssueRequest(host.manifest.id, launch);
  const nativeScope = (launch) => ({ companyId: launch.companyId, agentId: launch.agentId,
    taskKey: launch.data?.taskKey, ...(issueBackedShadow(launch) && { issueId: launch.sessionId }) });

  function assertIssueScope(launch, issue) {
    if (!matchesNativeShadowIssue(issue, issueRequest(launch)) ||
        (issue.assigneeAgentId && issue.assigneeAgentId !== launch.agentId)) {
      throw new Error('Native Shadow review issue no longer matches the pinned launch');
    }
    return issue;
  }

  async function readIssue(launch) {
    const issue = await host.issues.get(launch.sessionId, launch.companyId);
    if (issue?.id !== launch.sessionId) throw new Error('Pinned native Shadow review issue is unavailable');
    return assertIssueScope(launch, issue);
  }

  // finish() retires work it still owns. An issue that was reassigned or edited
  // is reported as unowned instead of blocking the launch from closing.
  async function readOwnedIssue(launch) {
    const issue = await host.issues.get(launch.sessionId, launch.companyId);
    if (issue?.id !== launch.sessionId) return { issue: null, owned: false };
    try { return { issue: assertIssueScope(launch, issue), owned: true }; }
    catch { return { issue, owned: false }; }
  }

  // Several executions on one pinned issue cannot be attributed to this review.
  // Report the ambiguity so the launch fails closed instead of retrying forever.
  async function findExecution(launch) {
    try { return { found: await findNativeShadowRun(host.db, nativeScope(launch)) }; }
    catch (error) {
      if (!issueBackedShadow(launch) || !(error instanceof NativeShadowAmbiguityError)) throw error;
      return { ambiguous: true };
    }
  }

  async function recoverIssue(launch) {
    const { companyId, projectId, originKind, originId } = issueRequest(launch);
    const found = await host.issues.list({ companyId, projectId, originKind, originId,
      includePluginOperations: true, limit: 2 });
    if (!found.length) return null;
    if (found.length !== 1) throw new Error('Native Shadow review issue origin is ambiguous');
    const issue = assertIssueScope(launch, found[0]);
    if (issue.assigneeAgentId || issue.status !== 'backlog') throw new Error('Recovered native Shadow review issue was assigned before reservation');
    return issue;
  }

  async function issueParentCurrent(launch, engine, control) {
    const run = await engine.getRun(launch.parentRunId);
    const node = run?.graph.nodes.find(node => node.id === launch.parentTaskId);
    const state = run?.nodeStates[launch.parentTaskId];
    if (!node || !state || !['running', 'paused'].includes(run.status) ||
        run.input.paperclipCompanyId !== launch.companyId || run.input.paperclipIssueId !== launch.data.parentIssueId ||
        run.input.projectId !== launch.data.projectId || state.status === 'completed' ||
        state.attempts.length !== launch.data.parentAttemptLength) return false;
    const config = await getConfig(host.db, launch.companyId);
    const policy = await control.getShadowPolicy();
    if (!policy.enabled || !policy.allowedAdapterTypes?.includes(launch.data.adapterType) ||
        !Object.values(config?.roleBindings ?? {}).includes(launch.agentId)) return false;
    const actor = launch.data.actor;
    if (actor.kind === 'system' && (run.status !== 'running' || !policy.allowSameAgent || !policy.allowGraphTrigger ||
        config?.roleBindings?.[`${run.packId}:${node.role}`] !== launch.agentId)) return false;
    if (actor.kind === 'agent' && (!policy.allowAgentTrigger || !policy.allowSameAgent)) return false;
    try { return shadowReviewPacket(run, node.id).snapshotId === launch.data.packet.snapshotId; }
    catch { return false; }
  }

  async function issueStartAllowed(launch) {
    const { engine, control } = await engineFor(launch.companyId);
    const shadow = (await control.getShadows()).find(item => item.id === launch.shadowId);
    return !expired(launch) && !launch.data.stopRequested && !shadow?.stopRequestedAt && shadow?.status === 'reserved' &&
      await issueParentCurrent(launch, engine, control);
  }

  async function wakeIssue(launch, owner, { assign = false } = {}) {
    const { companyId, requestKey, agentId, sessionId: issueId } = launch;
    let issue = await readIssue(launch);
    if (!await issueStartAllowed(launch)) {
      // On an interrupted first assignment, a backlog issue may still have an
      // outstanding Host update. Leave it fenced until assignment is observable.
      if (!assign && issue.status === 'backlog' && !issue.assigneeAgentId) return launch;
      return finish(launch, owner, expired(launch) ? 'timeout' : 'cancelled');
    }
    const unassigned = issue.status === 'backlog' && !issue.assigneeAgentId;
    if (assign && !unassigned) throw new Error('Pinned native Shadow issue is no longer unassigned');
    // A recovery repeats an interrupted first assignment. The same assignee and
    // status make a duplicate Host update harmless.
    if (unassigned) {
      issue = assertIssueScope(launch, await host.issues.update(issueId, { assigneeAgentId: agentId, status: 'todo' }, companyId));
    }
    if (issue.id !== issueId || issue.assigneeAgentId !== agentId || !WAKEABLE_ISSUE_STATES.has(issue.status)) return launch;
    if (!await issueStartAllowed(launch)) return finish(launch, owner, expired(launch) ? 'timeout' : 'cancelled');
    const { found, ambiguous } = await findExecution(launch);
    if (ambiguous) return finish(launch, owner, 'failed');
    let executionId = found?.id;
    if (!executionId) {
      const reviewer = await host.agents.get(agentId, companyId);
      const { control } = await engineFor(companyId);
      if (!reviewer || reviewer.companyId !== companyId || reviewer.adapterType !== launch.data.adapterType ||
          !shadowAgentEligible(reviewer, await control.getShadowPolicy()) ||
          !(await nativeShadowHeadroom(host.db, companyId, reviewer))) return launch;
      if (expired(launch)) return finish(launch, owner, 'timeout');
      executionId = (await host.issues.requestWakeup(issueId, companyId, {
        reason: REASON, contextSource: 'polyforge.shadow-review', idempotencyKey: `shadow-wake:${launch.data.taskKey}`,
      })).runId;
    }
    if (!executionId) return launch;
    return launches.transition({ companyId, requestKey, from: 'starting', to: 'active', executionId, leaseOwner: owner });
  }

  async function finish(launch, owner, outcome, reviewResult = null) {
    if (launch.status === 'closed') return launch;
    const issueBacked = Boolean(launch.sessionId && issueBackedShadow(launch));
    const { issue, owned } = issueBacked ? await readOwnedIssue(launch) : { issue: null, owned: false };
    if (launch.status !== 'closing' && outcome === 'completed' && issueBacked &&
        !(owned && issue.status === 'done' && issue.assigneeAgentId === launch.agentId)) {
      // Wait for the Host to show the owned issue as done. A deadline or a
      // changed issue ends the wait and fails closed.
      if (owned && !expired(launch)) return launch;
      outcome = 'failed'; reviewResult = null;
    }
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
    if (issueBacked) {
      // An unowned issue now belongs to someone else, so it is left in place.
      if (owned && !['done', 'cancelled'].includes(issue.status)) {
        const cancelled = assertIssueScope(launch, await host.issues.update(issue.id, { status: 'cancelled' }, launch.companyId));
        if (cancelled.id !== issue.id || cancelled.status !== 'cancelled') throw new Error('Native Shadow review issue retirement was not confirmed');
      }
    } else if (launch.sessionId) {
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
    let afterStop = launch.data?.stopRequested === true;
    if (!afterStop && issueBackedShadow(launch) && row.status === 'succeeded' && !afterDeadline) {
      const { engine, control } = await engineFor(launch.companyId);
      afterStop = !await issueParentCurrent(launch, engine, control);
    }
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

  async function drive(launch, owner, { terminalOnly = false } = {}) {
    const { companyId, requestKey, agentId } = launch;
    const data = launch.data ?? {};
    if (launch.status === 'closed') return launch;
    if (launch.status === 'closing') return finish(launch, owner, launch.outcome ?? 'failed');

    // A stop before send is final: there is no native run to wait for or wake.
    if (data.stopRequested === true &&
        ['claimed', 'session-created', 'reserved'].includes(launch.status)) {
      return finish(launch, owner, 'cancelled');
    }

    if (issueBackedShadow(launch) && (launch.status === 'creating' ||
        launch.status === 'needs-repair' && data.repairReason === 'session_create_outcome_unknown')) {
      const issue = await recoverIssue(launch);
      if (issue) launch = await launches.transition({ companyId, requestKey, from: launch.status,
        to: 'session-created', sessionId: issue.id, leaseOwner: owner });
      else if (launch.status === 'needs-repair') return launch;
    }
    if (launch.status === 'session-created' && launch.data?.stopRequested) return finish(launch, owner, 'cancelled');
    if (launch.status === 'creating') {
      // The SDK create call may have completed before a worker crash. Its list API
      // omits taskKey, so recreating here could fork the session.
      if (expired(launch)) return launches.transition({ companyId, requestKey,
        from: 'creating', to: 'needs-repair', data: { stopRequested: true,
          repairReason: 'session_create_outcome_unknown' }, leaseOwner: owner });
      return launch;
    }
    if (['starting', 'needs-repair'].includes(launch.status) && !launch.executionId && data.taskKey) {
      const { found, ambiguous } = await findExecution(launch);
      if (ambiguous) return finish(launch, owner, 'failed');
      if (found && launch.shadowId) {
        launch = await launches.transition({ companyId, requestKey, from: launch.status,
          to: 'active', executionId: found.id, leaseOwner: owner });
      } else if (issueBackedShadow(launch) && launch.status === 'starting') {
        launch = await wakeIssue(launch, owner);
        if (launch.status === 'starting' && expired(launch)) {
          return launches.transition({ companyId, requestKey, from: 'starting', to: 'needs-repair',
            data: { stopRequested: true, repairReason: 'issue_assignment_outcome_unknown' }, leaseOwner: owner });
        }
      } else if (issueBackedShadow(launch) && data.repairReason === 'issue_assignment_outcome_unknown') {
        // The deadline has passed without an observable execution. Retire the
        // pinned issue whether or not the interrupted assignment landed.
        return finish(launch, owner, 'timeout');
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
      const sessionId = issueBackedShadow(launch)
        ? assertIssueScope(launch, await host.issues.create(issueRequest(launch))).id
        : (await host.agents.sessions.create(agentId, companyId, { taskKey: data.taskKey, reason: REASON })).sessionId;
      launch = await launches.transition({ companyId, requestKey, from: 'creating',
        to: 'session-created', sessionId, leaseOwner: owner });
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
          (launch.data?.adapterType && reviewer.adapterType !== launch.data.adapterType) ||
          !shadowAgentEligible(reviewer, policy) ||
          !(await nativeShadowHeadroom(host.db, companyId, reviewer))) return launch;
      if (issueBackedShadow(launch) && !await issueStartAllowed(launch)) return finish(launch, owner, 'cancelled');
      launch = await launches.transition({ companyId, requestKey, from: 'reserved',
        to: 'starting', leaseOwner: owner });
      if (issueBackedShadow(launch)) {
        launch = await wakeIssue(launch, owner, { assign: true });
      } else {
        const sent = await host.agents.sessions.sendMessage(launch.sessionId, companyId, {
          prompt: nativeReviewPrompt(launch.data.packet, launch.data.candidateMaterial, launch.data.adapterType),
          reason: REASON });
        launch = await launches.transition({ companyId, requestKey, from: 'starting',
          to: 'active', executionId: sent.runId, leaseOwner: owner });
      }
    }
    if (launch.status === 'active') {
      if (!launch.executionId) return launches.transition({ companyId, requestKey,
        from: 'active', to: 'needs-repair',
        data: { repairReason: 'native_execution_id_missing' }, leaseOwner: owner });
      const { control } = await engineFor(companyId);
      const row = await readNativeShadowRun(host.db, { ...nativeScope(launch),
        executionId: launch.executionId,
        taskKey: data.taskKey ?? shadowTaskKey(host.manifest.id, requestKey) });
      if (!row) return launch; // Missing or mismatched native scope is never completion.
      if (terminalOnly && !nativeTerminal(row.status)) return launch;
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

  const retryTerminalReconciliation = (launch) => lease(launch, (held, owner) => {
    if (!issueBackedShadow(held) || !held.executionId || held.executionId !== launch.executionId ||
        !['active', 'closing'].includes(held.status)) return held;
    return drive(held, owner, { terminalOnly: true });
  });

  return { start: (launch) => lease(launch, drive), reconcile, requestStop, retryTerminalReconciliation };
}
