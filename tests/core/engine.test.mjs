import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngine, MemoryStore, FileStore } from '../../src/core/index.mjs';

const human = { id: 'user-1', kind: 'human', roles: ['owner', 'human-owner'], executionId: 'ui-1' };
const maker = { id: 'agent-maker', kind: 'agent', roles: ['maker'], executionId: 'exec-maker' };
const reviewer = { id: 'agent-reviewer', kind: 'agent', roles: ['reviewer'], executionId: 'exec-reviewer' };
const rules = [
  { type: 'route', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['owner'] },
  { type: 'review', mode: 'manual', allowedKinds: ['agent'], allowedRoles: ['reviewer'] },
  { type: 'product', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['owner'] },
];
const graph = {
  id: 'design', version: '1', start: 'route',
  nodes: [
    { id: 'route', type: 'decision', role: 'owner', decisionType: 'route' },
    { id: 'minor', type: 'task', role: 'maker' },
    { id: 'major', type: 'task', role: 'maker' },
    { id: 'join', type: 'join', mode: 'all' },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'route', to: 'minor', when: 'minor' }, { from: 'route', to: 'major', when: 'major' },
    { from: 'minor', to: 'join' }, { from: 'major', to: 'join' }, { from: 'join', to: 'end' },
  ],
};
const pack = (version = '1', g = graph) => ({ id: 'adlc', version, graphs: [g], decisionRules: rules });

test('pins pack and graph, selects one branch, and completes ALL join', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack());
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human, idempotencyKey: 'start-a' });
  assert.equal((await engine.getReadyNodes(run.id))[0].id, 'route');
  await engine.decideNode({ runId: run.id, nodeId: 'route', actor: human, outcome: 'minor', reason: 'Small adjustment', idempotencyKey: 'route-a' });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((n) => n.id), ['minor']);
  await engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker, output: { version: 'v1' } });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((n) => n.id), ['join']);
  await engine.submitNode({ runId: run.id, nodeId: 'join', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'end', actor: human });
  assert.equal((await engine.getRun(run.id)).status, 'completed');
  assert.equal((await engine.listDecisions({ runId: run.id })).length, 1);
  await engine.registerPack(pack('2', { ...graph, version: '2' }));
  assert.equal((await engine.getRun(run.id)).graph.version, '1');
});

test('work items classify automatic, human, and agent work from the pinned Pack rule', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack());
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human });
  assert.deepEqual((await engine.getWorkItems(run.id)).map(({ nodeId, kind, operation }) => [nodeId, kind, operation]),
    [['route', 'human', 'decide']]);
  await engine.decideNode({ runId: run.id, nodeId: 'route', actor: human, outcome: 'minor', reason: 'Minor route' });
  assert.deepEqual((await engine.getWorkItems(run.id)).map(({ nodeId, kind, role }) => [nodeId, kind, role]),
    [['minor', 'agent', 'maker']]);
  await engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker });
  assert.deepEqual((await engine.getWorkItems(run.id)).map(({ nodeId, kind }) => [nodeId, kind]), [['join', 'automatic']]);
});

test('work eligibility honors allowedRoles before offering an agent dispatch', async () => {
  const routeGraph = { id: 'route-only', version: '1', start: 'route',
    nodes: [{ id: 'route', type: 'decision', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'route', to: 'end', when: 'go' }] };
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'policy', version: '1', graphs: [routeGraph], decisionRules: [
    { type: 'route', mode: 'manual', allowedKinds: ['agent'], allowedRoles: ['reviewer'] },
  ] });
  const run = await engine.startRun({ packId: 'policy', packVersion: '1', graphId: 'route-only', actor: human });
  assert.equal((await engine.getWorkItems(run.id))[0].kind, 'blocked');
  await assert.rejects(engine.decideNode({ runId: run.id, nodeId: 'route', actor: maker, outcome: 'go', reason: 'Try' }), /Decision role not allowed/);
});

test('work items classify independent review using the review rule', async () => {
  const reviewed = { id: 'reviewed', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker', review: { supervisorRole: 'reviewer', decisionType: 'review' } },
      { id: 'end', type: 'end' }], edges: [{ from: 'make', to: 'end' }] };
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'review-pack', version: '1', graphs: [reviewed], decisionRules: [
    { type: 'review', mode: 'manual', allowedKinds: ['human'], requiresHuman: true },
  ] });
  const run = await engine.startRun({ packId: 'review-pack', packVersion: '1', graphId: 'reviewed', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker,
    artifacts: [{ id: 'artifact', version: '1', kind: 'design' }] });
  await engine.recordSelfReview({ runId: run.id, nodeId: 'make', actor: maker, artifactVersion: '1' });
  assert.deepEqual((await engine.getWorkItems(run.id)).map(({ nodeId, phase, kind, operation }) =>
    [nodeId, phase, kind, operation]), [['make', 'supervisor', 'human', 'review']]);
});

test('ALL join waits for both activated branches', async () => {
  const both = { ...graph, edges: graph.edges.map((edge) => edge.from === 'route' ? { from: edge.from, to: edge.to, when: 'both' } : edge) };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', both));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human });
  await engine.decideNode({ runId: run.id, nodeId: 'route', actor: human, outcome: 'both', reason: 'Compare both' });
  await engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((n) => n.id), ['major']);
  await engine.submitNode({ runId: run.id, nodeId: 'major', actor: maker });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((n) => n.id), ['join']);
});

test('self review stops at five and supervisor identity is independent; rework keeps history', async () => {
  const workGraph = { id: 'work', version: '1', start: 'work', nodes: [{ id: 'work', type: 'task', role: 'maker', review: { supervisorRole: 'reviewer', maxSelfReviews: 5 } }, { id: 'end', type: 'end' }], edges: [{ from: 'work', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', workGraph));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'work', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: maker, artifacts: [{ id: 'code', version: 'v1' }] });
  for (let round = 1; round <= 5; round++) {
    const state = await engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: maker, artifactVersion: 'v1', findings: [{ severity: 'P1', status: 'open' }] });
    assert.equal(state.status, round === 5 ? 'awaiting_supervisor_review' : 'awaiting_self_review');
  }
  await assert.rejects(engine.reviewWork({ runId: run.id, nodeId: 'work', actor: { ...maker, roles: ['reviewer'] }, outcome: 'accept', reason: 'Same agent' }), /independent/);
  await engine.reviewWork({ runId: run.id, nodeId: 'work', actor: reviewer, outcome: 'rework', reason: 'Fix P1' });
  assert.equal((await engine.getReadyNodes(run.id))[0].id, 'work');
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: maker, artifacts: [{ id: 'code', version: 'v2' }] });
  await engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: maker, artifactVersion: 'v2', findings: [] });
  await engine.reviewWork({ runId: run.id, nodeId: 'work', actor: reviewer, outcome: 'accept', reason: 'Verified' });
  assert.equal((await engine.getRun(run.id)).nodeStates.work.attempts.length, 2);
});

test('independent review node rejects same execution and stale downstream is invalidated', async () => {
  const g = { id: 'verify', version: '1', start: 'build', nodes: [{ id: 'build', type: 'task', role: 'maker' }, { id: 'verify', type: 'task', role: 'reviewer', independentOf: ['build'] }, { id: 'end', type: 'end' }], edges: [{ from: 'build', to: 'verify' }, { from: 'verify', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'verify', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ id: 'code', version: 'v1' }] });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'verify', actor: { ...maker, roles: ['reviewer'] } }), /Independent/);
  await engine.submitNode({ runId: run.id, nodeId: 'verify', actor: { ...maker, roles: ['reviewer'], executionId: 'separate-review-session' }, evidence: [{ artifactId: 'code', version: 'v1' }] });
  await engine.submitNode({ runId: run.id, nodeId: 'end', actor: human });
  await engine.invalidateEvidence({ runId: run.id, nodeId: 'build', actor: human, reason: 'Code changed' });
  const updated = await engine.getRun(run.id);
  assert.equal(updated.nodeStates.verify.status, 'pending');
  assert.equal(updated.nodeStates.verify.evidence, undefined);
  assert.equal(updated.nodeStates.verify.attempts.length, 1);
});

test('human conflict survives restart; duplicate callback is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-core-'));
  try {
    const path = join(dir, 'state.json');
    const first = new GraphEngine({ store: new FileStore(path) });
    await first.registerPack(pack());
    const started = await first.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human, idempotencyKey: 'same' });
    assert.equal((await first.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human, idempotencyKey: 'same' })).id, started.id);
    const conflict = await first.openConflict({ runId: started.id, actor: maker, positions: { cpo: { stance: 'go' }, cto: { stance: 'block' } }, unresolved: ['risk'], reason: 'No agreement' });
    const second = new GraphEngine({ store: new FileStore(path) });
    assert.equal((await second.getRun(started.id)).status, 'paused');
    await assert.rejects(second.resumeRun({ runId: started.id, actor: human, reason: 'Try' }), /Unresolved/);
    await assert.rejects(second.resolveConflict({ runId: started.id, conflictId: conflict.id, actor: maker, outcome: 'go', reason: 'Fake human' }), /human owner/);
    await assert.rejects(second.resolveConflict({ runId: started.id, conflictId: conflict.id, actor: { ...human, roles: ['member'] }, outcome: 'go', reason: 'Member override' }), /human owner/);
    await second.resolveConflict({ runId: started.id, conflictId: conflict.id, actor: human, outcome: 'modify', reason: 'Reduce scope' });
    assert.equal((await second.getRun(started.id)).status, 'running');
    assert.equal((await second.listDecisions({ runId: started.id })).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product memory retains superseded history and protects active behavior', async () => {
  const engine = new GraphEngine();
  const first = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Keep password login', reason: 'Customers need fallback' });
  await assert.rejects(engine.assertProductChangeAllowed({ feature: 'login', changesBehavior: true }), /referenced/);
  const rejected = await engine.recordProductDecision({ feature: 'login', actor: human, status: 'rejected', outcome: 'Remove fallback', reason: 'Risk too high', supersedes: first.id });
  assert.deepEqual((await engine.getProductMemory('login')).active.map((item) => item.id), [first.id]);
  const second = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Use passkeys with fallback', reason: 'Improved security', supersedes: first.id, changeScope: ['login.authentication'] });
  const memory = await engine.getProductMemory('login');
  assert.equal(memory.history.length, 3);
  assert.deepEqual(memory.active.map((item) => item.id), [second.id]);
  assert.equal(memory.history.find((item) => item.id === rejected.id).status, 'rejected');
  await assert.rejects(engine.assertProductChangeAllowed({ feature: 'login', referencedDecisionIds: [second.id], approvedDecisionId: second.id, changesBehavior: true, changeScope: 'login.fallback-removal' }), /approved superseding/);
  await engine.assertProductChangeAllowed({ feature: 'login', referencedDecisionIds: [second.id], approvedDecisionId: second.id, changesBehavior: true, changeScope: 'login.authentication' });
  await assert.rejects(engine.recordProductDecision({ feature: 'login', actor: maker, outcome: 'Agent changed product', reason: 'No policy' }), /Agent product approval/);
});

test('feature work requires active product context and approved change scope', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack());
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human, input: { feature: 'login', changesBehavior: true, changeScope: 'login.authentication' } });
  await engine.decideNode({ runId: run.id, nodeId: 'route', actor: human, outcome: 'minor', reason: 'Update design' });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker }), /Product context unresolved/);
  const old = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Password only', reason: 'Original constraint' });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker, productDecisionRefs: [old.id], approvedChangeDecisionId: old.id }), /approved superseding/);
  const change = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Passkeys with fallback', reason: 'Approved change', supersedes: old.id, changeScope: ['login.authentication'] });
  await engine.submitNode({ runId: run.id, nodeId: 'minor', actor: maker, productDecisionRefs: [change.id], approvedChangeDecisionId: change.id });
  assert.equal((await engine.getRun(run.id)).nodeStates.minor.status, 'completed');
});

test('gate rework restarts plan and invalidates old implementation evidence', async () => {
  const g = {
    id: 'implementation', version: '1', start: 'plan',
    nodes: [
      { id: 'plan', type: 'task', role: 'maker' },
      { id: 'build', type: 'task', role: 'maker' },
      { id: 'test', type: 'task', role: 'reviewer', independentOf: ['build'] },
      { id: 'gate', type: 'decision', role: 'owner', decisionType: 'route', reworkTarget: 'plan', maxReworks: 1 },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'plan', to: 'build' }, { from: 'build', to: 'test' }, { from: 'test', to: 'gate' }, { from: 'gate', to: 'end', when: 'accept' }],
  };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'implementation', actor: human });
  const execute = async (version) => {
    await engine.submitNode({ runId: run.id, nodeId: 'plan', actor: maker, output: { version } });
    await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ id: 'code', version }] });
    await engine.submitNode({ runId: run.id, nodeId: 'test', actor: reviewer, evidence: [{ artifactId: 'code', version }] });
  };
  await execute('v1');
  await engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'rework', reason: 'Test coverage inadequate' });
  let current = await engine.getRun(run.id);
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['plan']);
  assert.equal(current.nodeStates.test.evidence, undefined);
  assert.equal(current.nodeStates.test.attempts[0].evidence[0].version, 'v1');
  await execute('v2');
  await engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'rework', reason: 'Still inadequate' });
  current = await engine.getRun(run.id);
  assert.equal(current.status, 'paused');
  await assert.rejects(engine.resumeRun({ runId: run.id, actor: human, reason: 'Continue' }), /Pending human/);
  await engine.resolveReworkLimit({ runId: run.id, actor: human, outcome: 'continue', reason: 'One final attempt' });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['plan']);
});

test('parallel callbacks use revision CAS and duplicate callback takes one effect', async () => {
  const both = { ...graph, edges: graph.edges.map((edge) => edge.from === 'route' ? { from: edge.from, to: edge.to, when: 'both' } : edge) };
  const shared = new MemoryStore(), first = new GraphEngine({ store: shared }), second = new GraphEngine({ store: shared });
  await first.registerPack(pack('1', both));
  const run = await first.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human });
  await first.decideNode({ runId: run.id, nodeId: 'route', actor: human, outcome: 'both', reason: 'Compare' });
  await Promise.all([
    first.submitNode({ runId: run.id, nodeId: 'minor', actor: maker, idempotencyKey: 'minor-event' }),
    second.submitNode({ runId: run.id, nodeId: 'major', actor: maker, idempotencyKey: 'major-event' }),
  ]);
  assert.deepEqual((await second.getReadyNodes(run.id)).map((node) => node.id), ['join']);
  const [a, b] = await Promise.all([
    first.submitNode({ runId: run.id, nodeId: 'join', actor: human, idempotencyKey: 'join-event' }),
    second.submitNode({ runId: run.id, nodeId: 'join', actor: human, idempotencyKey: 'join-event' }),
  ]);
  assert.deepEqual(a, b);
  assert.equal((await first.getRun(run.id)).nodeStates.join.attempts.length, 1);
  await assert.rejects(second.submitNode({ runId: run.id, nodeId: 'join', actor: maker, idempotencyKey: 'join-event' }), /Idempotency key reused/);
});

test('gate evidence must bind every current candidate version after rework', async () => {
  const g = { id: 'candidate', version: '1', start: 'build', nodes: [
    { id: 'build', type: 'task', role: 'maker' },
    { id: 'gate', type: 'decision', role: 'owner', decisionType: 'acceptance', candidateNodes: ['build'], reworkTarget: 'build' },
    { id: 'end', type: 'end' },
  ], edges: [{ from: 'build', to: 'gate' }, { from: 'gate', to: 'end', when: 'accept' }] };
  const p = { id: 'adlc', version: '1', graphs: [g], decisionRules: [{ type: 'acceptance', mode: 'manual', allowedKinds: ['human'], requiredEvidence: ['test_report'] }] };
  const engine = new GraphEngine(); await engine.registerPack(p);
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'candidate', actor: human });
  const report = (version) => [{ kind: 'test_report', subjectRefs: [{ artifactId: 'code', version }] }];
  await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ id: 'code', version: 'v1' }] });
  await engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'rework', reason: 'Need fix', evidence: report('v1') });
  await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ id: 'code', version: 'v2' }] });
  await assert.rejects(engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'accept', reason: 'Old report', evidence: report('v1') }), /current candidate/);
  await engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'accept', reason: 'Retested', evidence: report('v2') });
  assert.equal((await engine.listDecisions({ runId: run.id })).length, 2);
});

test('invalidation preserves human conflict wait and self review uses latest revision', async () => {
  const g = { id: 'work', version: '1', start: 'work', nodes: [{ id: 'work', type: 'task', role: 'maker', review: { supervisorRole: 'reviewer' } }, { id: 'end', type: 'end' }], edges: [{ from: 'work', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'work', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: maker, artifacts: [{ id: 'code', version: 'v1' }] });
  await engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: maker, artifactVersion: 'v2', revisedArtifact: { id: 'code', version: 'v2' }, findings: [{ severity: 'P1', status: 'open' }] });
  await assert.rejects(engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: maker, artifactVersion: 'v1', findings: [] }), /current artifact/);
  await assert.rejects(engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: maker, artifactVersion: 'v2', findings: [] }), /revised artifact version/);
  const conflict = await engine.openConflict({ runId: run.id, actor: maker, positions: { cpo: {}, cto: {} }, unresolved: ['scope'], reason: 'Disagreement' });
  await engine.invalidateEvidence({ runId: run.id, nodeId: 'work', actor: human, reason: 'Candidate changed' });
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  await assert.rejects(engine.resumeRun({ runId: run.id, actor: human, reason: 'Bypass' }), /Unresolved/);
  await engine.resolveConflict({ runId: run.id, conflictId: conflict.id, actor: human, outcome: 'modify', reason: 'Settle' });
});

test('agent escalation pauses a decision until trusted human owner resolves it', async () => {
  const engine = new GraphEngine(); await engine.registerPack(pack());
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human });
  const agentOwner = { id: 'agent-owner', kind: 'agent', roles: ['owner'], executionId: 'agent-owner-exec' };
  await engine.decideNode({ runId: run.id, nodeId: 'route', actor: agentOwner, outcome: 'human', reason: 'Cannot settle scope' });
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  assert.deepEqual(await engine.getReadyNodes(run.id), []);
  await assert.rejects(engine.resumeRun({ runId: run.id, actor: human, reason: 'Bypass' }), /Pending human/);
  await assert.rejects(engine.resolveReworkLimit({ runId: run.id, actor: human, outcome: 'stop', reason: 'Wrong gate' }), /No rework limit/);
  await assert.rejects(engine.resolveHumanGate({ runId: run.id, nodeId: 'route', actor: agentOwner, outcome: 'minor', reason: 'Fake approval' }), /Human owner/);
  await engine.resolveHumanGate({ runId: run.id, nodeId: 'route', actor: { ...human, roles: ['owner', 'human-owner'] }, outcome: 'minor', reason: 'Proceed with minor' });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['minor']);
  assert.equal((await engine.listDecisions({ runId: run.id })).length, 2);
});

test('rework-required terminal never becomes accepted completion', async () => {
  const g = { id: 'terminal', version: '1', start: 'end', nodes: [{ id: 'end', type: 'end', output: 'rework_required' }], edges: [] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'terminal', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'end', actor: human });
  assert.equal((await engine.getRun(run.id)).status, 'rework_required');
});

test('host configuration decisions are durable and idempotent outside runs', async () => {
  const engine = new GraphEngine();
  const params = { type: 'role-binding', status: 'approved', outcome: 'Bind maker to agent-1', reason: 'Provisioned role', actor: human, issueId: 'issue-1', affectedRefs: ['maker'], idempotencyKey: 'config-1' };
  const record = await engine.recordDecision(params);
  assert.equal((await engine.recordDecision(params)).id, record.id);
  assert.equal((await engine.listDecisions()).length, 1);
  await assert.rejects(engine.recordDecision({ ...params, actor: maker }), /Idempotency key reused/);
});

test('Pack required inputs and declared outputs gate dispatch on versioned artifacts', async () => {
  const g = { id: 'contract', version: '1', start: 'plan', nodes: [
    { id: 'plan', type: 'task', role: 'maker', requiredInputs: ['versioned_requirement', 'product_decision_refs'], produces: ['implementation_plan'] },
    { id: 'build', type: 'task', role: 'maker', requiredInputs: ['implementation_plan'], produces: ['implementation_candidate'] },
    { id: 'end', type: 'end' },
  ], edges: [{ from: 'plan', to: 'build' }, { from: 'build', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const decision = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Use approved flow', reason: 'Product baseline' });
  await assert.rejects(engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'contract', actor: human, input: {} }), /Product feature/);
  await assert.rejects(engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'contract', actor: human,
    input: { feature: 'login', product_decision_refs: [decision.id] } }), /versioned_requirement/);
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'contract', actor: human,
    input: { feature: 'login', versioned_requirement: { id: 'req-1', version: 'v1' }, product_decision_refs: [decision.id] } });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'plan', actor: maker, artifacts: [{ id: 'plan-1', version: 'v1' }] }), /implementation_plan/);
  await engine.submitNode({ runId: run.id, nodeId: 'plan', actor: maker, artifacts: [{ kind: 'implementation_plan', id: 'plan-1', version: 'v1' }] });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['build']);
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [] }), /implementation_candidate/);
  await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ kind: 'implementation_candidate', id: 'code-1', version: 'v1' }] });
});

test('product references at run start must belong to approved active feature memory', async () => {
  const g = { id: 'feature', version: '1', start: 'work', nodes: [{ id: 'work', type: 'task', role: 'maker', requiredInputs: ['product_decision_refs'] }], edges: [] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const login = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Password flow', reason: 'Baseline' });
  const billing = await engine.recordProductDecision({ feature: 'billing', actor: human, outcome: 'Invoice flow', reason: 'Baseline' });
  const start = (input) => engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'feature', actor: human, input });
  await assert.rejects(start({ product_decision_refs: [login.id] }), /Product feature/);
  await assert.rejects(start({ feature: 'login', product_decision_refs: ['missing-id'] }), /not approved and active/);
  await assert.rejects(start({ feature: 'login', product_decision_refs: [billing.id] }), /not approved and active/);
  await assert.rejects(start({ feature: 'login', product_decision_refs: [login.id], productDecisionRefs: [billing.id] }), /aliases disagree/);
  const run = await start({ feature: 'login', product_decision_refs: [login.id] });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: maker });
  assert.equal((await engine.getRun(run.id)).status, 'completed');
});

test('canonical fingerprints survive object key reordering while rejecting changed requests and packs', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store });
  const p = pack(); await engine.registerPack(p);
  const reorderedPack = { decisionRules: p.decisionRules.map((rule) => ({ ...rule })), graphs: p.graphs, version: p.version, id: p.id };
  await engine.registerPack(reorderedPack);
  const first = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human,
    input: { featureTag: 'alpha', settings: { two: 2, one: 1 } }, idempotencyKey: 'canonical-start' });
  const replay = await engine.startRun({ graphId: 'design', packVersion: '1', packId: 'adlc', actor: { roles: [...human.roles], kind: 'human', id: human.id, executionId: human.executionId },
    input: { settings: { one: 1, two: 2 }, featureTag: 'alpha' }, idempotencyKey: 'canonical-start' });
  assert.equal(replay.id, first.id);
  await assert.rejects(engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'design', actor: human,
    input: { settings: { one: 1, two: 3 }, featureTag: 'alpha' }, idempotencyKey: 'canonical-start' }), /Idempotency key reused/);
  await assert.rejects(engine.registerPack({ ...p, decisionRules: [...p.decisionRules, { type: 'changed', mode: 'manual' }] }), /immutable/);
});

test('human retry advances a failed dispatch attempt and invalidates downstream work', async () => {
  const g = { id: 'retry', version: '1', start: 'plan', nodes: [
    { id: 'plan', type: 'task', role: 'maker' }, { id: 'build', type: 'task', role: 'maker' },
    { id: 'verify', type: 'task', role: 'reviewer' }, { id: 'end', type: 'end' },
  ], edges: [{ from: 'plan', to: 'build' }, { from: 'build', to: 'verify' }, { from: 'verify', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'retry', actor: human });
  await assert.rejects(engine.retryNode({ runId: run.id, nodeId: 'plan', actor: maker, reason: 'Agent failed' }), /human owner/);
  const retried = await engine.retryNode({ runId: run.id, nodeId: 'plan', actor: human, reason: 'Heartbeat failed', idempotencyKey: 'plan-retry' });
  assert.equal(retried.nextAttempt, 2);
  assert.equal((await engine.retryNode({ runId: run.id, nodeId: 'plan', actor: human, reason: 'Heartbeat failed', idempotencyKey: 'plan-retry' })).nextAttempt, 2);
  assert.equal((await engine.getRun(run.id)).nodeStates.plan.attempts[0].status, 'abandoned_before_submission');
  await engine.submitNode({ runId: run.id, nodeId: 'plan', actor: maker, artifacts: [{ id: 'plan', version: 'v1' }] });
  await engine.submitNode({ runId: run.id, nodeId: 'build', actor: maker, artifacts: [{ id: 'candidate', version: 'v1' }] });
  const again = await engine.retryNode({ runId: run.id, nodeId: 'plan', actor: human, reason: 'Build invalidated candidate' });
  assert.equal(again.nextAttempt, 3);
  const state = await engine.getRun(run.id);
  assert.equal(state.nodeStates.plan.status, 'pending');
  assert.equal(state.nodeStates.build.status, 'pending');
  assert.equal(state.nodeStates.build.artifacts, undefined);
  assert.equal(state.nodeStates.plan.attempts[1].artifacts[0].id, 'plan');
  assert.equal(state.nodeStates.plan.attempts[1].supersededByRetry.reason, 'Build invalidated candidate');
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['plan']);
  const conflict = await engine.openConflict({ runId: run.id, actor: maker, positions: { cpo: 'go', cto: 'stop' }, unresolved: ['risk'], reason: 'Disagreement' });
  await assert.rejects(engine.retryNode({ runId: run.id, nodeId: 'plan', actor: human, reason: 'Bypass conflict' }), /without unresolved human decisions/);
  await engine.resolveConflict({ runId: run.id, conflictId: conflict.id, actor: human, outcome: 'revise', reason: 'Resolve risk' });
  assert.equal((await engine.getAudit({ runId: run.id })).filter((event) => event.kind === 'node.retry_requested').length, 2);
});

test('cross-Graph handoff accepts pinned artifact identity and composite candidate', async () => {
  const g = { id: 'handoff', version: '1', start: 'freeze', nodes: [{ id: 'freeze', type: 'task', role: 'maker', requiredInputs: ['final_design_identity', 'implementation_candidate'] }], edges: [] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'handoff', actor: human, input: {
    final_design_identity: { artifactId: 'design-v2', version: 'v2', decisionId: 'decision-1' },
    implementation_candidate: { artifacts: [{ artifactId: 'backend-v3', version: 'v3' }, { artifactId: 'frontend-v4', version: 'v4' }], decisionId: 'decision-2' },
  } });
  assert.deepEqual((await engine.getReadyNodes(run.id)).map((node) => node.id), ['freeze']);
});
