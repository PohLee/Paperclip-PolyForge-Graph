import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyControlPlane, GraphEngine, MemoryStore } from '../../src/core/index.mjs';

const minute = 60_000;
const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const system = { id: 'orchestrator', kind: 'system', roles: [] };
const maker = { id: 'maker', kind: 'agent', roles: ['maker'], executionId: 'make' };
const lead = { id: 'lead', kind: 'agent', roles: ['lead'], executionId: 'check' };
const human = { id: 'reviewer', kind: 'human', roles: ['human-owner', 'lead'] };
const artifact = (kind, id = kind, version = 'v1') => ({ kind, id, version });
const rules = [
  { type: 'review', mode: 'manual', requiresHuman: true, requiredEvidence: [] },
  { type: 'review', mode: 'assisted', requiresHuman: false, allowedRoles: ['lead'], requiredEvidence: [] },
  { type: 'gate', mode: 'manual', requiresHuman: true, requiredEvidence: [] },
];
const reviewed = (id, extra = {}) => ({ id, type: 'task', role: 'maker', produces: [id],
  review: { supervisorRole: 'lead', maxSelfReviews: 1 }, ...extra });
const end = { id: 'end', type: 'end' };
const chain = (id, nodes, extra = {}) => ({ id, version: '1', start: nodes[0].id, nodes,
  edges: nodes.slice(1).map((node, n) => ({ from: nodes[n].id, to: node.id })), ...extra });
const contract = { version: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputMapping: {} };
const graphs = [
  chain('reviewed', [reviewed('plan'), { id: 'work', type: 'task', role: 'maker', produces: ['work'] }, end]),
  chain('gated', [{ id: 'gate', type: 'decision', role: 'lead', decisionType: 'gate', outcomes: ['go'] }, end],
    { edges: [{ from: 'gate', to: 'end', when: 'go' }] }),
  { id: 'parallel', version: '1', start: 'split',
    nodes: [{ id: 'split', type: 'task', role: 'maker' }, reviewed('left'),
      { id: 'right', type: 'task', role: 'maker', produces: ['right'] }, { id: 'merge', type: 'join', mode: 'all' }, end],
    edges: [{ from: 'split', to: 'left' }, { from: 'split', to: 'right' }, { from: 'left', to: 'merge' },
      { from: 'right', to: 'merge' }, { from: 'merge', to: 'end' }] },
  chain('long', [...[1, 2, 3, 4, 5].map(n => reviewed(`stage-${n}`, { deliveryMilestone: true })), end]),
  chain('child', [reviewed('draft', { deliveryMilestone: true }),
    { id: 'polish', type: 'task', role: 'maker', produces: ['polish'] }, end], { workflowContract: contract }),
  chain('parent', [{ id: 'call', type: 'workflow',
    workflow: { packId: 'wait', packVersion: '1', graphId: 'child', graphVersion: '1' }, inputMapping: {} }, end]),
];
const pack = { id: 'wait', version: '1', graphs, decisionRules: rules };

async function setup({ store = new MemoryStore() } = {}) {
  const clock = { ms: Date.parse('2026-01-01T00:00:00Z') };
  const now = () => new Date(clock.ms).toISOString();
  const engine = new GraphEngine({ store, now });
  await engine.registerPack(pack);
  const start = (graphId, mode = 'manual', input = {}) =>
    engine.startRun({ packId: 'wait', packVersion: '1', graphId, actor: owner, mode, input });
  const advance = minutes => { clock.ms += minutes * minute; };
  const submit = async (runId, nodeId) => {
    await engine.submitNode({ runId, nodeId, actor: maker, artifacts: [artifact(nodeId)] });
  };
  const selfReview = (runId, nodeId) => engine.recordSelfReview({ runId, nodeId, actor: maker, artifactVersion: 'v1' });
  const accept = (runId, nodeId, actor = human) =>
    engine.reviewWork({ runId, nodeId, actor, outcome: 'accept', reason: 'Checked' });
  const status = runId => engine.getDeliveryStatus(runId);
  const stopReason = async runId => (await engine.listDecisions({ runId })).at(-1).reason;
  return { engine, store, now, start, advance, submit, selfReview, accept, status, stopReason };
}

test('a human supervisor wait consumes no active or idle time', async () => {
  const t = await setup();
  const run = await t.start('reviewed');
  t.advance(20);
  await t.submit(run.id, 'plan');
  await t.selfReview(run.id, 'plan');
  t.advance(5 * 60);
  const waiting = await t.status(run.id);
  assert.equal(waiting.runStatus, 'running');
  assert.equal(waiting.activeMinutes, 20);
  assert.equal(waiting.idleMinutesRemaining, 10);
  await t.accept(run.id, 'plan');
  t.advance(9);
  assert.equal((await t.engine.getRun(run.id)).status, 'running');
  t.advance(1);
  assert.equal((await t.engine.getRun(run.id)).status, 'stopped');
  assert.equal(await t.stopReason(run.id), 'idle_progress_limit');
});

test('the slice limit counts active minutes only, across repeated human waits', async () => {
  const t = await setup();
  const run = await t.start('long');
  for (const n of [1, 2, 3, 4]) {
    t.advance(25);
    await t.submit(run.id, `stage-${n}`);
    await t.selfReview(run.id, `stage-${n}`);
    t.advance(5 * 60);
    await t.accept(run.id, `stage-${n}`);
  }
  assert.equal((await t.status(run.id)).activeMinutes, 100);
  assert.equal((await t.status(run.id)).sliceMinutesRemaining, 20);
  t.advance(19);
  assert.equal((await t.engine.getRun(run.id)).status, 'running');
  t.advance(1);
  assert.equal((await t.engine.getRun(run.id)).status, 'stopped');
  assert.equal(await t.stopReason(run.id), 'slice_time_limit');
});

test('a pending self review is agent work and keeps the clock running', async () => {
  const t = await setup();
  const run = await t.start('reviewed');
  await t.submit(run.id, 'plan');
  t.advance(30);
  assert.equal((await t.engine.getRun(run.id)).status, 'stopped');
});

test('a supervisor wait that an agent may resolve keeps the clock running', async () => {
  const t = await setup();
  const run = await t.start('reviewed', 'assisted');
  await t.submit(run.id, 'plan');
  await t.selfReview(run.id, 'plan');
  t.advance(30);
  assert.equal((await t.engine.getRun(run.id)).status, 'stopped');
});

test('a run that starts at a human gate waits without spending its delivery clock', async () => {
  const t = await setup();
  const run = await t.start('gated');
  t.advance(24 * 60);
  assert.equal((await t.status(run.id)).activeMinutes, 0);
  await t.engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'go', reason: 'Proceed' });
  assert.equal((await t.engine.getRun(run.id)).status, 'running');
  assert.equal((await t.status(run.id)).activeMinutes, 0);
});

test('open agent work on a parallel branch keeps the clock running during a human review', async () => {
  const t = await setup();
  const run = await t.start('parallel');
  await t.engine.submitNode({ runId: run.id, nodeId: 'split', actor: maker });
  await t.submit(run.id, 'left');
  await t.selfReview(run.id, 'left');
  t.advance(10);
  assert.equal((await t.status(run.id)).activeMinutes, 10);
  await t.submit(run.id, 'right');
  t.advance(60);
  const waiting = await t.status(run.id);
  assert.equal(waiting.runStatus, 'running');
  assert.equal(waiting.activeMinutes, 10);
});

test('a company control write leaves a human wait stopped', async () => {
  const store = new MemoryStore();
  const t = await setup({ store });
  const run = await t.start('gated');
  const control = new CompanyControlPlane({ store, companyId: 'a', now: t.now });
  t.advance(60);
  await control.configureSetup({ actor: owner, reason: 'Configure company', organization: {
    board: { id: 'board' }, ceo: { id: 'ceo' }, domainHeads: [{ agentId: 'head', domain: 'engineering' }] } });
  t.advance(60);
  assert.equal((await t.status(run.id)).activeMinutes, 0);
  assert.equal((await store.read()).runs[run.id].deliveryClock.activeSince, null);
});

async function composed() {
  const t = await setup();
  const parent = await t.start('parent', 'manual', { workflowInput: {} });
  const child = await t.engine.startChildWorkflow({ runId: parent.id, nodeId: 'call', actor: system });
  return { ...t, parent, child };
}

test('a child milestone refreshes the parent progress clock', async () => {
  const t = await composed();
  t.advance(20);
  await t.submit(t.child.id, 'draft');
  await t.selfReview(t.child.id, 'draft');
  await t.accept(t.child.id, 'draft');
  assert.equal((await t.status(t.parent.id)).idleMinutesRemaining, 30);
  t.advance(25);
  assert.equal((await t.engine.getRun(t.parent.id)).status, 'running');
  assert.equal(await t.engine.isDispatchEligible(t.child.id), true);
});

test('a parent waits with its child for a person and completes as a productive run', async () => {
  const t = await composed();
  t.advance(20);
  await t.submit(t.child.id, 'draft');
  await t.selfReview(t.child.id, 'draft');
  t.advance(5 * 60);
  assert.equal((await t.status(t.parent.id)).activeMinutes, 20);
  assert.equal((await t.status(t.child.id)).activeMinutes, 20);
  await t.accept(t.child.id, 'draft');
  t.advance(5);
  await t.submit(t.child.id, 'polish');
  await t.engine.submitNode({ runId: t.child.id, nodeId: 'end', actor: owner });
  await t.engine.reconcileChildWorkflow({ runId: t.parent.id, nodeId: 'call', actor: system });
  await t.engine.submitNode({ runId: t.parent.id, nodeId: 'end', actor: owner });
  assert.equal((await t.engine.getRun(t.parent.id)).status, 'completed');
  const done = await t.status(t.parent.id);
  assert.equal(done.activeMinutes, 25);
  assert.equal(done.noProgressRuns, 0);
  assert.equal(done.acceptedMilestones.length, 1);
});

test('a stalled child still stops its parent at the idle limit', async () => {
  const t = await composed();
  t.advance(30);
  assert.equal((await t.engine.getRun(t.parent.id)).status, 'stopped');
  assert.equal(await t.stopReason(t.parent.id), 'idle_progress_limit');
  assert.equal(await t.engine.isDispatchEligible(t.child.id), false);
});

test('a paused or blocked child leaves the parent waiting', async () => {
  const t = await composed();
  await t.engine.pauseRun({ runId: t.child.id, actor: owner, reason: 'Owner inspects' });
  t.advance(60);
  assert.equal((await t.status(t.parent.id)).activeMinutes, 0);
  const state = await t.store.read();
  state.runs[t.child.id].status = 'rework_required';
  await t.store.write(state, state.revision);
  await t.engine.reconcileChildWorkflow({ runId: t.parent.id, nodeId: 'call', actor: system });
  assert.equal((await t.engine.getRun(t.parent.id)).nodeStates.call.status, 'child_blocked');
  t.advance(5 * 60);
  assert.equal((await t.engine.getRun(t.parent.id)).status, 'running');
  assert.equal((await t.status(t.parent.id)).activeMinutes, 0);
  await t.engine.invalidateEvidence({ runId: t.parent.id, nodeId: 'call', actor: owner, reason: 'Restart the child' });
  t.advance(10);
  assert.equal((await t.status(t.parent.id)).activeMinutes, 10);
});
