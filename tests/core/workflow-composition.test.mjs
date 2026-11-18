import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngine, MemoryStore, FileStore, runValidationDigest, CORE_RUNTIME, compatibilityIssues } from '../../src/core/index.mjs';
import { compositionPack } from '../../examples/workflow-composition/pack.mjs';

const system = { id: 'orchestrator', kind: 'system', roles: [] };
const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const worker = { id: 'worker', kind: 'agent', roles: ['worker'], executionId: 'work-1' };
const string = { type: 'string' };
const schema = { type: 'object', properties: { message: string }, required: ['message'], additionalProperties: false };
const contract = (source, nodeId) => ({ version: 1, inputSchema: schema, outputSchema: schema,
  outputMapping: { message: source === 'input' ? { source: 'input', path: ['message'] } : { source: 'node', nodeId, path: ['message'] } } });
const ref = (graphId, graphVersion = '1') => ({ packId: 'p', packVersion: '1', graphId, graphVersion });
const child = { id: 'child', version: '1', start: 'work', workflowContract: contract('node', 'work'),
  nodes: [{ id: 'work', type: 'task', role: 'worker' }, { id: 'end', type: 'end' }],
  edges: [{ from: 'work', to: 'end' }] };
const parent = { id: 'parent', version: '1', start: 'call', workflowContract: contract('node', 'call'),
  nodes: [{ id: 'call', type: 'workflow', workflow: ref('child'), inputMapping: { message: { source: 'input', path: ['message'] } } },
    { id: 'end', type: 'end' }], edges: [{ from: 'call', to: 'end' }] };
const pack = (graphs = [parent, child]) => ({ id: 'p', version: '1', graphs });
const start = (engine, feature = false) => engine.startRun({ packId: 'p', packVersion: '1', graphId: 'parent', actor: owner,
  input: { workflowInput: { message: 'hello' }, paperclipCompanyId: 'company', projectId: 'project', paperclipIssueId: 'root', ...(feature ? { feature: 'feature' } : {}) },
  mode: 'manual' });

test('child start is atomic, pinned, inherited, and deduplicated across engine instances', async () => {
  const store = new MemoryStore(), first = new GraphEngine({ store }), second = new GraphEngine({ store });
  await first.registerPack(pack());
  const root = await start(first, true);
  const [a, b] = await Promise.all([
    first.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system }),
    second.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system }),
  ]);
  assert.equal(a.id, b.id);
  const linked = await first.getRun(root.id);
  assert.equal(linked.nodeStates.call.childRunId, a.id);
  assert.deepEqual(a.parentWorkflow, { runId: root.id, nodeId: 'call', attempt: 1 });
  assert.equal(a.parentRunId, root.id);
  assert.deepEqual(a.input.workflowInput, { message: 'hello' });
  for (const key of ['paperclipCompanyId', 'projectId', 'paperclipIssueId', 'feature']) assert.equal(a.input[key], root.input[key]);
  assert.equal(a.input.deliveryId, 'root');
  assert.equal(a.mode, root.mode);
  assert.deepEqual(a.deliveryLimits, root.deliveryLimits);
  assert.equal((await first.getWorkItems(root.id)).length, 0);
  await assert.rejects(first.submitNode({ runId: root.id, nodeId: 'call', actor: worker, output: { message: 'fake' } }), /not ready|Workflow nodes/);
});

test('child completion projects current validated output; ordinary submit and stale digest fail', async () => {
  const engine = new GraphEngine(); await engine.registerPack(pack());
  const root = await start(engine);
  await assert.rejects(engine.submitNode({ runId: root.id, nodeId: 'call', actor: owner }), /Workflow nodes/);
  const oldDigest = runValidationDigest(root);
  const nested = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  await assert.rejects(engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system, expectedRunDigest: oldDigest }), /Run changed/);
  await engine.submitNode({ runId: nested.id, nodeId: 'work', actor: worker, output: { message: 42 } });
  await assert.rejects(engine.submitNode({ runId: nested.id, nodeId: 'end', actor: owner }), /workflowOutput.message/);
  await engine.invalidateEvidence({ runId: nested.id, nodeId: 'work', actor: owner, reason: 'Invalid output' });
  await engine.submitNode({ runId: nested.id, nodeId: 'work', actor: worker, output: { message: 'done' } });
  await engine.submitNode({ runId: nested.id, nodeId: 'end', actor: owner });
  const reconciled = await engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  assert.equal(reconciled.nodeStates.call.status, 'completed');
  assert.deepEqual(reconciled.nodeStates.call.output, { message: 'done' });
  assert.deepEqual((await engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system })).nodeStates.call.output, { message: 'done' });
  await engine.submitNode({ runId: root.id, nodeId: 'end', actor: owner });
  assert.deepEqual((await engine.getRun(root.id)).workflowOutput, { message: 'done' });
});

test('parent pause and invalidation fence child work and old attempts', async () => {
  const engine = new GraphEngine(); await engine.registerPack(pack());
  const root = await start(engine);
  const old = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  await engine.pauseRun({ runId: root.id, actor: owner, reason: 'Hold' });
  assert.deepEqual(await engine.getWorkItems(old.id), []);
  await assert.rejects(engine.submitNode({ runId: old.id, nodeId: 'work', actor: worker, output: { message: 'late' } }), /parent is paused/);
  await engine.resumeRun({ runId: root.id, actor: owner, reason: 'Continue' });
  await engine.invalidateEvidence({ runId: root.id, nodeId: 'call', actor: owner, reason: 'Changed input' });
  await assert.rejects(engine.submitNode({ runId: old.id, nodeId: 'work', actor: worker, output: { message: 'late' } }), /invalidated/);
  const next = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  assert.notEqual(next.id, old.id);
  assert.equal(next.parentWorkflow.attempt, 2);
  assert.equal((await engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system })).nodeStates.call.childRunId, next.id);
});

test('exact child references, contracts, recursion and depth fail closed', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack([{ ...parent, nodes: [{ ...parent.nodes[0], workflow: ref('child', 'wrong') }, parent.nodes[1]] }, child]));
  const root = await start(engine);
  await assert.rejects(engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system }), /Exact child workflow reference/);
  const recursive = { ...parent, nodes: [{ ...parent.nodes[0], workflow: ref('parent') }, parent.nodes[1]] };
  const cycle = new GraphEngine(); await cycle.registerPack(pack([recursive]));
  const cycRun = await start(cycle);
  await assert.rejects(cycle.startChildWorkflow({ runId: cycRun.id, nodeId: 'call', actor: system }), /Recursive/);
  const chain = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, version: '1', start: i === 5 ? 'end' : 'call',
    workflowContract: contract('input'), nodes: i === 5 ? [{ id: 'end', type: 'end' }] :
      [{ id: 'call', type: 'workflow', workflow: ref(`g${i + 1}`), inputMapping: { message: { source: 'input', path: ['message'] } } }, { id: 'end', type: 'end' }],
    edges: i === 5 ? [] : [{ from: 'call', to: 'end' }] }));
  const deep = new GraphEngine(); await deep.registerPack(pack(chain));
  let current = await deep.startRun({ packId: 'p', packVersion: '1', graphId: 'g0', actor: owner,
    input: { workflowInput: { message: 'hello' } }, deliveryLimits: { concurrentRuns: 5 } });
  for (let i = 0; i < 4; i++) current = await deep.startChildWorkflow({ runId: current.id, nodeId: 'call', actor: system });
  await assert.rejects(deep.startChildWorkflow({ runId: current.id, nodeId: 'call', actor: system }), /four child levels/);
});

test('durable child link survives FileStore restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-core-'));
  try {
    const file = join(dir, 'state.json');
    const first = new GraphEngine({ store: new FileStore(file) }); await first.registerPack(pack());
    const root = await start(first);
    const childRun = await first.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
    const restarted = new GraphEngine({ store: new FileStore(file) });
    assert.equal((await restarted.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system })).id, childRun.id);
    await restarted.submitNode({ runId: childRun.id, nodeId: 'work', actor: worker, output: { message: 'persisted' } });
    await restarted.submitNode({ runId: childRun.id, nodeId: 'end', actor: owner });
    assert.deepEqual((await restarted.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system })).nodeStates.call.output, { message: 'persisted' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('child start enforces system identity, node roles, declared contract and normal start inputs', async () => {
  const engine = new GraphEngine(); await engine.registerPack(pack());
  const root = await start(engine);
  await assert.rejects(engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: owner }), /trusted system actor/);
  await assert.rejects(engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: owner }), /trusted system actor/);
  const restricted = new GraphEngine();
  await restricted.registerPack(pack([{ ...parent, nodes: [{ ...parent.nodes[0], role: 'workflow-operator' }, parent.nodes[1]] }, child]));
  const restrictedRun = await start(restricted);
  await assert.rejects(restricted.startChildWorkflow({ runId: restrictedRun.id, nodeId: 'call', actor: system }), /required role/);
  const lackingContract = new GraphEngine();
  await lackingContract.registerPack(pack([parent, { ...child, workflowContract: undefined }]));
  const noContractRun = await start(lackingContract);
  await assert.rejects(lackingContract.startChildWorkflow({ runId: noContractRun.id, nodeId: 'call', actor: system }), /contract is required/);
  const requiredInput = new GraphEngine();
  await requiredInput.registerPack(pack([parent, { ...child, requiredRunInputs: ['special'] }]));
  const requiredRun = await start(requiredInput);
  await assert.rejects(requiredInput.startChildWorkflow({ runId: requiredRun.id, nodeId: 'call', actor: system }), /Required run input missing: special/);
});

test('missing child mappings, wrong company and malformed declarations fail closed', async () => {
  const mapped = { ...parent, nodes: [{ ...parent.nodes[0], inputMapping: { message: { source: 'input', path: ['missing'] } } }, parent.nodes[1]] };
  const engine = new GraphEngine(); await engine.registerPack(pack([mapped, child]));
  const root = await start(engine);
  await assert.rejects(engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system }), /Mapping path is missing/);
  const invalid = new GraphEngine();
  await assert.rejects(invalid.registerPack(pack([{ ...parent, nodes: [{ ...parent.nodes[0], inputMapping: { message: { source: 'node', nodeId: 'end', path: [] } } }, parent.nodes[1]] }, child])), /upstream node/);
  const store = new MemoryStore(), scoped = new GraphEngine({ store });
  await scoped.registerPack(pack());
  const state = await store.read();
  state.control = { companyId: 'other-company', enabledPacks: [{ packId: 'p', version: '1' }] };
  state.revision++;
  await store.write(state, state.revision - 1);
  await assert.rejects(start(scoped), /company context/);
});

test('rework child blocks parent advancement and can be replaced only by invalidation', async () => {
  const reworkChild = { ...child, nodes: [child.nodes[0], { ...child.nodes[1], output: 'rework_required' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack([parent, reworkChild]));
  const root = await start(engine);
  const nested = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system, idempotencyKey: 'one' });
  await engine.submitNode({ runId: nested.id, nodeId: 'work', actor: worker, output: { message: 'work' } });
  await engine.submitNode({ runId: nested.id, nodeId: 'end', actor: owner });
  assert.equal((await engine.getRun(nested.id)).status, 'rework_required');
  const blocked = await engine.reconcileChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  assert.equal(blocked.nodeStates.call.status, 'child_blocked');
  assert.equal(blocked.nodeStates.call.output, undefined);
  assert.deepEqual(await engine.getReadyNodes(root.id), []);
  await engine.invalidateEvidence({ runId: root.id, nodeId: 'call', actor: owner, reason: 'Retry child' });
  await assert.rejects(engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system, idempotencyKey: 'one' }), /invalidated/);
  const replacement = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  assert.notEqual(replacement.id, nested.id);
});

test('stopped parent fences child mutation and dispatch eligibility', async () => {
  let clock = Date.parse('2026-11-18T08:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(clock).toISOString() });
  await engine.registerPack(pack());
  const root = await start(engine);
  const nested = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  clock += 241 * 60_000;
  assert.equal((await engine.getRun(root.id)).status, 'stopped');
  assert.equal(await engine.isDispatchEligible(nested.id), false);
  assert.deepEqual(await engine.getWorkItems(nested.id), []);
  await assert.rejects(engine.submitNode({ runId: nested.id, nodeId: 'work', actor: worker, output: { message: 'late' } }), /paused, stopped or invalidated/);
});

test('parent delivery expiry fences a younger child before its own limit', async () => {
  let clock = Date.parse('2026-11-18T08:00:00Z');
  const engine = new GraphEngine({ now: () => new Date(clock).toISOString() });
  await engine.registerPack(pack());
  const root = await start(engine);
  clock += 25 * 60_000;
  const nested = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  clock += 6 * 60_000;
  assert.equal(await engine.isDispatchEligible(nested.id), false);
  const result = await engine.submitNode({ runId: nested.id, nodeId: 'work', actor: worker, output: { message: 'late' } });
  assert.equal(result.allowed, false);
  assert.equal((await engine.getRun(root.id)).status, 'stopped');
  assert.equal((await engine.getRun(nested.id)).nodeStates.work.status, 'pending');
});

test('startRun pins optional exact graphVersion and binds it to idempotency', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store });
  await engine.registerPack(pack());
  const before = await store.read();
  const request = { packId: 'p', packVersion: '1', graphId: 'parent', actor: owner,
    input: { workflowInput: { message: 'hello' } }, idempotencyKey: 'versioned-start' };
  await assert.rejects(engine.startRun({ ...request, graphVersion: 'wrong' }), /Exact Graph version/);
  assert.equal((await store.read()).revision, before.revision);
  const run = await engine.startRun({ ...request, graphVersion: '1' });
  assert.equal(run.graph.version, '1');
  assert.equal((await engine.startRun({ ...request, graphVersion: '1' })).id, run.id);
  await assert.rejects(engine.startRun({ ...request, graphVersion: '2' }), /Idempotency key reused/);
  await assert.rejects(engine.startRun(request), /Idempotency key reused/);
});

test('child graph start roles bind to the root initiator, never the system actor', async () => {
  const restricted = { ...pack(), graphStartRoles: { child: ['restricted'] } };
  const engine = new GraphEngine(); await engine.registerPack(restricted);
  const root = await start(engine);
  await assert.rejects(engine.startChildWorkflow({ runId: root.id, nodeId: 'call',
    actor: { ...system, roles: ['restricted'] } }), /Root initiator role/);
  const authorized = await engine.startRun({ packId: 'p', packVersion: '1', graphId: 'parent',
    actor: { ...owner, roles: [...owner.roles, 'restricted'] }, input: { workflowInput: { message: 'hello' } } });
  const childRun = await engine.startChildWorkflow({ runId: authorized.id, nodeId: 'call', actor: system });
  assert.equal(childRun.graph.id, 'child');
  const missingEntry = new GraphEngine();
  await missingEntry.registerPack({ ...pack(), graphStartRoles: { parent: ['human-owner'] } });
  const missingRoot = await start(missingEntry);
  await assert.rejects(missingEntry.startChildWorkflow({ runId: missingRoot.id, nodeId: 'call', actor: system }), /Root initiator role/);
});

test('nested child start checks the original initiator rather than an intermediate system run', async () => {
  const middle = { ...parent, id: 'middle' };
  const rootGraph = { ...parent, nodes: [{ ...parent.nodes[0], workflow: ref('middle') }, parent.nodes[1]] };
  const engine = new GraphEngine();
  await engine.registerPack({ ...pack([rootGraph, middle, child]),
    graphStartRoles: { middle: ['initiator'], child: ['initiator'] } });
  const root = await engine.startRun({ packId: 'p', packVersion: '1', graphId: 'parent',
    actor: { ...owner, roles: [...owner.roles, 'initiator'] }, input: { workflowInput: { message: 'hello' } } });
  const intermediate = await engine.startChildWorkflow({ runId: root.id, nodeId: 'call', actor: system });
  assert.equal(intermediate.startedBy.kind, 'system');
  const leaf = await engine.startChildWorkflow({ runId: intermediate.id, nodeId: 'call', actor: system });
  assert.equal(leaf.graph.id, 'child');
});

test('child input mapping declarations reject unsupported and unsafe keys before registration', async () => {
  for (const inputMapping of [
    { message: { source: 'input', path: ['message'], expression: 'unsafe' } },
    JSON.parse('{"__proto__":{"source":"input","path":[]}}'),
    { message: { source: 'input', path: ['constructor'] } },
  ]) {
    const engine = new GraphEngine();
    const invalidParent = { ...parent, nodes: [{ ...parent.nodes[0], inputMapping }, parent.nodes[1]] };
    await assert.rejects(engine.registerPack(pack([invalidParent, child])), /Unsupported|Unsafe|unsafe/);
    assert.equal((await engine.store.read())?.packs?.['p@1'], undefined);
  }
});

test('example requires the intrinsic composition capability from a compatible Core', () => {
  assert.equal(CORE_RUNTIME.capabilities['workflow-composition'], '1.0.0');
  assert.deepEqual(compatibilityIssues(compositionPack), []);
  const { ['workflow-composition']: _omitted, ...oldCapabilities } = CORE_RUNTIME.capabilities;
  const oldRuntime = { ...CORE_RUNTIME, capabilities: oldCapabilities };
  assert.match(compatibilityIssues(compositionPack, null, { runtime: oldRuntime }).join(' '), /workflow-composition/);
});
