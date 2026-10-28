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

test('explicit work choices bind to the current actor and attempt, with sourced evidence', async () => {
  const g = { id: 'trace', version: '1', start: 'make', nodes: [
    { id: 'make', type: 'task', role: 'maker', decisionTraceRequired: true, produces: ['design'] },
    { id: 'end', type: 'end' },
  ], edges: [{ from: 'make', to: 'end' }] };
  const engine = new GraphEngine(); await engine.registerPack(pack('1', g));
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'trace', actor: human, input: { brief: 'Navigation refresh' } });
  const args = { runId: run.id, nodeId: 'make', actor: maker, category: 'engineering', question: 'Which layout?',
    options: [{ id: 'rule', label: 'Apply the pinned node contract' }], outcome: 'rule', reason: 'Brief is explicit',
    evidence: [{ kind: 'brief', summary: 'Navigation refresh', sourceRef: { kind: 'run_input', key: 'brief' } }] };
  await assert.rejects(engine.recordWorkDecision(args), /ruleRef/);
  await assert.rejects(engine.recordWorkDecision({ ...args, ruleRef: 'node:make', evidence: [{ kind: 'brief', summary: 'Missing source' }] }), /sourceRef/);
  const chosen = await engine.recordWorkDecision({ ...args, ruleRef: 'node:make', idempotencyKey: 'choice-1' });
  assert.equal((await engine.recordWorkDecision({ ...args, ruleRef: 'node:make', idempotencyKey: 'choice-1' })).id, chosen.id);
  const artifact = [{ kind: 'design', id: 'design-1', version: 'v1' }];
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker, artifacts: artifact }), /Decision Records/);
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: { ...maker, executionId: 'other-exec' }, artifacts: artifact, decisionIds: [chosen.id] }), /does not belong/);
  await engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker, artifacts: artifact, decisionIds: [chosen.id] });
  const state = await engine.getRun(run.id);
  assert.deepEqual(state.nodeStates.make.attempts[0].decisionIds, [chosen.id]);
  assert.equal((await engine.listDecisions({ runId: run.id })).find((item) => item.id === chosen.id).attemptNumber, 1);
  await engine.retryNode({ runId: run.id, nodeId: 'make', actor: human, reason: 'Replace draft' });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker,
    artifacts: [{ kind: 'design', id: 'design-2', version: 'v2' }], decisionIds: [chosen.id] }), /current node attempt/);
});

test('feature work records impact and a proposed replacement before behavior changes', async () => {
  const g = { id: 'feature-trace', version: '1', start: 'make', nodes: [
    { id: 'make', type: 'task', role: 'maker', decisionTraceRequired: true, requiredInputs: ['product_decision_refs'] },
  ], edges: [] };
  const engine = new GraphEngine(); await engine.registerPack({ ...pack('1', g),
    policies: { productMemory: { proposalRequired: true } },
    decisionRules: [...rules, { type: 'product-decision-replacement', mode: 'manual', allowedKinds: ['human'] }] });
  const baseline = await engine.recordProductDecision({ feature: 'login', actor: human, outcome: 'Password login', reason: 'Established behavior' });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: g.id, actor: human,
    input: { feature: 'login', product_decision_refs: [baseline.id], brief: 'Add passkey' } });
  const decisionArgs = { runId: run.id, nodeId: 'make', actor: maker, category: 'product', question: 'Add passkey?',
    options: [{ id: 'yes', label: 'Add passkey' }, { id: 'no', label: 'Keep password' }], outcome: 'yes', reason: 'User request',
    evidence: [{ kind: 'brief', summary: 'Passkey requested', sourceRef: { kind: 'run_input', key: 'brief' } }] };
  await assert.rejects(engine.recordWorkDecision(decisionArgs), /behavior impact/);
  const uncertain = await engine.recordWorkDecision({ ...decisionArgs, behaviorImpact: 'unknown' });
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker, decisionIds: [uncertain.id] }), /impact is unresolved/);
  const proposal = await engine.recordProductDecision({ runId: run.id, feature: 'login', actor: human, status: 'proposed',
    outcome: 'Passkey with password fallback', reason: 'Preserve fallback', supersedes: baseline.id, changeScope: ['login.authentication'] });
  await assert.rejects(engine.recordProductDecision({ runId: run.id, feature: 'billing', actor: human, status: 'proposed',
    outcome: 'Unrelated invoice change', reason: 'Wrong feature' }), /does not match its pinned context/);
  await assert.rejects(engine.recordProductDecision({ runId: run.id, feature: 'login', actor: human,
    outcome: 'Passkey with password fallback', reason: 'Approve', supersedes: baseline.id, changeScope: ['login.authentication'] }), /matching proposal/);
  await assert.rejects(engine.recordProductDecision({ runId: run.id, feature: 'login', actor: human,
    outcome: 'Passkey with password fallback', reason: 'Wrong scope', supersedes: baseline.id, proposalId: proposal.id,
    changeScope: ['login.authorization'] }), /does not match/);
  const approved = await engine.recordProductDecision({ runId: run.id, feature: 'login', actor: human,
    outcome: 'Passkey with password fallback', reason: 'Approve', supersedes: baseline.id, proposalId: proposal.id,
    changeScope: ['login.authentication'] });
  assert.equal(approved.proposalId, proposal.id);
  const change = await engine.recordWorkDecision({ ...decisionArgs, behaviorImpact: 'changes', changeScope: 'login.authentication', productDecisionRefs: [approved.id] });
  assert.equal(change.feature, 'login');
  assert.ok((await engine.listDecisions({ feature: 'login' })).some((item) => item.id === change.id));
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker,
    decisionIds: [change.id], productDecisionRefs: [approved.id] }), /approved superseding/);
  await engine.submitNode({ runId: run.id, nodeId: 'make', actor: maker, decisionIds: [change.id],
    productDecisionRefs: [approved.id], approvedChangeDecisionId: approved.id });
  assert.deepEqual((await engine.getProductMemory('login')).active.map((item) => item.id), [approved.id]);
});

test('an explicit choice survives restart and its callback key cannot be reassigned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-choice-'));
  try {
    const path = join(dir, 'state.json');
    const first = new GraphEngine({ store: new FileStore(path) });
    const g = { id: 'persist-choice', version: '1', start: 'make', nodes: [
      { id: 'make', type: 'task', role: 'maker', decisionTraceRequired: true },
    ], edges: [] };
    await first.registerPack(pack('1', g));
    const run = await first.startRun({ packId: 'adlc', packVersion: '1', graphId: g.id, actor: human,
      input: { brief: 'Ship documented choice' } });
    const args = { runId: run.id, nodeId: 'make', actor: maker, category: 'process', question: 'Ship?',
      options: [{ id: 'ship', label: 'Use approved process' }], outcome: 'ship', reason: 'Pinned task calls for it',
      ruleRef: 'node:make', evidence: [{ kind: 'brief', summary: 'Task brief', sourceRef: { kind: 'run_input', key: 'brief' } }],
      idempotencyKey: 'choice-before-restart' };
    const choice = await first.recordWorkDecision(args);
    const restarted = new GraphEngine({ store: new FileStore(path) });
    assert.equal((await restarted.recordWorkDecision(args)).id, choice.id);
    await assert.rejects(restarted.recordWorkDecision({ ...args, outcome: 'other' }), /Idempotency key reused/);
    await restarted.submitNode({ runId: run.id, nodeId: 'make', actor: maker, decisionIds: [choice.id] });
    assert.equal((await restarted.getRun(run.id)).status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('strict CPO and CTO conflict retains signed positions and negotiation through human resolution', async () => {
  const g = { id: 'conflict', version: '1', start: 'cpo-position', nodes: [
    { id: 'cpo-position', type: 'task', role: 'cpo' }, { id: 'cto-position', type: 'task', role: 'cto-caio' },
    { id: 'gate', type: 'decision', decisionType: 'route' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'cpo-position', to: 'cto-position' }, { from: 'cto-position', to: 'gate' },
      { from: 'gate', to: 'end', when: 'accept' }] };
  const engine = new GraphEngine(); await engine.registerPack({ ...pack('1', g), policies: { cpoCtoConflict: { protocolVersion: 2 } } });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: g.id, actor: human, input: { brief: 'Ship prototype' } });
  const cpo = { id: 'cpo-agent', kind: 'agent', roles: ['cpo'], executionId: 'cpo-run' };
  const cto = { id: 'cto-agent', kind: 'agent', roles: ['cto-caio'], executionId: 'cto-run' };
  const evidence = [{ kind: 'brief', summary: 'Prototype scope', sourceRef: { kind: 'run_input', key: 'brief' } }];
  const p1 = await engine.recordConflictPosition({ runId: run.id, nodeId: 'cpo-position', actor: cpo, side: 'cpo', stance: 'go',
    reason: 'Learn now', dimensions: { scope: 'Pilot only', timeline: 'This sprint' }, nonNegotiables: ['Pilot users only'], evidence });
  await engine.submitNode({ runId: run.id, nodeId: 'cpo-position', actor: cpo });
  const ctoPosition = { runId: run.id, nodeId: 'cto-position', actor: cto, side: 'cto-caio', stance: 'block',
    reason: 'Risk', dimensions: { risk: 'No threat model' }, nonNegotiables: ['Security check'], evidence };
  const stale = await engine.recordConflictPosition(ctoPosition);
  await engine.submitNode({ runId: run.id, nodeId: 'cto-position', actor: cto });
  await engine.retryNode({ runId: run.id, nodeId: 'cto-position', actor: human, reason: 'Risk data was invalidated' });
  const dossier = { runId: run.id, nodeId: 'gate', actor: cpo,
    positionDecisionIds: { cpo: p1.id, cto: stale.id },
    negotiation: [{ dimension: 'risk', issue: 'Threat model missing', proposal: 'Pilot with review',
      cpoResponse: 'Accept review', ctoResponse: 'Need explicit owner approval', evidence }],
    unresolved: [{ dimension: 'risk', issue: 'Residual risk', options: ['pilot', 'wait'] }],
    options: [{ id: 'pilot', label: 'Continue limited pilot', disposition: 'continue' },
      { id: 'wait', label: 'Stop pending review', disposition: 'stop' }], reason: 'No agreement' };
  await assert.rejects(engine.openConflict(dossier), /stale/);
  const p2 = await engine.recordConflictPosition({ ...ctoPosition,
    reason: 'Risk', dimensions: { risk: 'No threat model' }, nonNegotiables: ['Security check'], evidence });
  await engine.submitNode({ runId: run.id, nodeId: 'cto-position', actor: cto });
  const conflict = await engine.openConflict({ ...dossier, positionDecisionIds: { cpo: p1.id, cto: p2.id } });
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  assert.deepEqual((await engine.getWorkItems(run.id))[0].outcomes, ['pilot', 'wait']);
  await assert.rejects(engine.resolveConflict({ runId: run.id, conflictId: conflict.id, actor: human,
    outcome: 'invented', reason: 'No' }), /recorded option/);
  const resolved = await engine.resolveConflict({ runId: run.id, conflictId: conflict.id, actor: human,
    outcome: 'pilot', reason: 'Limited exposure', evidence });
  assert.equal(resolved.decision.evidence.at(-1).kind, 'conflict_dossier');
  assert.equal(resolved.decision.evidence.at(-1).positionDecisionIds.cpo, p1.id);
  assert.equal((await engine.getRun(run.id)).status, 'running');
  assert.deepEqual(resolved.decision.effect, { kind: 'continue', gateNodeId: 'gate',
    requiredEvidence: { kind: 'conflict_resolution', decisionId: resolved.decision.id } });
  await assert.rejects(engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human,
    outcome: 'accept', reason: 'Proceed' }), /human conflict resolution/);
  await engine.decideNode({ runId: run.id, nodeId: 'gate', actor: human, outcome: 'accept',
    reason: 'Proceed with owner-bound mitigation', evidence: [{ kind: 'conflict_resolution', decisionId: resolved.decision.id }] });
});

test('strict human conflict rework resets the named upstream stage, while stop ends the run', async () => {
  const g = { id: 'conflict-effects', version: '1', start: 'cpo', nodes: [
    { id: 'cpo', type: 'task', role: 'cpo' }, { id: 'cto', type: 'task', role: 'cto-caio' },
    { id: 'gate', type: 'decision', decisionType: 'route', maxReworks: 1 }, { id: 'end', type: 'end' }],
    edges: [{ from: 'cpo', to: 'cto' }, { from: 'cto', to: 'gate' }, { from: 'gate', to: 'end', when: 'accept' }] };
  const engine = new GraphEngine(); await engine.registerPack({ ...pack('1', g), policies: { cpoCtoConflict: { protocolVersion: 2 } } });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: g.id, actor: human, input: { brief: 'Bounded pilot' } });
  const cpo = { id: 'cpo', kind: 'agent', roles: ['cpo'], executionId: 'cpo-exec' };
  const cto = { id: 'cto', kind: 'agent', roles: ['cto-caio'], executionId: 'cto-exec' };
  const evidence = [{ kind: 'brief', summary: 'Pilot brief', sourceRef: { kind: 'run_input', key: 'brief' } }];
  const recordPair = async () => {
    const first = await engine.recordConflictPosition({ runId: run.id, nodeId: 'cpo', actor: cpo, side: 'cpo', stance: 'go',
      reason: 'Value', dimensions: { scope: 'Pilot' }, evidence });
    await engine.submitNode({ runId: run.id, nodeId: 'cpo', actor: cpo });
    const second = await engine.recordConflictPosition({ runId: run.id, nodeId: 'cto', actor: cto, side: 'cto-caio', stance: 'block',
      reason: 'Risk', dimensions: { risk: 'Untested' }, evidence });
    await engine.submitNode({ runId: run.id, nodeId: 'cto', actor: cto });
    return { cpo: first.id, cto: second.id };
  };
  const open = (positionDecisionIds) => engine.openConflict({ runId: run.id, nodeId: 'gate', actor: cto,
    positionDecisionIds, negotiation: [{ dimension: 'risk', issue: 'Coverage', proposal: 'Verify before launch',
      cpoResponse: 'Agree', ctoResponse: 'Needs owner', evidence }],
    unresolved: [{ dimension: 'risk', issue: 'Exposure', options: ['rework', 'stop'] }],
    options: [{ id: 'redo', label: 'Replan', disposition: 'rework', targetNodeId: 'cpo' },
      { id: 'halt', label: 'Stop', disposition: 'stop' }], reason: 'No agreement' });
  const firstConflict = await open(await recordPair());
  assert.deepEqual((await engine.getWorkItems(run.id))[0].outcomes, ['redo', 'halt']);
  const redone = await engine.resolveConflict({ runId: run.id, conflictId: firstConflict.id, actor: human,
    outcome: 'redo', reason: 'Replan with risk controls', evidence });
  assert.deepEqual(redone.decision.effect, { kind: 'rework', targetNodeId: 'cpo' });
  let state = await engine.getRun(run.id);
  assert.equal(state.status, 'running');
  assert.equal(state.nodeStates.cpo.status, 'pending');
  assert.equal(state.nodeStates.cto.status, 'pending');
  assert.equal(state.nodeStates.cpo.attempts.length, 1);
  assert.equal(state.nodeStates.gate.attempts.length, 1);
  assert.equal(state.nodeStates.gate.attempts[0].decisionId, redone.decision.id);
  const secondConflict = await open(await recordPair());
  const halted = await engine.resolveConflict({ runId: run.id, conflictId: secondConflict.id, actor: human,
    outcome: 'halt', reason: 'Do not ship', evidence });
  assert.deepEqual(halted.decision.effect, { kind: 'stop' });
  state = await engine.getRun(run.id);
  assert.equal(state.status, 'stopped');
});

test('opt-in final selection accepts one current frozen shortlist candidate only', async () => {
  const selectionGraph = { id: 'final-selection', version: '2', start: 'freeze-a', nodes: [
    { id: 'freeze-a', type: 'task', role: 'maker' },
    { id: 'freeze-b', type: 'task', role: 'maker' },
    { id: 'shortlist', type: 'task', role: 'maker' },
    { id: 'final', type: 'decision', role: 'owner', decisionType: 'route',
      selection: { sourceNodeId: 'shortlist', outputKey: 'selectedFinalists', frozenNodeIds: ['freeze-a', 'freeze-b'] } },
    { id: 'done', type: 'end' },
  ], edges: [
    { from: 'freeze-a', to: 'freeze-b' }, { from: 'freeze-b', to: 'shortlist' },
    { from: 'shortlist', to: 'final' }, { from: 'final', to: 'done', when: 'accept' },
  ] };
  const engine = new GraphEngine();
  await engine.registerPack(pack('2', selectionGraph));
  const frozen = [
    { kind: 'frozen_visual_a', id: 'design-a', version: 'v2' },
    { kind: 'frozen_visual_b', id: 'design-b', version: 'v3' },
  ];
  const start = async (shortlist, packVersion = '2') => {
    const run = await engine.startRun({ packId: 'adlc', packVersion, graphId: 'final-selection', actor: human });
    await engine.submitNode({ runId: run.id, nodeId: 'freeze-a', actor: maker, artifacts: [frozen[0]] });
    await engine.submitNode({ runId: run.id, nodeId: 'freeze-b', actor: maker, artifacts: [frozen[1]] });
    await engine.submitNode({ runId: run.id, nodeId: 'shortlist', actor: maker,
      output: { selectedFinalists: shortlist }, artifacts: [{ kind: 'finalist_shortlist', id: 'list', version: 'v1' }] });
    return run.id;
  };
  const refs = frozen.map((item) => ({ artifactId: item.id, version: item.version }));
  const runId = await start(refs.slice(0, 1));
  const decide = (artifacts) => engine.decideNode({ runId, nodeId: 'final', actor: human,
    outcome: 'accept', reason: 'Selected against documented comparison', artifacts });
  await assert.rejects(decide(frozen), /exactly one/);
  await assert.rejects(decide([frozen[1]]), /current shortlist/);
  await assert.rejects(decide([{ ...frozen[0], version: 'v1' }]), /current shortlist/);
  assert.equal((await engine.listDecisions({ runId })).length, 0);
  const selected = await decide([frozen[0]]);
  assert.deepEqual(selected.decision.artifacts.map((item) => [item.id, item.version]), [['design-a', 'v2']]);
  assert.equal((await engine.getRun(runId)).nodeStates.final.status, 'completed');

  const staleRunId = await start([{ artifactId: 'design-a', version: 'v1' }]);
  await assert.rejects(engine.decideNode({ runId: staleRunId, nodeId: 'final', actor: human,
    outcome: 'accept', reason: 'Stale shortlist', artifacts: [{ ...frozen[0], version: 'v1' }] }), /current frozen candidate/);
  const humanRunId = await start(refs);
  await engine.escalateNode({ runId: humanRunId, nodeId: 'final', actor: human, reason: 'Owner selection required' });
  await assert.rejects(engine.resolveHumanGate({ runId: humanRunId, nodeId: 'final', actor: human,
    outcome: 'accept', reason: 'Choose both', artifacts: frozen }), /exactly one/);
  const resolved = await engine.resolveHumanGate({ runId: humanRunId, nodeId: 'final', actor: human,
    outcome: 'accept', reason: 'Choose B after comparison', artifacts: [frozen[1]] });
  assert.deepEqual(resolved.decision.artifacts.map((item) => item.id), ['design-b']);

  const legacyGraph = { ...selectionGraph, version: '1', nodes: selectionGraph.nodes.map((node) => {
    const { selection: _selection, ...legacyNode } = node;
    return legacyNode;
  }) };
  await engine.registerPack(pack('3', legacyGraph));
  const legacyRunId = await start(refs, '3');
  const legacy = await engine.decideNode({ runId: legacyRunId, nodeId: 'final', actor: human,
    outcome: 'accept', reason: 'Pinned legacy graph', artifacts: frozen });
  assert.equal(legacy.decision.artifacts.length, 2);
});
