import { createHash } from 'node:crypto';
import { shadowReviewPacket } from './shadow-context.mjs';
import { createShadowLaunchStore, shadowRequestFingerprint } from './shadow-launch-store.mjs';
import { getDispatchForIssue } from './store.mjs';

const FIXTURE_SCRIPT = '/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs';
const MAX_DURATION_MS = 15 * 60 * 1000;
const reason = 'Bounded local deterministic process Shadow review';
const systemActor = (host) => ({ id: host.manifest.id, kind: 'system', roles: ['shadow-reconciler'] });
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function fixtureShadowAgent(agent) {
  const config = agent?.adapterConfig;
  return agent?.adapterType === 'process' && config?.command === 'node' &&
    Array.isArray(config.args) && config.args.length === 1 && config.args[0] === FIXTURE_SCRIPT &&
    Number.isInteger(config.timeoutSec) && config.timeoutSec > 0 && config.timeoutSec <= 900 &&
    agent.status === 'idle' && Number.isFinite(agent.budgetMonthlyCents) &&
    Number.isFinite(agent.spentMonthlyCents) && agent.budgetMonthlyCents > agent.spentMonthlyCents;
}

export async function fixtureShadowAvailable(host, companyId, agentIds) {
  for (const id of agentIds) {
    let agent;
    try { agent = await host.agents.get(id, companyId); }
    catch { return false; } // No authorized native scope means capability is unavailable.
    if (agent?.companyId === companyId && fixtureShadowAgent(agent)) return true;
  }
  return false;
}

// Host bindings are Pack-qualified; Core evaluates roles inside the pinned Pack.
// Add only this run's node role, never a same-named role from another Pack.
export function shadowActorForRun(actor, run, node) {
  if (actor.kind !== 'agent') return actor;
  if (!actor.executionId || !actor.roles?.includes(`${run.packId}:${node.role}`)) {
    throw new Error('Owning Graph Agent run required');
  }
  return { ...actor, roles: [...new Set([...actor.roles, node.role])] };
}

/** Local process fixture only. The host process timeout bounds a run even if session.close cannot cancel it. */
export function createFixtureShadow({ host, engineFor }) {
  const launches = createShadowLaunchStore(host.db);

  async function close({ companyId, requestKey, outcome, reviewResult }) {
    const launch = await launches.get(companyId, requestKey);
    if (!launch || launch.status === 'closed') return launch;
    if (launch.shadowId) {
      const { control } = await engineFor(companyId);
      await control.closeShadow({ shadowId: launch.shadowId, outcome,
        ...(reviewResult ? { reviewResult } : {}),
        actor: systemActor(host), reason, idempotencyKey: `shadow-close:${requestKey}` });
    }
    if (launch.sessionId) await host.agents.sessions.close(launch.sessionId, companyId);
    return launches.transition({ companyId, requestKey, from: launch.status, to: 'closed', outcome });
  }

  async function open({ companyId, actor, payload, common, available }) {
    const requestKey = `${companyId}:${common.idempotencyKey}`;
    const fingerprint = shadowRequestFingerprint({ companyId, actor,
      parentRunId: payload.parentRunId, parentTaskId: payload.parentTaskId,
      parentIssueId: payload.parentIssueId ?? null, agentId: payload.agentId });
    const replay = await launches.get(companyId, requestKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new Error('Shadow idempotency key reused with different request');
      return { status: replay.status, shadowId: replay.shadowId,
        sessionId: replay.sessionId, executionId: replay.executionId, replayed: true };
    }
    if (!available) throw new Error('Bounded local process Shadow capability unavailable for this company');
    const { engine, control } = await engineFor(companyId);
    const run = await engine.getRun(payload.parentRunId);
    if (!run || !['running', 'paused'].includes(run.status) ||
        run.input?.paperclipCompanyId !== companyId || !run.input?.projectId ||
        !run.nodeStates?.[payload.parentTaskId] || run.nodeStates[payload.parentTaskId].status === 'completed') {
      throw new Error('Active parent Graph task in this company required');
    }
    const node = run.graph.nodes.find((item) => item.id === payload.parentTaskId);
    if (!node) throw new Error('Parent Graph node not found');
    const scopedActor = shadowActorForRun(actor, run, node);
    if (actor.kind === 'agent') {
      const dispatch = await getDispatchForIssue(host.db, companyId, payload.parentIssueId,
        run.id, node.id);
      if (!dispatch || dispatch.agent_id !== actor.id || dispatch.agent_run_id !== actor.executionId ||
          dispatch.phase !== 'work') throw new Error('Current parent dispatch does not match Agent run');
      await host.issues.assertCheckoutOwner({ issueId: payload.parentIssueId, companyId,
        actorAgentId: actor.id, actorRunId: actor.executionId });
    } else if (actor.kind !== 'human' || !actor.roles.includes('human-owner')) {
      throw new Error('Human owner or owning Graph Agent required');
    }
    const reviewer = await host.agents.get(payload.agentId, companyId);
    if (!fixtureShadowAgent(reviewer) || reviewer.id === actor.id) {
      throw new Error('Shadow requires a distinct idle local process fixture Agent with existing budget and timeout');
    }
    const packet = shadowReviewPacket(run, node.id);
    const deadlineAt = new Date(Date.now() + Math.min(MAX_DURATION_MS, reviewer.adapterConfig.timeoutSec * 1000)).toISOString();
    const claim = await launches.claim({ companyId, requestKey, fingerprint, agentId: reviewer.id,
      parentRunId: run.id, parentTaskId: node.id, deadlineAt });
    if (!claim.created) return { status: claim.status, shadowId: claim.shadowId,
      sessionId: claim.sessionId, executionId: claim.executionId, replayed: true };
    let current = claim;
    try {
      const context = await control.recordShadowContext({ parentRunId: run.id, parentTaskId: node.id,
        candidateRefs: packet.candidates.map(({ id, version, digest }) => ({ id, version, digest })),
        payloadDigest: sha256(JSON.stringify(packet)), actor: systemActor(host), reason,
        idempotencyKey: `shadow-context:${requestKey}` });
      const taskKey = `plugin:${host.manifest.id}:session:shadow:${createHash('sha256').update(requestKey).digest('hex')}`;
      const session = await host.agents.sessions.create(reviewer.id, companyId, { taskKey, reason });
      current = await launches.transition({ companyId, requestKey, from: 'claimed', to: 'session-created',
        sessionId: session.sessionId });
      const scope = { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt };
      const shadow = await control.prepareShadow({ parentRunId: run.id, parentTaskId: node.id,
        role: 'independent-review', sessionId: session.sessionId,
        contextRef: { sourceRunId: run.id, sourceNodeId: node.id, snapshotId: context.id,
          payloadDigest: sha256(JSON.stringify(packet)) }, scope, actor: scopedActor, reason,
        idempotencyKey: `shadow-prepare:${requestKey}` });
      current = await launches.transition({ companyId, requestKey, from: 'session-created', to: 'reserved',
        shadowId: shadow.id });
      const prompt = `Perform one independent review of this authenticated candidate snapshot.\n${JSON.stringify({
        kind: 'polyforge-shadow-review-v1', ...packet,
      })}`;
      let terminal = null, bound = false, stdout = '';
      const finish = async () => {
        if (!terminal || !bound) return;
        const output = stdout.trim() || terminal.message?.trim() || '';
        const lines = output.split('\n');
        let result = null;
        try { result = JSON.parse(lines.at(-1) ?? ''); } catch { /* uncertain output stays unknown */ }
        const valid = terminal.eventType === 'done' && result?.fixture === 'local-process-shadow-review' &&
          result.snapshotId === packet.snapshotId && result.sourceRunId === run.id && result.status === 'reviewed' &&
          Array.isArray(result.findings) && result.findings.length > 0 && result.findings.length <= 20 &&
          result.findings.every((finding) => ['P0', 'P1', 'P2', 'P3'].includes(finding.severity) &&
            typeof finding.summary === 'string' && finding.summary.length > 0 && finding.summary.length <= 1000 &&
            packet.candidates.some((candidate) => candidate.id === finding.sourceRef?.id &&
              candidate.version === finding.sourceRef?.version && candidate.digest === finding.sourceRef?.digest));
        await close({ companyId, requestKey, outcome: valid ? 'completed' : 'failed',
          ...(valid ? { reviewResult: { status: 'synthetic-fixture-reviewed',
            findings: result.findings, outputDigest: sha256(output) } } : {}) });
      };
      const sent = await host.agents.sessions.sendMessage(session.sessionId, companyId, {
        prompt, reason, onEvent: (event) => {
          if (event.sessionId !== session.sessionId) return;
          if (event.eventType === 'chunk' && event.stream === 'stdout' && stdout.length < 65536) stdout += event.message ?? '';
          if (['done', 'error'].includes(event.eventType)) {
            terminal = event;
            void finish().catch((error) => host.logger?.warn('Shadow terminal reconciliation failed', {
              companyId, shadowId: shadow.id, error: String(error),
            }));
          }
        },
      });
      current = await launches.transition({ companyId, requestKey, from: 'reserved', to: 'active',
        executionId: sent.runId });
      await control.bindShadowExecution({ shadowId: shadow.id, executionId: sent.runId,
        actor: systemActor(host), reason, idempotencyKey: `shadow-bind:${requestKey}` });
      bound = true;
      await finish();
      return { status: current.status, shadowId: shadow.id, sessionId: session.sessionId,
        executionId: sent.runId, deadlineAt };
    } catch (error) {
      try { await close({ companyId, requestKey, outcome: 'cancelled' }); }
      catch (cleanupError) {
        host.logger?.warn('Shadow launch requires operator repair', { companyId, requestKey,
          error: String(cleanupError) });
      }
      throw error;
    }
  }

  async function reconcile({ companyId }) {
    const now = Date.now();
    for (const launch of await launches.list(companyId)) {
      if (Date.parse(launch.deadlineAt) <= now) await close({ companyId,
        requestKey: launch.requestKey, outcome: 'timeout' });
    }
  }
  async function closeByShadowId({ companyId, shadowId }) {
    const launch = (await launches.list(companyId)).find((item) => item.shadowId === shadowId);
    if (!launch) throw new Error('Active company Shadow launch not found');
    return close({ companyId, requestKey: launch.requestKey, outcome: 'cancelled' });
  }
  return { open, close, closeByShadowId, reconcile };
}
