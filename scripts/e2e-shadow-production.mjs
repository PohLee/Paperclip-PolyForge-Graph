import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, pluginId, root, waitFor } from './enhancement-client.mjs';
import { fixtureContractInputs } from './fixture-contract-inputs.mjs';
import { nativeTerminal } from '../src/plugin/shadow-native.mjs';

// Local Docker acceptance only. Every Agent in this case uses the deterministic
// process adapter; no model adapter or external paid service is invoked.
const checkpointPath = resolve(root, '.e2e/shadow-production-checkpoint.json');
const enhancementPath = resolve(root, '.e2e/enhancement-checkpoint.json');
const pluginPath = `/api/plugins/${pluginId}`;
const companyPath = `${pluginPath}/api/company`;
const digest = /^sha256:[a-f0-9]{64}$/;

async function load(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(value) { await writeFile(checkpointPath, JSON.stringify(value, null, 2)); }

function assertReviewed(shadow, run, candidates) {
  assert.equal(shadow.status, 'closed');
  assert.equal(shadow.outcome, 'completed');
  assert.equal(shadow.reviewResult?.status, 'reviewed');
  assert.equal(shadow.reviewResult.schemaVersion, 1);
  assert.equal(shadow.reviewResult.verdict, 'accept');
  assert.match(shadow.reviewResult.outputDigest, digest);
  assert.deepEqual(shadow.goalContext, run.goalContext);
  assert.ok(shadow.contextRef?.snapshotId);
  assert.ok(shadow.reviewResult.candidateRefs.length > 0);
  for (const ref of shadow.reviewResult.candidateRefs) {
    assert.match(ref.digest, digest);
    assert.ok(candidates.some(item => item.id === ref.id && item.version === ref.version &&
      item.digest === ref.digest), `Shadow candidate ${ref.id} must be pinned to the run`);
  }
  for (const finding of shadow.reviewResult.findings) {
    assert.ok(['P0', 'P1', 'P2', 'P3'].includes(finding.severity));
    assert.ok(shadow.reviewResult.candidateRefs.some(ref => ref.id === finding.sourceRef.id &&
      ref.version === finding.sourceRef.version && ref.digest === finding.sourceRef.digest));
  }
}

function harness({ state, data }) {
  const { companyId, projectId, issueId } = state.development;
  const read = () => data('GET', `${companyPath}?companyId=${companyId}`);
  const command = (operation, fields, key, reason = `Deterministic local Shadow acceptance: ${operation}`) =>
    data('POST', companyPath, { companyId, operation, ...fields, reason, idempotencyKey: key });
  const graphPath = `${pluginPath}/api/issues/${issueId}/graph`;
  const graphCommand = (operation, fields, key) => data('POST', graphPath, {
    operation, ...fields, reason: `Deterministic production Shadow Graph: ${operation}`,
    idempotencyKey: key,
  });
  const qaId = state.adlcProvision?.roleBindings?.['adlc:qa-engineer'];
  assert.ok(qaId, 'Pinned QA process Agent binding required');
  return { companyId, projectId, issueId, qaId, read, command, graphPath, graphCommand, data };
}

async function enableProductionPolicy(ctx) {
  const policy = { enabled: true, allowSameAgent: true, allowAgentTrigger: true,
    allowGraphTrigger: true, maxDurationSeconds: 300, allowedAdapterTypes: ['process'] };
  await ctx.command('configure-shadow-policy', { policy },
    `shadow-production:policy:${ctx.companyId}`);
  const before = await ctx.read();
  assert.ok(before.catalog.some(pack => pack.id === 'adlc' && pack.version === '0.2.1'),
    'ADLC 0.2.1 must be installed in the Docker plugin');
  await ctx.command('enable-pack', { packId: 'adlc', version: '0.2.1' },
    `shadow-production:enable-adlc-0.2.1:${ctx.companyId}`);
  const after = await ctx.read();
  assert.deepEqual(after.control.shadowPolicy, policy);
  assert.ok(after.enabledPacks.some(pack => pack.packId === 'adlc' && pack.version === '0.2.1'));
  const qa = await ctx.data('GET', `/api/agents/${ctx.qaId}`);
  assert.equal(qa.companyId, ctx.companyId);
  assert.equal(qa.adapterType, 'process');
  assert.equal(qa.adapterConfig?.command, 'node');
  assert.deepEqual(qa.adapterConfig?.args, ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs']);
  assert.ok(qa.adapterConfig?.timeoutSec > 0 && qa.adapterConfig.timeoutSec <= 300);
  assert.ok(qa.budgetMonthlyCents > qa.spentMonthlyCents);
  return policy;
}

async function startVerification(ctx) {
  const nonce = Date.now().toString(36);
  const requirementId = `REQ-SHADOW-PROD-${nonce}`;
  const baseline = await ctx.graphCommand('product-decision', {
    feature: `shadow-production-${nonce}`, status: 'approved',
    outcome: 'Verify the pinned deterministic candidate',
    evidence: [{ kind: 'synthetic_requirement', id: requirementId }],
  }, `shadow-production:${nonce}:decision`);
  const started = await ctx.graphCommand('start', {
    packId: 'adlc', graphId: 'verification', mode: 'assisted',
    input: { ...fixtureContractInputs('verification', requirementId),
      fixtureScenario: 'shadow-same-agent', feature: `shadow-production-${nonce}`,
      projectId: ctx.projectId, versioned_requirement: { id: requirementId, version: 'v1' },
      product_decision_refs: [baseline.result.id], productDecisionRefs: [baseline.result.id],
      implementation_candidate: { id: `synthetic-candidate-${nonce}`, version: 'v1' } },
  }, `shadow-production:${nonce}:start`);
  assert.equal(started.run.packVersion, '0.2.1');
  const runId = started.run.id;
  await save({ companyId: ctx.companyId, graph: { runId,
    graphVersion: started.run.graph.version, goalContext: started.run.goalContext },
    phase: 'graph-running' });
  return waitVerification(ctx, runId);
}

async function waitVerification(ctx, runId) {
  const atGate = await waitFor(async () => {
    const current = await ctx.data('GET', `${ctx.graphPath}?runId=${runId}`);
    if (!['running', 'paused'].includes(current.run.status))
      throw new Error(`Verification ended before acceptance gate: ${current.run.status}`);
    return current.ready?.some(item => item.id === 'acceptance-gate') ? current : null;
  }, 'Graph Shadow, same-Agent QA Shadow and acceptance gate', 300_000);
  const candidates = Object.values(atGate.run.nodeStates).flatMap(node => node.artifacts ?? [])
    .filter(item => item.id && item.version && item.digest);
  assert.ok(candidates.length > 0);
  const shadows = (await ctx.read()).control.shadows.filter(item => item.parentRunId === runId &&
    item.parentTaskId === 'qa');
  const automatic = shadows.find(item => item.requestedBy?.kind === 'system' &&
    item.requestedBy.roles?.includes('shadow-orchestrator'));
  const agent = shadows.find(item => item.requestedBy?.kind === 'agent' &&
    item.requestedBy.id === ctx.qaId);
  assert.ok(automatic, 'Declarative Graph Shadow must run before QA');
  assert.ok(agent, 'QA must open a second same-Agent Shadow in its own execution');
  assertReviewed(automatic, atGate.run, candidates);
  assertReviewed(agent, atGate.run, candidates);
  assert.notEqual(automatic.sessionId, agent.sessionId);
  assert.notEqual(automatic.executionId, agent.executionId);
  assert.notEqual(agent.executionId, agent.requestedBy.executionId);
  const qaAttempt = atGate.run.nodeStates.qa.attempts?.[0];
  assert.ok(qaAttempt, 'QA must dispatch only after the automatic Shadow');
  const qaHeartbeat = await ctx.data('GET', `/api/heartbeat-runs/${agent.requestedBy.executionId}`);
  assert.equal(qaHeartbeat.agentId, ctx.qaId);
  assert.ok(Date.parse(automatic.closedAt) <= Date.parse(qaHeartbeat.startedAt),
    'Automatic Shadow must close before the native QA heartbeat starts');
  for (const shadow of [automatic, agent]) {
    const heartbeat = await ctx.data('GET', `/api/heartbeat-runs/${shadow.executionId}`);
    assert.equal(heartbeat.companyId, ctx.companyId);
    assert.equal(heartbeat.agentId, ctx.qaId);
    assert.equal(heartbeat.status, 'succeeded');
  }
  const graph = { runId, graphVersion: atGate.run.graph.version, goalContext: atGate.run.goalContext,
    automaticShadowId: automatic.id, agentShadowId: agent.id,
    automaticExecutionId: automatic.executionId, agentExecutionId: agent.executionId };
  await save({ companyId: ctx.companyId, graph, phase: 'graph-verified' });
  return graph;
}

async function verifyOwnerReplay(ctx, graph) {
  const key = `shadow-production:manual:${graph.runId}`;
  const fields = { parentRunId: graph.runId, parentTaskId: 'acceptance-gate', agentId: ctx.qaId };
  const opened = await ctx.command('open-shadow', fields, key);
  assert.ok(opened.shadowId && opened.sessionId && opened.executionId);
  const closed = await waitFor(async () => (await ctx.read()).control.shadows.find(
    item => item.id === opened.shadowId && item.status === 'closed'),
  'owner Shadow completion', 180_000);
  const run = (await ctx.data('GET', `${ctx.graphPath}?runId=${graph.runId}`)).run;
  const candidates = Object.values(run.nodeStates).flatMap(node => node.artifacts ?? []);
  assertReviewed(closed, run, candidates);
  assert.notEqual(closed.sessionId, (await ctx.read()).control.shadows.find(
    item => item.id === graph.agentShadowId).sessionId);
  const replay = await ctx.command('open-shadow', fields, key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.shadowId, opened.shadowId);
  await assert.rejects(ctx.command('open-shadow', fields, key,
    'Changed reason must reject the old idempotency key'), /idempotency|different request/i);
  return { shadowId: closed.id, executionId: closed.executionId, sessionId: closed.sessionId,
    snapshotId: closed.contextRef.snapshotId, outcome: closed.outcome };
}

async function triggerReconcile(ctx) {
  const jobs = await ctx.data('GET', `${pluginPath}/jobs`);
  const job = jobs.find(item => item.jobKey === 'shadow-reconcile');
  assert.ok(job?.id, 'Registered shadow-reconcile job required');
  const started = await ctx.data('POST', `${pluginPath}/jobs/${job.id}/trigger`, {});
  await waitFor(async () => {
    const run = (await ctx.data('GET', `${pluginPath}/jobs/${job.id}/runs`))
      .find(item => item.id === started.runId);
    if (run?.status === 'failed') throw new Error(run.error ?? 'Shadow reconcile job failed');
    return run?.status === 'succeeded';
  }, 'shadow-reconcile job', 180_000);
  return started.runId;
}

async function delayedShadow(ctx, graph, mode) {
  const qa = await ctx.data('GET', `/api/agents/${ctx.qaId}`);
  assert.equal(qa.adapterType, 'process');
  assert.equal(qa.adapterConfig?.env?.POLYFORGE_SHADOW_DELAY_MS, undefined,
    'Fixture delay must be initially absent so it can be restored safely');
  const delayMs = mode === 'restart' ? 60_000 : 20_000;
  await ctx.data('PATCH', `/api/agents/${ctx.qaId}`, { adapterConfig: {
    ...qa.adapterConfig, env: { ...qa.adapterConfig.env,
      POLYFORGE_SHADOW_DELAY_MS: String(delayMs) } } });
  const known = new Set((await ctx.read()).control.shadows.map(item => item.id));
  const key = `shadow-production:${mode}:${graph.runId}:${Date.now()}`;
  const startedAt = new Date().toISOString();
  // The request may remain pending while the native process runs. Keep its
  // rejection handled while a separate reader observes the durable reservation.
  let openingResult;
  const opening = ctx.command('open-shadow', {
    parentRunId: graph.runId, parentTaskId: 'acceptance-gate', agentId: ctx.qaId,
  }, key).then(value => (openingResult = { value }), error => (openingResult = { error: String(error) }));
  let active;
  try { active = await waitFor(async () => {
    if (openingResult?.error) throw new Error(openingResult.error);
    const current = await ctx.read();
    const shadow = current.control.shadows.find(item => !known.has(item.id) &&
      item.parentRunId === graph.runId && item.parentTaskId === 'acceptance-gate' &&
      ['reserved', 'active'].includes(item.status));
    if (!shadow?.executionId) return null;
    const heartbeat = await ctx.data('GET', `/api/heartbeat-runs/${shadow.executionId}`);
    return heartbeat.status === 'running' ? shadow : null;
  }, 'delayed native Shadow heartbeat running', 60_000); }
  catch (error) { await restoreDelay(ctx); throw error; }
  return { shadowId: active.id, executionId: active.executionId, sessionId: active.sessionId,
    snapshotId: active.contextRef?.snapshotId,
    key, startedAt, delayMs, opening };
}

async function restoreDelay(ctx) {
  const qa = await ctx.data('GET', `/api/agents/${ctx.qaId}`);
  const env = { ...qa.adapterConfig?.env };
  delete env.POLYFORGE_SHADOW_DELAY_MS;
  await ctx.data('PATCH', `/api/agents/${ctx.qaId}`, { adapterConfig: { ...qa.adapterConfig, env } });
}

async function verifyRecovered(ctx, graph, delayed, { allowInterrupted = false } = {}) {
  const heartbeat = await waitFor(async () => {
    const heartbeat = await ctx.data('GET', `/api/heartbeat-runs/${delayed.executionId}`);
    if (!allowInterrupted && nativeTerminal(heartbeat.status) && heartbeat.status !== 'succeeded')
      throw new Error(`Delayed native Shadow ended ${heartbeat.status}`);
    return nativeTerminal(heartbeat.status) ? heartbeat : null;
  }, 'delayed native Shadow terminal result', 180_000);
  const jobRunId = await triggerReconcile(ctx);
  const closed = await waitFor(async () => (await ctx.read()).control.shadows.find(
    item => item.id === delayed.shadowId && item.status === 'closed'),
  'recovered Core Shadow closure', 180_000);
  const run = (await ctx.data('GET', `${ctx.graphPath}?runId=${graph.runId}`)).run;
  assert.equal(closed.executionId, delayed.executionId);
  assert.equal(closed.sessionId, delayed.sessionId);
  assert.equal(closed.contextRef.snapshotId, delayed.snapshotId);
  assert.deepEqual(closed.goalContext, graph.goalContext);
  assert.deepEqual(run.goalContext, graph.goalContext);
  if (heartbeat.status === 'succeeded') {
    const candidates = Object.values(run.nodeStates).flatMap(node => node.artifacts ?? []);
    assertReviewed(closed, run, candidates);
  } else {
    assert.ok(allowInterrupted, 'Only a full container restart may interrupt the native Shadow');
    const expected = { failed: 'failed', interrupted: 'failed', cancelled: 'cancelled', timed_out: 'timeout' };
    assert.equal(closed.outcome, expected[heartbeat.status]);
    assert.equal(closed.reviewResult, undefined);
  }
  const replay = await ctx.command('open-shadow', {
    parentRunId: graph.runId, parentTaskId: 'acceptance-gate', agentId: ctx.qaId,
  }, delayed.key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.shadowId, delayed.shadowId);
  assert.equal(replay.executionId, delayed.executionId);
  const matching = (await ctx.read()).control.shadows.filter(item => item.id === delayed.shadowId);
  assert.equal(matching.length, 1, 'Recovery must retain the same Core Shadow identity');
  return { shadowId: closed.id, executionId: closed.executionId,
    outcome: closed.outcome, nativeStatus: heartbeat.status,
    interrupted: heartbeat.status !== 'succeeded', jobRunId };
}

async function pluginWorkerRecovery(ctx, graph) {
  const delayed = await delayedShadow(ctx, graph, 'worker');
  try {
    await ctx.data('POST', `${pluginPath}/disable`, {});
    // The pinned host occasionally times out its 15-second worker handshake on
    // a Windows-mounted build. Retry only that explicit host initialization error.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await ctx.data('POST', `${pluginPath}/enable`, {}); break; }
      catch (error) {
        if (attempt === 3 || !/initialize.*timed out|timed out.*initialize/i.test(String(error))) throw error;
        console.log(JSON.stringify({ workerEnableRetry: attempt, reason: 'host_initialize_timeout' }));
      }
    }
    await waitFor(async () => (await ctx.data('GET', pluginPath)).status === 'ready',
      'plugin worker re-enabled', 180_000);
    return await verifyRecovered(ctx, graph, delayed);
  } finally {
    await delayed.opening;
    await restoreDelay(ctx);
  }
}

export async function runShadowProductionCase({ state, data, phase = 'all' }) {
  const ctx = harness({ state, data });
  if (phase === 'stop') {
    const saved = await load(checkpointPath);
    assert.equal(saved.companyId, ctx.companyId);
    const delayed = await delayedShadow(ctx, saved.graph, 'stop');
    try {
      await ctx.command('stop-shadow', { shadowId: delayed.shadowId }, `${delayed.key}:stop`);
      const first = (await ctx.read()).control.shadows.find(item => item.id === delayed.shadowId);
      assert.ok(first.stopRequestedAt);
      assert.equal(first.status, 'active', 'Stop intent must not pretend native work already stopped');
      await ctx.command('stop-shadow', { shadowId: delayed.shadowId }, `${delayed.key}:stop`);
      const repeated = (await ctx.read()).control.shadows.find(item => item.id === delayed.shadowId);
      assert.equal(repeated.stopRequestedAt, first.stopRequestedAt);
      await waitFor(async () => (await ctx.data('GET', `/api/heartbeat-runs/${delayed.executionId}`))
        .status === 'succeeded', 'stopped fixture native process finishes normally', 120_000);
      await triggerReconcile(ctx);
      const closed = (await ctx.read()).control.shadows.find(item => item.id === delayed.shadowId);
      assert.equal(closed.status, 'closed');
      assert.equal(closed.outcome, 'cancelled');
      assert.equal(closed.reviewResult, undefined);
      const proof = { shadowId: closed.id, executionId: closed.executionId,
        outcome: closed.outcome, nativeStatus: 'succeeded', stopRequestedAt: first.stopRequestedAt };
      await save({ ...saved, stop: proof });
      return { phase, ...proof };
    } finally { await delayed.opening; await restoreDelay(ctx); }
  }
  if (phase === 'restart-verify') {
    const saved = await load(checkpointPath);
    assert.equal(saved.companyId, ctx.companyId);
    assert.ok(saved.restart?.shadowId, 'Run restart-capture before restart-verify');
    try {
      const proof = await verifyRecovered(ctx, saved.graph, saved.restart,
        { allowInterrupted: true });
      await save({ ...saved, restart: { ...saved.restart, recovered: proof } });
      return { phase, ...proof };
    } finally {
      await restoreDelay(ctx);
    }
  }
  await enableProductionPolicy(ctx);
  let graph;
  if (phase === 'restart-capture') {
    const prior = await load(checkpointPath).catch(() => null);
    graph = prior?.companyId === ctx.companyId && prior.graph?.runId
      ? prior.graph.automaticShadowId ? prior.graph : await waitVerification(ctx, prior.graph.runId)
      : await startVerification(ctx);
    const delayed = await delayedShadow(ctx, graph, 'restart');
    await save({ ...prior, companyId: ctx.companyId, graph, restart: {
      shadowId: delayed.shadowId, executionId: delayed.executionId,
      sessionId: delayed.sessionId, snapshotId: delayed.snapshotId,
      key: delayed.key, startedAt: delayed.startedAt } });
    return { phase, shadowId: delayed.shadowId, executionId: delayed.executionId,
      instruction: 'Restart the Docker container now, then run --phase=restart-verify' };
  }
  assert.ok(['all', 'resume'].includes(phase), `Unsupported Shadow acceptance phase: ${phase}`);
  const prior = phase === 'resume' ? await load(checkpointPath) : null;
  if (prior) {
    assert.equal(prior.companyId, ctx.companyId);
    assert.ok(prior.graph?.runId, 'No saved Graph run to resume');
  }
  graph = prior?.graph?.automaticShadowId ? prior.graph :
    prior?.graph?.runId ? await waitVerification(ctx, prior.graph.runId) :
      await startVerification(ctx);
  const manual = prior?.manual ?? await verifyOwnerReplay(ctx, graph);
  await save({ companyId: ctx.companyId, graph, manual });
  const recovery = prior?.recovery ?? await pluginWorkerRecovery(ctx, graph);
  await save({ companyId: ctx.companyId, graph, manual, recovery });
  return { phase, companyId: ctx.companyId, graph, manual, recovery };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice('--phase='.length) ?? 'all';
  const state = await load(enhancementPath);
  const { data } = await client();
  console.log(JSON.stringify(await runShadowProductionCase({ state, data, phase }), null, 2));
  if (phase === 'restart-capture') process.exit(0);
}
