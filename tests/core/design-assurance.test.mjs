import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunContracts, validateOutputContract, validateDecisionContract } from '../../src/core/evidence-contracts.mjs';

const ref = (artifactId, version = 'v1') => ({ artifactId, version });
const designArtifact = { kind: 'technical_design', id: 'DESIGN-1', version: 'v1' };
const comprehensionArtifact = { kind: 'design_comprehension', id: 'READ-1', version: 'v1' };
const auditArtifact = { kind: 'design_audit', id: 'AUDIT-1', version: 'v1' };
const design = () => ({
  requirementRefs: [ref('REQ-1')], problem: 'Writes race', scope: 'Order API', approach: 'Single writer', rollback: 'Restore route',
  alternatives: [{ name: 'Dual writer', reason: 'Race risk' }],
  boundaries: [{ path: 'src/order.mjs', responsibility: 'Own writes' }],
  failureModes: [{ scenario: 'Store outage', handling: 'Retry safely' }],
  verification: [{ claim: 'Only one writer', check: 'ACL test' }],
  contextIndex: [{ path: 'src/order.mjs', purpose: 'Read boundary' }]
});
const comprehension = () => ({ designRefs: [ref('DESIGN-1')], paraphrase: 'Order API owns writes',
  sessionRef: 'host-session://fresh', readPaths: ['src/order.mjs'], gaps: [] });
const audit = () => ({ designRefs: [ref('DESIGN-1')], axes:
  ['zoom-out-reuse', 'comprehension', 'failure-modes', 'implementation-feasibility'].map(axis =>
    ({ axis, verdict: 'pass', evidenceRef: `artifact://review/${axis}` })), findings: [] });
const run = () => ({ input: { feature: 'orders', versioned_requirement: { id: 'REQ-1', version: 'v1' } },
  graph: { nodes: [{ id: 'draft-technical-design', outputContract: 'technical-design' },
    { id: 'comprehension-review', outputContract: 'design-comprehension' },
    { id: 'design-audit', outputContract: 'design-audit' },
    { id: 'technical-design-gate', decisionContract: { type: 'technical-design-approval', sourceNode: 'design-audit' } }] },
  nodeStates: {
    'draft-technical-design': { status: 'completed', artifacts: [designArtifact], output: design() },
    'comprehension-review': { status: 'completed', artifacts: [comprehensionArtifact], output: comprehension() },
    'design-audit': { status: 'completed', artifacts: [auditArtifact], output: audit() },
    'technical-design-gate': { attempts: [{ decisionId: 'GATE-1' }] }
  } });
const state = () => ({ runs: {}, decisions: [] });
const gate = { decisionContract: { type: 'technical-design-approval', sourceNode: 'design-audit' } };
const agent = { kind: 'agent', roles: ['cto-caio'] };
const human = { kind: 'human', roles: ['human-owner', 'cto-caio'] };

test('design, fresh-context declaration and all audit axes bind to one version', () => {
  const s = state(), r = run();
  validateOutputContract(s, r, r.graph.nodes[0], r.nodeStates['draft-technical-design'].output, [designArtifact]);
  validateOutputContract(s, r, r.graph.nodes[1], r.nodeStates['comprehension-review'].output, [comprehensionArtifact]);
  validateOutputContract(s, r, r.graph.nodes[2], r.nodeStates['design-audit'].output, [auditArtifact]);
  assert.throws(() => validateOutputContract(s, r, r.graph.nodes[0], { ...design(), contextIndex: [] }, [designArtifact]), /contextIndex/);
  assert.throws(() => validateOutputContract(s, r, r.graph.nodes[1], { ...comprehension(), readPaths: [] }, [comprehensionArtifact]), /readPaths/);
  assert.throws(() => validateOutputContract(s, r, r.graph.nodes[1], { ...comprehension(), designRefs: [ref('DESIGN-1', 'old')] }, [comprehensionArtifact]), /exact current candidate/);
  assert.throws(() => validateOutputContract(s, r, r.graph.nodes[2], { ...audit(), axes: audit().axes.slice(1) }, [auditArtifact]), /every axis/);
  const concern = audit(); concern.axes[0].verdict = 'concern';
  assert.throws(() => validateOutputContract(s, r, r.graph.nodes[2], concern, [auditArtifact]), /needs a finding/);
});

test('design gate requires current per-finding disposition and blocks gaps and blocked axes', () => {
  const s = state(), r = run();
  r.nodeStates['design-audit'].output.findings = [{ id: 'F-1', axis: 'failure-modes', severity: 'P1', summary: 'Retry may duplicate', evidenceRef: 'artifact://review/1' }];
  const decide = (actor, evidence = []) => validateDecisionContract(s, r, gate, actor, 'accept', evidence);
  assert.throws(() => decide(agent), /Finding F-1 needs a disposition/);
  const disposition = { kind: 'design_finding_disposition', findingId: 'F-1', status: 'resolved', reason: 'Idempotent key',
    proofRef: 'artifact://test/retry', subjectRefs: [ref('DESIGN-1'), ref('AUDIT-1')] };
  decide(agent, [disposition]);
  assert.throws(() => decide(agent, [disposition, disposition]), /must be unique/);
  assert.throws(() => decide(agent, [{ ...disposition, subjectRefs: [ref('DESIGN-1', 'old'), ref('AUDIT-1')] }]), /exact current candidate/);
  assert.throws(() => decide(agent, [{ ...disposition, status: 'accepted-risk' }]), /human-owner/);
  decide(human, [{ ...disposition, status: 'accepted-risk' }]);
  r.nodeStates['comprehension-review'].output.gaps = [{ id: 'G-1', summary: 'Unclear retry' }];
  assert.throws(() => decide(human, [disposition]), /gaps or blocked/);
  r.nodeStates['comprehension-review'].output.gaps = [];
  r.nodeStates['design-audit'].output.axes[2].verdict = 'block';
  assert.throws(() => decide(human, [disposition]), /gaps or blocked/);
});

test('accepted design context must match recorded gate, feature and requirement', () => {
  const s = state(), r = run(); s.runs['RUN-1'] = r;
  s.decisions.push({ id: 'GATE-1', runId: 'RUN-1', nodeId: 'technical-design-gate', outcome: 'accept',
    evidence: [{ kind: 'technical_design', subjectRefs: [ref('DESIGN-1')] }] });
  const graph = { inputContracts: ['technical-design-context-optional'] };
  const input = { ...r.input, technical_design_context: { design: ref('DESIGN-1'), decisionId: 'GATE-1' } };
  validateRunContracts(s, graph, input);
  assert.throws(() => validateRunContracts(s, graph, { ...input, feature: 'billing' }), /another feature/);
  assert.throws(() => validateRunContracts(s, graph, { ...input, versioned_requirement: { id: 'REQ-2', version: 'v1' } }), /exact current candidate/);
  assert.throws(() => validateRunContracts(s, graph, { ...input, technical_design_context: { ...input.technical_design_context, design: ref('DESIGN-1', 'old') } }), /exact current candidate/);
});

test('drift report is bound to code SHA and nonmatching rows block ready', () => {
  const s = state(), r = run(); r.input.technical_design_context = { design: ref('DESIGN-1'), decisionId: 'GATE-1' };
  r.graph.nodes.push({ id: 'compare-design-code', outputContract: 'design-drift-report' });
  r.input.code_sha = 'a'.repeat(40);
  r.nodeStates['compare-design-code'] = { status: 'completed', artifacts: [{ kind: 'design_drift_report', id: 'DRIFT-1', version: 'v1' }],
    output: { designRefs: [ref('DESIGN-1')], codeSha: 'a'.repeat(40), rows: [{ id: 'R-1', designClaim: 'Single writer',
      codeRef: 'src/order.mjs:1', observed: 'Two writers', evidenceRef: 'artifact://inspect/1', status: 'code-diverged' }] } };
  const node = { outputContract: 'design-drift-report' };
  validateOutputContract(s, r, node, r.nodeStates['compare-design-code'].output, r.nodeStates['compare-design-code'].artifacts);
  assert.throws(() => validateDecisionContract(s, r, { decisionContract: { type: 'design-drift-disposition', sourceNode: 'compare-design-code' } }, agent, 'ready', []), /drift remains/);
  assert.throws(() => validateOutputContract(s, r, node, { ...r.nodeStates['compare-design-code'].output, codeSha: 'b'.repeat(40) }, r.nodeStates['compare-design-code'].artifacts), /pinned code SHA/);
  r.nodeStates['compare-design-code'].output.rows[0].status = 'matched';
  r.nodeStates['compare-design-code'].output.rows[0].observed = 'Single writer in pinned code';
  validateDecisionContract(s, r, { decisionContract: { type: 'design-drift-disposition', sourceNode: 'compare-design-code' } }, agent, 'ready', []);
});
