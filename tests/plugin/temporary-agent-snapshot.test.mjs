import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAgentSnapshot, verifyTemporaryAgentSnapshot } from
  '../../src/plugin/temporary-agent-snapshot.mjs';

const companyId = 'company-a';
const request = { kind: 'shadow-agent', parent: { agentId: 'agent-a',
  executionId: 'execution-a', taskId: 'issue-a', runId: 'run-a', nodeId: 'node-a' },
context: { mode: 'snapshot', parentSessionRef: 'session-a', snapshot: {
  objective: 'Assess requirement', currentState: 'Work is pending',
  conclusions: [], openQuestions: ['Which constraint applies?'],
  evidenceRefs: [{ kind: 'document', id: 'source-a' }],
} } };
const run = { id: 'run-a', input: { feature: 'calculator', projectId: 'project-a' } };
const decisions = [
  { id: 'approved-old', type: 'product', feature: 'calculator', status: 'approved', outcome: 'Use exact arithmetic' },
  { id: 'rejected', type: 'product', feature: 'calculator', status: 'rejected', outcome: 'Use floating point' },
  { id: 'proposed', type: 'product', feature: 'calculator', status: 'proposed', outcome: 'Use decimal' },
  { id: 'approved-new', type: 'product', feature: 'calculator', status: 'approved', supersedes: 'approved-old', outcome: 'Use integer cents' },
  { id: 'other-feature', type: 'product', feature: 'shipping', status: 'approved',
    projectId: 'project-a', issueId: 'issue-a', runId: 'run-a' },
  { id: 'gate-a', type: 'gate', runId: 'run-a', status: 'accepted', outcome: 'accept', reason: 'Evidence' },
  { id: 'other-project', type: 'gate', projectId: 'project-b', status: 'accepted' },
];
const control = { companyId, plans: [{ id: 'plan-a', projectId: 'project-a' }],
  escalations: [
    { id: 'escalation-a', subjectType: 'work-plan', subjectId: 'plan-a', status: 'resolved', outcome: 'accept' },
    { id: 'escalation-b', subjectType: 'work-plan', subjectId: 'plan-b', status: 'resolved' },
  ], knowledge: [{ id: 'knowledge-a', projectId: 'project-a' },
    { id: 'knowledge-b', projectId: 'project-b' }],
  feedback: [{ id: 'feedback-a', projectId: 'project-a' },
    { id: 'feedback-b', projectId: 'project-b' }] };
const build = (overrides = {}) => createTemporaryAgentSnapshot({ request, companyId,
  parentSessionRef: 'session-a', run, decisions, control, ...overrides });

test('trusted scope includes rejected history, current approval and matching control records', () => {
  const snapshot = build();
  assert.deepEqual(snapshot.authority.activeProductDecisionIds, ['approved-new']);
  assert.deepEqual(snapshot.authority.decisions.map((item) => item.id),
    ['approved-old', 'rejected', 'proposed', 'approved-new', 'gate-a']);
  assert.deepEqual(snapshot.authority.escalations.map((item) => item.id), ['escalation-a']);
  assert.deepEqual(snapshot.authority.knowledge.map((item) => item.id), ['knowledge-a']);
  assert.deepEqual(snapshot.authority.feedback.map((item) => item.id), ['feedback-a']);
  assert.equal(verifyTemporaryAgentSnapshot(snapshot, { request, companyId }), snapshot);
});

test('native issue without trusted feature retains all company product history', () => {
  const snapshot = build({ run: null });
  assert.equal(snapshot.authority.scope.productHistory, 'all-company');
  assert.ok(snapshot.authority.decisions.some((item) => item.id === 'other-feature'));
});

test('malformed and oversized advisory or authority reject without truncation', () => {
  const malformed = structuredClone(request);
  malformed.context.snapshot.currentState = '';
  assert.throws(() => build({ request: malformed }), /advisory/);
  const injected = structuredClone(request);
  injected.context.snapshot.authority = { activeProductDecisionIds: ['rejected'] };
  assert.throws(() => build({ request: injected }), /advisory/);
  const oversized = structuredClone(request);
  oversized.context.snapshot.currentState = 'x'.repeat(3001);
  assert.throws(() => build({ request: oversized }), /advisory/);
  assert.throws(() => build({ decisions: [
    ...decisions, { id: 'large', type: 'gate', runId: 'run-a',
      reason: 'x'.repeat(300_000) },
  ] }), /bounded limit/);
  assert.throws(() => build({ decisions: undefined }), /snapshot source/);
  assert.throws(() => build({ capturedAt: 'yesterday' }), /snapshot source/);
});

test('digest and source binding reject cross-parent, cross-company and mutation', () => {
  const snapshot = build();
  assert.throws(() => verifyTemporaryAgentSnapshot(snapshot,
    { request, companyId: 'company-b' }), /source or digest mismatch/);
  assert.throws(() => verifyTemporaryAgentSnapshot(snapshot,
    { request: { ...request, parent: { ...request.parent, executionId: 'other' } }, companyId }),
  /source or digest mismatch/);
  snapshot.authority.decisions[0].outcome = 'Tampered';
  assert.throws(() => verifyTemporaryAgentSnapshot(snapshot, { request, companyId }),
    /source or digest mismatch/);
});
