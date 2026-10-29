import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunContracts, validateOutputContract, validateDecisionContract, readyWorkTickets } from '../../src/core/evidence-contracts.mjs';

const request = { id: 'REQ-1', version: 'v1' };
const triage = {
  requestRefs: [{ artifactId: 'REQ-1', version: 'v1' }], category: 'bug', surface: 'issue', disposition: 'ready',
  duplicateCheck: { result: 'none', sourceRef: 'artifact://search' },
  priorDecisionCheck: { result: 'none', sourceRef: 'artifact://decisions' },
  claimCheck: { result: 'confirmed', sourceRef: 'artifact://repro' },
  brief: { problem: 'Save fails', acceptanceBoundary: 'Save succeeds', evidenceRef: 'artifact://repro',
    owner: 'product-owner', nextGraph: 'implementation' }
};

test('ready bug triage requires a confirmed claim and matching disposition', () => {
  const run = { input: { source_request: request }, nodeStates: { 'assess-request': { status: 'completed', output: triage } } };
  const node = { outputContract: 'triage-report' };
  assert.doesNotThrow(() => validateOutputContract({ runs: {} }, run, node, triage));
  assert.throws(() => validateOutputContract({ runs: {} }, run, node,
    { ...triage, claimCheck: { result: 'unverified', sourceRef: 'artifact://attempt' } }), /confirmed reproduction/);
  assert.throws(() => validateDecisionContract({}, run, { decisionContract: { type: 'triage-routing', sourceNode: 'assess-request' } },
    {}, 'closed', []), /match the report/);
});

test('needs-info triage resumes only from the same request and a recorded needs-info outcome', () => {
  const old = { status: 'completed', graph: { id: 'request-triage' }, input: { source_request: request }, nodeStates: {
    'assess-request': { artifacts: [{ id: 'TRIAGE-1', version: 'v1' }], output: { disposition: 'needs-info' } },
    'triage-disposition': { outcome: 'needs-info' }
  } };
  const input = { source_request: request, previous_triage: { id: 'TRIAGE-1', version: 'v1' },
    reporter_update: { id: 'UPDATE-1', version: 'v1' } };
  assert.doesNotThrow(() => validateRunContracts({ runs: { old } }, { inputContracts: ['source-request'] }, input));
  assert.throws(() => validateRunContracts({ runs: { old } }, { inputContracts: ['source-request'] },
    { ...input, source_request: { id: 'OTHER', version: 'v1' } }), /same request/);
});

test('a ready triage report routes only to its named downstream Graph', () => {
  const old = { status: 'completed', graph: { id: 'request-triage' }, nodeStates: {
    'assess-request': { artifacts: [{ id: 'TRIAGE-2', version: 'v1' }], output: { brief: { nextGraph: 'implementation' } } },
    'triage-disposition': { outcome: 'ready' }
  } };
  const input = { triage_handoff: { id: 'TRIAGE-2', version: 'v1' } };
  assert.doesNotThrow(() => validateRunContracts({ runs: { old } },
    { id: 'implementation', inputContracts: ['triage-handoff-optional'] }, input));
  assert.throws(() => validateRunContracts({ runs: { old } },
    { id: 'product-discovery', inputContracts: ['triage-handoff-optional'] }, input), /routed to this Graph/);
});

test('work plan rejects unknown blockers, cycles and incomplete integrated proof', () => {
  const ticket = (id, blockers = []) => ({ id, deliverable: id, owner: 'lead-engineer', verification: 'Run real check', blockers });
  const plan = { tickets: [ticket('T-1'), ticket('T-2', ['T-1'])] };
  assert.deepEqual(readyWorkTickets(plan), ['T-1']);
  assert.throws(() => readyWorkTickets({ tickets: [ticket('T-1', ['missing'])] }), /another ticket/);
  assert.throws(() => readyWorkTickets({ tickets: [ticket('T-1', ['T-2']), ticket('T-2', ['T-1'])] }), /cycle/);
  const run = { nodeStates: { 'implementation-plan': { output: plan } } };
  const artifacts = [{ kind: 'implementation_candidate', id: 'CODE-1', version: 'v1' },
    { kind: 'integration_test_report', id: 'REPORT-1', version: 'v1' }];
  const output = { candidateRefs: [{ artifactId: 'CODE-1', version: 'v1' }], tickets: [
    { id: 'T-1', result: 'complete', evidenceRef: 'artifact://check/1', observed: 'Passed' }
  ] };
  assert.throws(() => validateOutputContract({ runs: {} }, run, { outputContract: 'work-completion' }, output, artifacts), /every planned ticket/);
});

test('project verification profile requires a mapped live proof that survives cleanup', () => {
  const profile = { identity: { id: 'VERIFY-1', version: 'v1' }, surface: 'web app',
    launchRef: 'artifact://verify/launch', doctorRef: 'artifact://verify/doctor',
    driveRef: 'artifact://verify/drive', evidenceRef: 'artifact://verify/evidence', cleanupRef: 'artifact://verify/cleanup',
    features: [{ id: 'save', path: 'Open editor and save', proof: 'Saved text is visible after reload' }],
    proofRun: { featureId: 'save', evidenceRef: 'artifact://verify/run-1', cleanupPreservedEvidence: true } };
  const graph = { inputContracts: ['project-verification-optional'] };
  assert.doesNotThrow(() => validateRunContracts({}, graph, { project_verification: profile }));
  assert.throws(() => validateRunContracts({}, graph,
    { project_verification: { ...profile, proofRun: { ...profile.proofRun, cleanupPreservedEvidence: false } } }), /preserve evidence/);
});
