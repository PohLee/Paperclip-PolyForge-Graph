import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';

const human = { id: 'owner', kind: 'human', roles: ['reviewer', 'human-owner'] };
const agent = { id: 'checker', kind: 'agent', roles: ['reviewer'], executionId: 'checker-1' };
const candidate = { id: 'CODE', version: 'v1' };
const refs = [{ artifactId: 'CODE', version: 'v1' }];
const matrix = (result = 'pass') => ({ candidateRefs: refs, criteria: [{ id: 'AC-1', result,
  evidence: result === 'unverified' ? [] : [{ kind: 'command', ref: 'artifact://test.log', observed: result }],
  ...(result !== 'pass' ? { gap: 'Missing staging proof' } : {}) }] });
const variants = {
  proof: { inputContracts: ['acceptance-criteria'], output: 'acceptance-matrix', contract: 'acceptance-proof', kind: 'acceptance_matrix',
    input: { implementation_candidate: candidate, acceptance_criteria: [{ id: 'AC-1', description: 'Saves a draft', requirementIds: ['REQ-1'] }] }, outputValue: matrix() },
  architecture: { inputContracts: [], output: 'architecture-baseline', contract: 'architecture-approval', kind: 'architecture_baseline',
    input: { system_id: 'orders' }, outputValue: { systemId: 'orders', summary: 'Order API', diagram: 'API -> store', implementationStatus: 'proposed',
      invariants: [{ id: 'INV-001', rule: 'Single writer', enforcement: 'Scoped credentials', proof: 'ACL check', status: 'active' }] } },
  delivery: { inputContracts: ['delivery-target'], output: 'delivery-report', contract: 'delivery-readiness', kind: 'delivery_report',
    input: { implementation_candidate: candidate, delivery_target: { repository: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/1', headSha: 'a'.repeat(40) }, required_checks: ['test'], required_approvals: 1 } }
};
variants.delivery.outputValue = { candidateRefs: refs, prUrl: variants.delivery.input.delivery_target.prUrl, headSha: 'a'.repeat(40), state: 'open',
  checks: [{ name: 'test', headSha: 'a'.repeat(40), sourceRef: 'https://ci/check/1', result: 'pass' }],
  approvals: [{ actorId: 'reviewer', headSha: 'a'.repeat(40), sourceRef: 'https://pr/review/1' }],
  review: { headSha: 'a'.repeat(40), sourceRef: 'artifact://review/1', verdict: 'approve' }, unresolvedFindings: 0, mergeable: true };

function fixturePack(type, reviewed = false) {
  const v = variants[type];
  return { id: type, version: '1', decisionRules: [
    { type: 'gate', mode: 'autonomous', allowedKinds: ['agent', 'human'], allowedRoles: ['reviewer'], requiredEvidence: ['report'] },
    { type: 'review', mode: 'autonomous', allowedKinds: ['agent', 'human'], allowedRoles: ['reviewer'], requiredEvidence: ['report'] }
  ], graphs: [{ id: 'main', version: '1', start: 'source', inputContracts: v.inputContracts, nodes: [
    { id: 'source', type: 'task', produces: [v.kind], outputContract: v.output, ...(reviewed ? { review: { supervisorRole: 'reviewer' } } : {}) },
    { id: 'gate', type: 'decision', role: 'reviewer', decisionType: 'gate', candidateNodes: ['source'], candidateKinds: [v.kind], decisionContract: { type: v.contract, sourceNode: 'source' } },
    { id: 'end', type: 'end' }
  ], edges: [{ from: 'source', to: 'gate' }, { from: 'gate', to: 'end', when: ['accept', 'ready', 'merged', 'hold'] }] }] };
}
async function fixture(type = 'proof', { engine = new GraphEngine(), input, reviewed = false } = {}) {
  const pack = fixturePack(type, reviewed); await engine.registerPack(pack);
  const run = await engine.startRun({ packId: type, packVersion: '1', graphId: 'main', mode: 'autonomous', actor: human, input: input ?? variants[type].input });
  const artifact = { id: `${type}-${run.id}`, version: 'v1', kind: variants[type].kind };
  const evidence = [{ kind: 'report', subjectRefs: [{ artifactId: artifact.id, version: 'v1' }] }];
  return { engine, run, artifact, evidence,
    submit: output => engine.submitNode({ runId: run.id, nodeId: 'source', actor: agent, artifacts: [artifact], output }),
    decide: (outcome = 'accept', actor = agent, extras = []) => engine.decideNode({ runId: run.id, nodeId: 'gate', actor, outcome, reason: 'Review evidence', evidence: [...evidence, ...extras] }) };
}

test('acceptance input and exact criterion coverage/proof/candidate identity are enforced', async () => {
  await assert.rejects(fixture('proof', { input: {} }), /acceptance_criteria/);
  const f = await fixture();
  const missing = matrix(); missing.criteria = [];
  const duplicate = matrix(); duplicate.criteria.push(duplicate.criteria[0]);
  const noProof = matrix(); noProof.criteria[0].evidence = [];
  const stale = matrix(); stale.candidateRefs = [{ artifactId: 'CODE', version: 'old' }];
  for (const output of [missing, duplicate, noProof, stale]) await assert.rejects(f.submit(output));
  await f.submit(matrix()); await f.decide();
});

test('failed criterion blocks both agent and human acceptance', async () => {
  const f = await fixture(); await f.submit(matrix('fail'));
  await assert.rejects(f.decide(), /Failed criterion/);
  await assert.rejects(f.decide('accept', human), /Failed criterion/);
});

test('unverified criterion needs a human exception bound to this exact matrix', async () => {
  const f = await fixture(); await f.submit(matrix('unverified'));
  const exception = { kind: 'acceptance_exception', criterionId: 'AC-1', reason: 'Staging down', risk: 'Persistence unverified', subjectRefs: f.evidence[0].subjectRefs };
  await assert.rejects(f.decide('accept', agent, [exception]), /human exception/);
  await assert.rejects(f.decide('accept', human), /exception reason/);
  await assert.rejects(f.decide('accept', human, [{ ...exception, subjectRefs: [{ artifactId: 'other', version: 'v1' }] }]), /exact current candidate/);
  await f.decide('accept', human, [exception]);
});

test('human escalation cannot bypass acceptance proof', async () => {
  const f = await fixture(); await f.submit(matrix('unverified'));
  await f.engine.escalateNode({ runId: f.run.id, nodeId: 'gate', actor: agent, reason: 'Need risk decision' });
  const args = { runId: f.run.id, nodeId: 'gate', actor: human, outcome: 'accept', reason: 'Human review', evidence: f.evidence };
  await assert.rejects(f.engine.resolveHumanGate(args), /exception reason/);
  await f.engine.resolveHumanGate({ ...args, evidence: [...f.evidence, { kind: 'acceptance_exception', criterionId: 'AC-1', reason: 'Explicit deferral', risk: 'Not yet tested', subjectRefs: f.evidence[0].subjectRefs }] });
});

test('contracted artifact cannot be revised without a new structured submission', async () => {
  const f = await fixture('proof', { reviewed: true }); await f.submit(matrix());
  await assert.rejects(f.engine.recordSelfReview({ runId: f.run.id, nodeId: 'source', actor: agent, artifactVersion: 'v2', revisedArtifact: { ...f.artifact, version: 'v2' } }), /immutable per attempt/);
  const reviewed = await f.engine.recordSelfReview({ runId: f.run.id, nodeId: 'source', actor: agent,
    artifactVersion: 'v1', findings: [{ severity: 'P1', status: 'open', summary: 'Proof needs correction' }] });
  assert.equal(reviewed.status, 'awaiting_supervisor_review');
  await f.engine.reviewWork({ runId: f.run.id, nodeId: 'source', actor: human, outcome: 'rework', reason: 'Correct proof', evidence: f.evidence });
  await assert.rejects(f.submit(matrix()), /already submitted/);
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'source', actor: agent,
    output: matrix(), artifacts: [{ ...f.artifact, version: 'v2' }] });
});

test('architecture references require actual accepted version/system; revisions preserve invariant IDs', async () => {
  const f = await fixture('architecture');
  await f.engine.retryNode({ runId: f.run.id, nodeId: 'source', actor: human, reason: 'Recover an abandoned author dispatch' });
  await f.submit(variants.architecture.outputValue);
  const accepted = await f.decide();
  const context = { disposition: 'baseline', systemId: 'orders', baseline: f.evidence[0].subjectRefs[0], decisionId: accepted.decision.id };
  const pack = { id: 'consumer', version: '1', graphs: [{ id: 'main', version: '1', start: 'work', inputContracts: ['architecture-context'], nodes: [{ id: 'work', type: 'task' }], edges: [] }] };
  await f.engine.registerPack(pack);
  const start = value => f.engine.startRun({ packId: 'consumer', packVersion: '1', graphId: 'main', actor: human, input: { architecture_context: value } });
  await start(context);
  await assert.rejects(start({ ...context, systemId: 'billing' }), /acceptance for this system/);
  await assert.rejects(start({ ...context, baseline: { ...context.baseline, version: 'old' } }), /baseline version/);
  const forged = await f.engine.recordDecision({ type: 'gate', status: 'decided', outcome: 'accept', actor: human, reason: 'Generic record is not a gate', runId: f.run.id, nodeId: 'gate', evidence: f.evidence });
  await assert.rejects(start({ ...context, decisionId: forged.id }), /recorded acceptance/);
  const revised = await fixture('architecture', { engine: f.engine, input: { system_id: 'orders', previous_architecture: context } });
  const output = structuredClone(variants.architecture.outputValue); output.invariants[0].id = 'INV-002';
  await assert.rejects(revised.submit(output), /Preserve invariant INV-001/);
  output.invariants[0].id = 'INV-001'; output.invariants[0].status = 'retired';
  await assert.rejects(revised.submit(output), /changeReason/);
  output.invariants[0].changeReason = 'Storage removed'; await revised.submit(output);
});

test('delivery rejects stale SHA, missing checks, reviews, approvals and premature merged status', async () => {
  const f = await fixture('delivery');
  const stale = structuredClone(variants.delivery.outputValue); stale.checks[0].headSha = 'b'.repeat(40);
  await assert.rejects(f.submit(stale), /stale/);
  const missingEvent = { ...variants.delivery.outputValue, state: 'merged' };
  await assert.rejects(f.submit(missingEvent), /merge event/);
  for (const mutate of [v => { v.checks[0].result = 'pending'; }, v => { v.checks[0].name = 'other'; }, v => { v.approvals = []; }, v => { v.review.verdict = 'blocked'; }, v => { v.unresolvedFindings = 1; }, v => { v.mergeable = false; }]) {
    const g = await fixture('delivery'); const output = structuredClone(variants.delivery.outputValue); mutate(output);
    await g.submit(output); await assert.rejects(g.decide('ready'), /gates have not passed/); await g.decide('hold');
  }
  await f.submit(variants.delivery.outputValue);
  await assert.rejects(f.decide('merged'), /observed merge state/); await f.decide('ready');
  const merged = await fixture('delivery');
  await merged.submit({ ...variants.delivery.outputValue, state: 'merged', mergeable: false,
    mergeEvent: { headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), sourceRef: 'https://pr/merge/1' } });
  await merged.decide('merged');
});

test('legacy graphs without evidence contracts retain their prior semantics', async () => {
  const engine = new GraphEngine(), pack = fixturePack('proof');
  delete pack.graphs[0].inputContracts; delete pack.graphs[0].nodes[0].outputContract; delete pack.graphs[0].nodes[1].decisionContract;
  await engine.registerPack(pack);
  const run = await engine.startRun({ packId: pack.id, packVersion: '1', graphId: 'main', actor: human });
  await engine.submitNode({ runId: run.id, nodeId: 'source', actor: agent, output: {}, artifacts: [{ id: 'legacy', version: 'v1', kind: 'acceptance_matrix' }] });
});
