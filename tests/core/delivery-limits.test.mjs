import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, normalizeDeliveryLimits } from '../../src/core/index.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner', 'maker'] };
const artifact = (kind, id, version = 'v1') => ({ kind, id, version });
const graph = {
  id: 'slice', version: '1', start: 'plan',
  deliveryContract: { goalInput: 'goal', acceptanceInput: 'criteria' },
  nodes: [
    { id: 'plan', type: 'task', role: 'maker', produces: ['plan'], deliveryMilestone: true },
    { id: 'work', type: 'task', role: 'maker', produces: ['candidate'] },
    { id: 'end', type: 'end' },
  ],
  edges: [{ from: 'plan', to: 'work' }, { from: 'work', to: 'end' }],
};
const pack = { id: 'delivery', version: '1', graphs: [graph], decisionRules: [] };
const input = { deliveryId: 'goal-1', goal: 'Ship one slice', criteria: ['AC-1'] };

test('company limits are bounded and pinned to the delivery on its first run', async () => {
  assert.throws(() => normalizeDeliveryLimits({ sliceMs: 0 }), /Invalid delivery limit/);
  assert.throws(() => normalizeDeliveryLimits({ sliceMs: 241 * 60_000 }), /Invalid delivery limit/);
  assert.throws(() => normalizeDeliveryLimits({ idleMs: 60 * 60_000, sliceMs: 30 * 60_000 }), /Idle limit/);
  assert.throws(() => normalizeDeliveryLimits({ unexpected: 1 }), /Invalid delivery limit/);
  let ms = Date.parse('2026-01-01T00:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(ms).toISOString() });
  await engine.registerPack(pack);
  const args = { packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner, input };
  const first = await engine.startRun({ ...args, deliveryLimits: { sliceMs: 5 * 60_000,
    idleMs: 4 * 60_000, parallelAgents: 2 } });
  const second = await engine.startRun({ ...args, deliveryLimits: { sliceMs: 120 * 60_000,
    idleMs: 30 * 60_000, parallelAgents: 5 } });
  assert.equal((await engine.getDeliveryStatus(second.id)).limits.sliceMs, 5 * 60_000);
  assert.equal((await engine.getDeliveryStatus(second.id)).limits.parallelAgents, 2);
  ms += 4 * 60_000;
  assert.equal((await engine.getRun(first.id)).status, 'stopped');
});

test('delivery contract and accepted milestones bound active slice and idle time', async () => {
  let ms = Date.parse('2026-01-01T00:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(ms).toISOString() });
  await engine.registerPack(pack);
  await assert.rejects(engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner,
    input: { goal: 'Ship' } }), /Delivery contract input missing/);
  const run = await engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner, input });
  ms += 20 * 60_000;
  await engine.submitNode({ runId: run.id, nodeId: 'plan', actor: owner, artifacts: [artifact('plan', 'p1')] });
  const status = await engine.getDeliveryStatus(run.id);
  assert.deepEqual(status.acceptedMilestones[0].artifacts, [{ kind: 'plan', id: 'p1', version: 'v1' }]);
  assert.deepEqual(status.acceptanceCriteria, ['AC-1']);
  assert.equal(status.activeMinutes, 20);
  ms += 25 * 60_000;
  assert.equal((await engine.getRun(run.id)).status, 'running');
  ms += 5 * 60_000;
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  assert.deepEqual(await engine.getReadyNodes(run.id), []);
  assert.equal((await engine.listDecisions({ runId: run.id })).at(-1).reason, 'idle_progress_limit');
});

test('paused human wait excludes active time, and slice cap still stops resumed work', async () => {
  let ms = Date.parse('2026-01-01T00:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(ms).toISOString() });
  await engine.registerPack(pack);
  const run = await engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner, input });
  ms += 25 * 60_000;
  await engine.pauseRun({ runId: run.id, actor: owner, reason: 'Human decision' });
  ms += 4 * 60 * 60_000;
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  await engine.resumeRun({ runId: run.id, actor: owner, reason: 'Decision made' });
  ms += 5 * 60_000;
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
});

test('120 active minutes stops a slice even when milestones keep idle below 30', async () => {
  let ms = Date.parse('2026-01-01T00:00:00Z');
  const nodes = Array.from({ length: 6 }, (_, n) => ({ id: `stage-${n}`, type: 'task', produces: ['stage'], deliveryMilestone: true }));
  const graphWithMilestones = { id: 'long-slice', version: '1', start: nodes[0].id, nodes,
    edges: nodes.slice(1).map((node, n) => ({ from: nodes[n].id, to: node.id })) };
  const engine = new GraphEngine({ now: () => new Date(ms).toISOString() });
  await engine.registerPack({ id: 'delivery', version: '2', graphs: [graphWithMilestones], decisionRules: [] });
  const run = await engine.startRun({ packId: 'delivery', packVersion: '2', graphId: 'long-slice', actor: owner });
  for (let n = 0; n < 4; n++) {
    ms += 25 * 60_000;
    await engine.submitNode({ runId: run.id, nodeId: nodes[n].id, actor: owner,
      artifacts: [artifact('stage', `stage-${n}`)] });
  }
  ms += 20 * 60_000;
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  assert.equal((await engine.listDecisions({ runId: run.id })).at(-1).reason, 'slice_time_limit');
});

test('checks, corrections and resources share a delivery ledger across runs', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack);
  const start = (parentRunId) => engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner,
    input: { ...input, ...(parentRunId ? { parentRunId } : {}) } });
  const first = await start();
  const second = await start(first.id);
  await assert.rejects(engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner,
    input: { ...input, criteria: ['AC-2'] } }), /acceptance criteria changed/);
  await assert.rejects(engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner,
    input: { ...input, parentRunId: first.id, deliveryId: 'new-goal' } }), /keep parent deliveryId/);
  for (let n = 0; n < 3; n++) {
    const result = await engine.recordDeliveryEvent({ runId: n % 2 ? second.id : first.id, actor: owner,
      event: { kind: 'fix_reverify', rootCauseId: 'cause-1' }, idempotencyKey: `fix-${n}` });
    assert.equal(result.count, n + 1);
  }
  const exhausted = await engine.recordDeliveryEvent({ runId: second.id, actor: owner,
    event: { kind: 'fix_reverify', rootCauseId: 'cause-1' } });
  assert.equal(exhausted.limit, 'fix_round_limit');
  assert.equal((await engine.getRun(first.id)).status, 'stopped');
  assert.equal((await engine.getRun(second.id)).status, 'stopped');
  await assert.rejects(start(), /Delivery limit reached/);

  const fresh = await engine.startRun({ packId: 'delivery', packVersion: '1', graphId: 'slice', actor: owner,
    input: { ...input, deliveryId: 'goal-2' } });
  for (let n = 0; n < 2; n++) assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'acquire', resourceKind: 'testDatabase', resourceId: `db-${n}` } })).allowed, true);
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'acquire', resourceKind: 'testDatabase', resourceId: 'db-3' } })).allowed, false);
  await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'release', resourceKind: 'testDatabase', resourceId: 'db-1' } });
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'acquire', resourceKind: 'testDatabase', resourceId: 'db-3' } })).allowed, true);
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'acquire', resourceKind: 'sourceSnapshot', resourceId: 'snapshot-1' } })).allowed, true);
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'resource', action: 'acquire', resourceKind: 'sourceSnapshot', resourceId: 'snapshot-2' } })).allowed, false);
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'implementation_correction', agentId: 'implementer-1' } })).allowed, true);
  assert.equal((await engine.recordDeliveryEvent({ runId: fresh.id, actor: owner,
    event: { kind: 'implementation_correction', agentId: 'implementer-1' } })).limit, 'implementation_correction_limit');
});

test('declared full regression counts accepted reports across runs and stops fourth', async () => {
  const verification = { id: 'verify', version: '1', start: 'freeze', nodes: [
    { id: 'freeze', type: 'task', produces: ['candidate'] },
    { id: 'regression', type: 'task', produces: ['regression_report'],
      deliveryCheck: { kind: 'full_regression', receiptKind: 'regression_report', sourceNodeId: 'freeze', sourceKind: 'candidate' } },
    { id: 'acceptance', type: 'task', produces: ['acceptance'], deliveryMilestone: true },
    { id: 'end', type: 'end' },
  ], edges: [{ from: 'freeze', to: 'regression' }, { from: 'regression', to: 'acceptance' }, { from: 'acceptance', to: 'end' }] };
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'delivery', version: '2', graphs: [verification], decisionRules: [] });
  for (let n = 0; n < 3; n++) {
    const run = await engine.startRun({ packId: 'delivery', packVersion: '2', graphId: 'verify', actor: owner,
      input: { deliveryId: 'shared' } });
    await engine.submitNode({ runId: run.id, nodeId: 'freeze', actor: owner, artifacts: [artifact('candidate', `c${n}`)] });
    await engine.submitNode({ runId: run.id, nodeId: 'regression', actor: owner,
      artifacts: [artifact('regression_report', `report-${n}`)] });
    await engine.submitNode({ runId: run.id, nodeId: 'acceptance', actor: owner,
      artifacts: [artifact('acceptance', `matrix-${n}`)] });
    await engine.submitNode({ runId: run.id, nodeId: 'end', actor: owner });
    assert.equal((await engine.getRun(run.id)).status, 'completed');
  }
  await assert.rejects(engine.startRun({ packId: 'delivery', packVersion: '2', graphId: 'verify', actor: owner,
    input: { deliveryId: 'shared' } }), /Full regression limit reached/);
  assert.equal((await engine.getAudit()).filter((item) => item.kind === 'delivery.event' && item.event.kind === 'full_regression').length, 3);
});

test('the same frozen candidate cannot trigger another full regression', async () => {
  const engine = new GraphEngine();
  const verify = { id: 'verify-once', version: '1', start: 'freeze', nodes: [
    { id: 'freeze', type: 'task', produces: ['candidate'] },
    { id: 'regression', type: 'task', produces: ['report'],
      deliveryCheck: { kind: 'full_regression', receiptKind: 'report', sourceNodeId: 'freeze', sourceKind: 'candidate' } },
    { id: 'end', type: 'end' },
  ], edges: [{ from: 'freeze', to: 'regression' }, { from: 'regression', to: 'end' }] };
  await engine.registerPack({ id: 'delivery', version: '6', graphs: [verify], decisionRules: [] });
  const start = () => engine.startRun({ packId: 'delivery', packVersion: '6', graphId: 'verify-once', actor: owner,
    input: { deliveryId: 'duplicate-candidate' } });
  const first = await start();
  await engine.submitNode({ runId: first.id, nodeId: 'freeze', actor: owner, artifacts: [artifact('candidate', 'same')] });
  await engine.submitNode({ runId: first.id, nodeId: 'regression', actor: owner, artifacts: [artifact('report', 'r1')] });
  const second = await start();
  await engine.submitNode({ runId: second.id, nodeId: 'freeze', actor: owner, artifacts: [artifact('candidate', 'same')] });
  assert.equal((await engine.getRun(second.id)).status, 'stopped');
  assert.equal((await engine.getDeliveryStatus(second.id)).fullRegressions, 1);
});

test('versioned verification plan remains fixed for one delivery', async () => {
  const engine = new GraphEngine();
  const verification = { ...graph, id: 'planned', deliveryContract: {
    goalInput: 'goal', acceptanceInput: 'criteria', verificationPlanInput: 'verificationPlan',
  } };
  await engine.registerPack({ id: 'delivery', version: '3', graphs: [verification], decisionRules: [] });
  const start = (version) => engine.startRun({ packId: 'delivery', packVersion: '3', graphId: 'planned', actor: owner,
    input: { ...input, verificationPlan: { id: 'plan', version } } });
  await assert.rejects(start(undefined), /Versioned verification plan/);
  await start('v1');
  await start('v1');
  await assert.rejects(start('v2'), /Verification plan changed/);
});

test('short runs without deliverables cannot restart forever under one delivery ID', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'delivery', version: '4', graphs: [{ id: 'short', version: '1', start: 'end',
    nodes: [{ id: 'end', type: 'end' }], edges: [] }], decisionRules: [] });
  const start = () => engine.startRun({ packId: 'delivery', packVersion: '4', graphId: 'short', actor: owner,
    input: { deliveryId: 'short-goal' } });
  for (let n = 0; n < 3; n++) {
    const run = await start();
    await engine.submitNode({ runId: run.id, nodeId: 'end', actor: owner });
    assert.equal((await engine.getDeliveryStatus(run.id)).noProgressRuns, n + 1);
  }
  await assert.rejects(start(), /Delivery limit reached|No-progress run limit/);
});

test('idle time carries into the next short run for the same delivery', async () => {
  let ms = Date.parse('2026-01-01T00:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(ms).toISOString() });
  await engine.registerPack({ id: 'delivery', version: '5', graphs: [{ id: 'short', version: '1', start: 'end',
    nodes: [{ id: 'end', type: 'end' }], edges: [] }], decisionRules: [] });
  const start = () => engine.startRun({ packId: 'delivery', packVersion: '5', graphId: 'short', actor: owner,
    input: { deliveryId: 'carry-goal' } });
  const first = await start();
  ms += 15 * 60_000;
  await engine.submitNode({ runId: first.id, nodeId: 'end', actor: owner });
  const second = await start();
  ms += 15 * 60_000;
  assert.equal((await engine.getRun(second.id)).status, 'stopped');
  await assert.rejects(start(), /Delivery limit reached/);
});
