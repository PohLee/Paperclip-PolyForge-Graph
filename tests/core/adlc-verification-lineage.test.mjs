import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner', 'cpo'] };
const system = { id: 'graph', kind: 'system', roles: [] };
const reportNodes = ['qa', 'security', 'regression'];
const refs = artifacts => artifacts.map(({ id, version }) => ({ artifactId: id, version }));

function artifact(kind, version) {
  return { kind, id: kind, version };
}

async function startVerification(engine, verificationPack, version, projectId = 'shared-project') {
  const candidate = artifact('implementation_candidate', version);
  const run = await engine.startRun({
    packId: verificationPack.id, packVersion: verificationPack.version, graphId: 'verification', actor: owner, mode: 'assisted',
    input: {
      paperclipIssueId: 'lineage-' + version, projectId,
      feature: 'verification-lineage',
      implementation_candidate: candidate,
      versioned_requirement: { id: 'REQ-1', version: 'v1' },
      verification_plan: { id: 'PLAN-1', version: 'v1' },
      product_decision_refs: (await engine.getProductMemory('verification-lineage')).active.map(item => item.id),
      acceptance_criteria: [{ id: 'AC-1', description: 'The approved public behavior passes its check', requirementIds: ['REQ-1'] }],
    },
  });
  return { run, candidate };
}

async function setupWork(engine, run, nodeId, artifacts, output) {
  const node = run.graph.nodes.find(item => item.id === nodeId);
  const scope = { runId: run.id, nodeId };
  const actor = { id: node.role, kind: 'agent', roles: [node.role], executionId: run.id + '/author/' + nodeId };
  const work = await engine.recordWorkDecision({
    ...scope, actor, category: 'process', question: 'What candidate is under test?',
    options: [{ id: 'inspect', label: 'Inspect the pinned candidate' }], outcome: 'inspect', ruleRef: 'node:' + nodeId,
    reason: 'Verification uses the integrated candidate selected for this run', behaviorImpact: 'none',
    evidence: [{ kind: 'requirement', summary: 'The pinned implementation candidate', sourceRef: { kind: 'run_input', key: 'implementation_candidate' } }],
  });
  const request = { ...scope, actor, artifacts, output, decisionIds: [work.id] };
  const submit = async (submission = request, revision = {}) => {
    await engine.submitNode(submission);
    await engine.recordSelfReview({ ...scope, actor,
      artifactVersion: revision.revisedArtifact?.version ?? submission.artifacts.at(-1).version, ...revision });
    const review = (await engine.getWorkItems(run.id)).find(item => item.nodeId === nodeId && item.phase === 'supervisor');
    const supervisor = { id: review.role, kind: 'agent', roles: [review.role], executionId: run.id + '/supervisor/' + nodeId };
    await engine.reviewWork({
      ...scope, actor: supervisor, outcome: 'accept', reason: 'Inspected the candidate and report',
      evidence: review.requiredEvidence.map(kind => ({ kind, subjectRefs: review.candidateRefs })),
    });
  };
  return { request, submit };
}

function report(node, candidate, proofVersion = candidate.version) {
  return {
    candidateRefs: refs([candidate]),
    evidence: [{ kind: 'command', ref: 'artifact://log/' + node, observed: 'Check passed',
      receiptRef: { id: 'artifact://proof/' + proofVersion + '/' + node, version: 'v1' } }],
  };
}

async function freeze(engine, run, candidate) {
  await (await setupWork(engine, run, 'freeze-candidate', [artifact('fixed_candidate_identity', candidate.version)],
    { candidateRefs: refs([candidate]) })).submit();
}

async function publishReport(engine, run, nodeId, candidate, { version = candidate.version, output = report(nodeId, candidate) } = {}) {
  await (await setupWork(engine, run, nodeId, [artifact(nodeId + '_report', version)], output)).submit();
}

async function join(engine, run) {
  await engine.submitNode({ runId: run.id, nodeId: 'verification-ready', actor: system });
}

async function acceptanceMatrix(engine, run, candidate, result = 'pass') {
  const current = await engine.getRun(run.id);
  const reportOccurrences = reportNodes.map(nodeId => {
    const source = current.nodeStates[nodeId];
    return { ...refs(source.artifacts)[0], runId: run.id, nodeId, attemptNumber: source.attempts.length };
  });
  return {
    candidateRefs: refs([candidate]),
    reportRefs: reportOccurrences.map(({ artifactId, version }) => ({ artifactId, version })),
    criteria: [{ id: 'AC-1', result, evidence: result === 'unverified' ? [] : reportOccurrences.map(sourceRef => ({
      ...current.nodeStates[sourceRef.nodeId].output.evidence[0], sourceRef,
    })), ...(result === 'unverified' && { gap: 'No usable runtime evidence' }) }],
  };
}

async function fixture() {
  const engine = new GraphEngine({ now: () => '2026-11-22T00:00:00.000Z',
    availableCapabilities: { 'shadow-review-execution': '1.0.0' } });
  await engine.registerPack(pack);
  await engine.recordProductDecision({
    feature: 'verification-lineage', actor: owner, status: 'approved', outcome: 'Verify the public behavior',
    reason: 'The existing behavior must pass the versioned acceptance check', evidence: [{ kind: 'requirement', id: 'REQ-1' }],
  });
  return engine;
}

async function gate(engine, run) {
  const current = await engine.getRun(run.id);
  const node = current.graph.nodes.find(item => item.id === 'acceptance-gate');
  const rule = current.pack.decisionRules.find(rule => rule.type === node.decisionType && rule.mode === current.mode);
  const candidates = node.candidateNodes.flatMap(nodeId => current.nodeStates[nodeId].artifacts)
    .filter(artifact => node.candidateKinds.includes(artifact.kind));
  return { runId: run.id, nodeId: node.id, actor: owner, outcome: 'accept', reason: 'Inspected the accepted evidence',
    evidence: rule.requiredEvidence.map(kind => ({ kind, subjectRefs: refs(candidates) })) };
}

test('standard ADLC refuses A report replay on B at submission, criterion proof and Gate', async () => {
  const engine = await fixture();
  const legacy = structuredClone(pack);
  delete legacy.release;
  legacy.version = '0.3.10';
  const oldVerification = legacy.graphs.find(node => node.id === 'verification');
  oldVerification.version = '0.1.6';
  delete oldVerification.compatibility.requiredCapabilities['verification-report-lineage'];
  for (const node of oldVerification.nodes) {
    if (reportNodes.includes(node.id)) delete node.outputContract;
    if (node.id === 'acceptance-matrix') delete node.verificationReportSources;
    if (node.id === 'acceptance-gate') {
      node.candidateNodes = ['freeze-candidate', 'acceptance-matrix'];
      node.candidateKinds = ['fixed_candidate_identity', 'acceptance_matrix'];
    }
  }
  await engine.registerPack(legacy);
  const a = await startVerification(engine, legacy, 'v1');
  await freeze(engine, a.run, a.candidate);
  const draftQa = await setupWork(engine, a.run, 'qa', [artifact('qa_report', 'v1-draft')], report('qa', a.candidate, 'v1-draft'));
  await draftQa.submit(draftQa.request, { revisedArtifact: artifact('qa_report', 'v1'), revisedOutput: report('qa', a.candidate) });
  for (const nodeId of ['security', 'regression']) await publishReport(engine, a.run, nodeId, a.candidate);
  await join(engine, a.run);
  const aMatrix = await acceptanceMatrix(engine, a.run, a.candidate);
  const { reportRefs: _reports, ...aLegacyMatrix } = aMatrix;
  const matrixOnlyProof = { kind: 'manual', ref: 'artifact://proof/v1/legacy-matrix', observed: 'Manual check passed',
    receiptRef: { id: 'legacy-matrix-observation', version: 'v1' } };
  const sharedLocator = 'artifact://reporting/latest-security-check';
  aLegacyMatrix.criteria[0].evidence.push(matrixOnlyProof, {
    kind: 'manual', ref: sharedLocator, observed: 'Legacy security check passed',
  });
  await (await setupWork(engine, a.run, 'acceptance-matrix', [artifact('acceptance_matrix', 'v1')], aLegacyMatrix)).submit();
  await engine.decideNode(await gate(engine, a.run));
  await engine.submitNode({ runId: a.run.id, nodeId: 'verification-complete', actor: system });
  const acceptedA = await engine.getRun(a.run.id);

  const b = await startVerification(engine, pack, 'v2');
  await freeze(engine, b.run, b.candidate);
  const stale = await setupWork(engine, b.run, 'qa', [artifact('qa_report', 'v1')], report('qa', b.candidate));
  const beforeReport = await engine.getRun(b.run.id);
  await assert.rejects(engine.submitNode(stale.request), /identity\/version was already submitted/);
  await assert.rejects(engine.submitNode({ ...stale.request, artifacts: [artifact('qa_report', 'v2')], output: report('qa', a.candidate) }),
    /exact current candidate/);
  const missingReceipt = report('qa', b.candidate);
  delete missingReceipt.evidence[0].receiptRef;
  await assert.rejects(engine.submitNode({ ...stale.request, artifacts: [artifact('qa_report', 'v2')], output: missingReceipt }),
    /requires a versioned execution receipt/);
  const staleReceipt = report('qa', b.candidate, 'v1');
  staleReceipt.evidence[0].ref = 'artifact://log/alias-of-the-same-a-log';
  await assert.rejects(engine.submitNode({ ...stale.request, artifacts: [artifact('qa_report', 'v2')], output: staleReceipt }),
    /execution receipt was already recorded for a different candidate/);
  await assert.rejects(engine.submitNode({ ...stale.request, artifacts: [artifact('qa_report', 'v2')], output: report('qa', b.candidate, 'v1-draft') }),
    /execution receipt was already recorded for a different candidate/);
  await assert.rejects(engine.submitNode({ ...stale.request, artifacts: [artifact('qa_report', 'v2')],
    output: { candidateRefs: refs([b.candidate]), evidence: [matrixOnlyProof] } }), /execution receipt was already recorded for a different candidate/);
  assert.deepEqual(await engine.getRun(b.run.id), beforeReport);
  await stale.submit({ ...stale.request, artifacts: [artifact('qa_report', 'v2')] });
  await engine.retryNode({ runId: b.run.id, nodeId: 'qa', actor: owner, reason: 'Independent recheck requires publishing a new report version' });
  await publishReport(engine, b.run, 'qa', b.candidate, { version: 'v2-retry' });
  const security = report('security', b.candidate);
  security.evidence[0].ref = sharedLocator;
  await publishReport(engine, b.run, 'security', b.candidate, { output: security });
  await publishReport(engine, b.run, 'regression', b.candidate);
  await join(engine, b.run);

  const bMatrix = await acceptanceMatrix(engine, b.run, b.candidate);
  const matrixWork = await setupWork(engine, b.run, 'acceptance-matrix', [artifact('acceptance_matrix', 'v2')], bMatrix);
  const staleCitation = structuredClone(bMatrix);
  staleCitation.criteria[0].evidence[0] = aMatrix.criteria[0].evidence[0];
  const falseLabel = structuredClone(bMatrix);
  falseLabel.criteria[0].evidence[0].ref = 'artifact://log/alias-of-the-same-a-log';
  const staleMatrixReceipt = structuredClone(bMatrix);
  staleMatrixReceipt.criteria[0].evidence[0].receiptRef = aMatrix.criteria[0].evidence[0].receiptRef;
  const changedObservation = structuredClone(bMatrix);
  changedObservation.criteria[0].evidence[0].observed = 'A different check passed';
  const changedProofKind = structuredClone(bMatrix);
  changedProofKind.criteria[0].evidence[0].kind = 'browser';
  const staleOccurrence = structuredClone(bMatrix);
  staleOccurrence.criteria[0].evidence[0].sourceRef.attemptNumber = 1;
  const beforeMatrix = await engine.getRun(b.run.id);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: staleCitation }), /current accepted verification report attempt/);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: falseLabel }), /proof is missing from its current accepted verification report/);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: staleMatrixReceipt }), /proof is missing from its current accepted verification report/);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: changedObservation }), /proof is missing from its current accepted verification report/);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: changedProofKind }), /proof is missing from its current accepted verification report/);
  await assert.rejects(engine.submitNode({ ...matrixWork.request, output: staleOccurrence }), /current accepted verification report attempt/);
  assert.deepEqual(await engine.getRun(b.run.id), beforeMatrix);
  await matrixWork.submit();

  const currentGate = await gate(engine, b.run);
  const staleGate = structuredClone(currentGate);
  const qa = staleGate.evidence.find(item => item.kind === 'qa_report');
  qa.subjectRefs = qa.subjectRefs.map(ref => ref.artifactId === 'qa_report' ? aMatrix.reportRefs[0] : ref);
  const beforeGate = await engine.getRun(b.run.id);
  await assert.rejects(engine.decideNode(staleGate), /does not reference current candidate qa_report@v2-retry/);
  assert.deepEqual(await engine.getRun(b.run.id), beforeGate);
  assert.ok(!(await engine.listDecisions({ runId: b.run.id })).some(item => item.nodeId === 'acceptance-gate'));
  await engine.decideNode(currentGate);
  await engine.submitNode({ runId: b.run.id, nodeId: 'verification-complete', actor: system });
  assert.equal((await engine.getRun(b.run.id)).status, 'completed');
  assert.deepEqual(await engine.getRun(a.run.id), acceptedA);
});

test('unverified reports retain human exception handling and report names are project scoped', async () => {
  const engine = await fixture();
  const first = await startVerification(engine, pack, 'v1', 'another-project');
  await freeze(engine, first.run, first.candidate);
  await publishReport(engine, first.run, 'qa', first.candidate);

  const { run, candidate } = await startVerification(engine, pack, 'v2');
  await freeze(engine, run, candidate);
  for (const nodeId of reportNodes) await publishReport(engine, run, nodeId, candidate, {
    version: 'v1', output: nodeId === 'qa' ? report(nodeId, candidate, 'v1') : { candidateRefs: refs([candidate]), evidence: [] },
  });
  await join(engine, run);
  const matrix = await acceptanceMatrix(engine, run, candidate, 'unverified');
  const matrixArtifact = artifact('acceptance_matrix', 'v2');
  const work = await setupWork(engine, run, 'acceptance-matrix', [matrixArtifact], matrix);
  const inventedProof = structuredClone(matrix);
  inventedProof.criteria[0] = { id: 'AC-1', result: 'pass', evidence: [{
    kind: 'report', ref: 'artifact://unexecuted', observed: 'Claimed pass',
    sourceRef: { ...matrix.reportRefs[0], runId: run.id, nodeId: 'qa', attemptNumber: 1 },
  }] };
  await assert.rejects(engine.submitNode({ ...work.request, output: inventedProof }), /proof is missing from its current accepted verification report/);
  await work.submit();
  const decision = await gate(engine, run);
  const escalated = await engine.escalateNode({ ...decision, reason: 'No evidence, request human disposition' });
  const answer = { ...decision, expectedRunDigest: runValidationDigest(await engine.getRun(run.id)), expectedDecisionId: escalated.decision.id };
  await assert.rejects(engine.resolveHumanGate(answer), /exception reason for AC-1/);
  await engine.resolveHumanGate({ ...answer, evidence: [...answer.evidence, { kind: 'acceptance_exception',
    criterionId: 'AC-1', reason: 'A separate check is planned', risk: 'The criterion remains unverified', subjectRefs: refs([matrixArtifact]) }] });
});
