import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleReviewError, reviewCandidate, reviewHandoff, reviewRequest, reviewSourceUrl } from '../../src/plugin/ui-review.mjs';

const work = { kind: 'human', operation: 'resolve-human-gate', nodeId: 'gate' };
const node = { id: 'gate', candidateNodes: ['draft'], candidateKinds: ['report'] };
const subject = (artifactId, version) => ({ artifactId, version });
const evidence = (summary, ...subjectRefs) => ({ kind: 'test', summary, subjectRefs });
const run = {
  id: 'run', pendingHuman: { kind: 'decision', nodeId: 'gate', escalationDecisionId: 'current-request' },
  nodeStates: {
    draft: { status: 'completed', artifacts: [
      { id: 'report', version: 'v1', kind: 'report' },
      { id: 'report', version: 'v2', kind: 'report' },
      { id: 'draft-notes', version: 'v1', kind: 'notes' },
    ], attempts: [
      { evidence: [evidence('Archived evidence', subject('report', 'v2'))] },
      { evidence: [evidence('Evidence for the current draft', subject('report', 'v2'))] },
    ] },
    verification: { status: 'completed', artifacts: [{ id: 'test-result', version: 'v2' }],
      attempts: [{ evidence: [evidence('Current verification', subject('report', 'v2'))] }] },
    reopened: { status: 'pending', attempts: [{ evidence: [evidence('Inactive attempt', subject('report', 'v2'))] }] },
  },
};
const request = reviewRequest(run, work);

test('the review guide uses current candidate artifacts and evidence bound to exact versions', () => {
  const data = { run, decisions: [
    { id: 'retired-request', runId: run.id, evidence: [evidence('Retired review', subject('report', 'v2'))] },
    { id: 'current-request', runId: run.id, question: 'Is the report ready?', evidence: [
      evidence('Current escalation evidence', subject('report', 'v2')),
      evidence('Evidence for a different artifact', subject('draft-notes', 'v1')),
      evidence('Evidence for the old version', subject('report', 'v1')),
      evidence('Evidence without a version', subject('report')),
      evidence('Unbound evidence'),
    ] },
  ] };
  const candidate = reviewCandidate(data, work, node, request);
  assert.equal(candidate.question, 'Is the report ready?');
  assert.deepEqual(candidate.artifacts.map(({ id, version }) => [id, version]), [['report', 'v2']]);
  assert.deepEqual(candidate.evidence.map(({ summary }) => summary), [
    'Current escalation evidence', 'Evidence for the current draft', 'Current verification',
  ]);
  assert.equal(candidate.missingArtifacts, false);

  const unavailable = reviewCandidate(data, work, { ...node, candidateNodes: ['missing', 'reopened'] }, request);
  assert.deepEqual(unavailable.artifacts, []);
  assert.deepEqual(unavailable.evidence, []);
  assert.equal(unavailable.missingArtifacts, true);
});

test('supervisor review uses the latest attempted version rather than a previously completed artifact', () => {
  const action = { kind: 'human', operation: 'review', nodeId: 'draft' };
  const reviewRun = { ...run, nodeStates: { draft: { status: 'awaiting_supervisor_review',
    artifacts: [{ id: 'report', version: 'v1' }],
    attempts: [{ artifacts: [{ id: 'report', version: 'v1' }, { id: 'report', version: 'v2' }],
      evidence: [evidence('old', subject('report', 'v1')), evidence('current', subject('report', 'v2'))] }],
  } } };
  const candidate = reviewCandidate({ run: reviewRun }, action, { id: 'draft' }, reviewRequest(reviewRun, action));
  assert.deepEqual(candidate.artifacts, [{ id: 'report', version: 'v2' }]);
  assert.deepEqual(candidate.evidence.map(({ summary }) => summary), ['current']);
});

test('candidate evidence includes only the current attempt independent review in this run and node', () => {
  const reviewedRun = { ...run, nodeStates: {
    draft: { ...run.nodeStates.draft, attempts: [
      { supervisorReview: { decisionId: 'archived-review' } },
      { supervisorReview: { decisionId: 'independent-review' } },
    ] },
    reopened: { ...run.nodeStates.reopened, attempts: [{ supervisorReview: { decisionId: 'inactive-review' } }] },
  } };
  const review = { id: 'independent-review', runId: run.id, nodeId: 'draft', attemptNumber: 2,
    evidence: [evidence('Independent current review', subject('report', 'v2')),
      evidence('Independent old version', subject('report', 'v1')),
      evidence('Independent unrelated artifact', subject('draft-notes', 'v1')),
      evidence('Independent unversioned review', subject('report'))] };
  const decisions = [
    { ...review, runId: 'another-run', evidence: [evidence('Foreign run review', subject('report', 'v2'))] },
    { ...review, nodeId: 'another-node', evidence: [evidence('Foreign node review', subject('report', 'v2'))] },
    { ...review, attemptNumber: 1, evidence: [evidence('Earlier attempt review', subject('report', 'v2'))] },
    { ...review, id: 'archived-review', evidence: [evidence('Archived review', subject('report', 'v2'))] },
    { ...review, id: 'inactive-review', nodeId: 'reopened', evidence: [evidence('Inactive review', subject('report', 'v2'))] },
    review,
  ];
  const candidate = reviewCandidate({ run: reviewedRun, decisions }, work, node, request);
  assert.deepEqual(candidate.evidence.map(({ summary }) => summary), ['Independent current review']);
  const withoutAttemptNumber = reviewCandidate({ run: reviewedRun, decisions: [{ ...review, attemptNumber: null }] }, work, node, request);
  assert.deepEqual(withoutAttemptNumber.evidence, candidate.evidence,
    'persisted supervisor decisions identify their attempt through supervisorReview.decisionId');
  const withoutCurrentReview = reviewCandidate({ run: reviewedRun, decisions: decisions.slice(0, -1) }, work, node, request);
  assert.deepEqual(withoutCurrentReview.evidence, []);
});

const staleMessage = 'Run changed since validation; revalidate before applying';
const oldCard = { ...request, runDigest: 'old-digest', status: 'answered',
  interactionId: 'old-card', url: '/issues/issue', syncError: staleMessage };
const currentCard = { ...request, runDigest: 'new-digest', status: 'pending',
  interactionId: 'new-card', url: '/issues/issue' };

test('an explicitly stale review links only a pending replacement for the same request and current snapshot', () => {
  const stale = reviewHandoff({ runDigest: 'old-digest', nativeDecisions: [oldCard] }, request);
  assert.equal(stale.native, null);
  assert.equal(stale.replacement, false);
  assert.equal(stale.outdated.interactionId, 'old-card');
  for (const item of [
    { ...currentCard, requestId: 'another-request' },
    { ...currentCard, runId: 'another-run' },
    { ...currentCard, nodeId: 'another-node' },
    { ...currentCard, runDigest: 'old-digest' },
    { ...currentCard, status: 'answered' },
    { ...currentCard, interactionId: 'old-card' },
  ]) {
    const unresolved = reviewHandoff({ runDigest: 'new-digest', nativeDecisions: [item] }, request, stale.outdated);
    assert.equal(unresolved.native, null);
    assert.equal(unresolved.replacement, false);
  }
  const refreshed = reviewHandoff({ runDigest: 'new-digest', nativeDecisions: [currentCard] }, request, stale.outdated);
  assert.equal(refreshed.replacement, true);
  assert.equal(refreshed.native.interactionId, 'new-card');

  const immediate = reviewHandoff({ runDigest: 'new-digest', nativeDecisions: [{
    ...currentCard, syncError: staleMessage, replacedInteractionId: 'old-card',
  }] }, request);
  assert.equal(immediate.replacement, true);
  assert.equal(immediate.native.interactionId, 'new-card');
});

test('every advanced review can recover with a fresh digest when a replacement native card is unavailable', () => {
  for (const operation of ['decide', 'review', 'resolve-human-gate', 'resolve-rework-limit', 'resolve-conflict']) {
    const action = { ...work, operation, conflictId: 'conflict-request' };
    const currentRun = { ...run, pendingHuman: { ...run.pendingHuman, decisionId: 'rework-request' } };
    const currentRequest = reviewRequest(currentRun, action);
    const previous = { ...currentRequest, runDigest: 'old-digest', interactionId: 'stale-card' };
    const stale = reviewHandoff({ runDigest: 'old-digest', nativeDecisions: [] }, currentRequest, previous);
    assert.equal(stale.refreshNeeded, true, operation);
    const missingDigest = reviewHandoff({ nativeDecisions: [] }, currentRequest, previous);
    assert.equal(missingDigest.refreshNeeded, true, operation);
    const refreshed = reviewHandoff({ runDigest: 'new-digest', nativeDecisions: [] }, currentRequest, previous);
    assert.equal(refreshed.native, null);
    assert.equal(refreshed.replacement, false);
    assert.equal(refreshed.refreshNeeded, false, operation);
    assert.equal(refreshed.refreshed, true, operation);
    const unrelated = reviewHandoff({ runDigest: 'old-digest' }, currentRequest, { ...previous, requestId: 'retired-request' });
    assert.equal(unrelated.outdated, undefined, operation);
  }
});

test('native and advanced transient errors preserve ordinary retry guidance', () => {
  assert.equal(isStaleReviewError(new Error(staleMessage)), true);
  assert.equal(isStaleReviewError(new Error(`Action failed: ${staleMessage}`)), true);
  for (const message of ['Failed to fetch', 'HTTP 409', 'Gateway timeout', 'Missing human decision run digest',
    'Paperclip Decision resolver lacks human-owner role']) {
    assert.equal(isStaleReviewError(new Error(message)), false);
    const state = reviewHandoff({ runDigest: 'old-digest', nativeDecisions: [{ ...oldCard, syncError: message }] }, request);
    assert.equal(state.outdated, undefined);
    assert.equal(state.syncError, message);
  }
  assert.equal(reviewSourceUrl('https://example.test/evidence'), 'https://example.test/evidence');
  assert.equal(reviewSourceUrl('javascript:alert(1)'), null);
  assert.equal(reviewSourceUrl('https://user:pass@example.test/evidence'), null);
});

test('product review is scoped to the selected run and proposal independently of Graph card metadata', () => {
  const work = { operation: 'resolve-product-decision', proposalId: 'product-proposal' };
  const request = reviewRequest(run, work);
  const card = { kind: 'product_decision', runId: run.id, proposalId: work.proposalId,
    status: 'pending', interactionId: 'product-card', url: '/issues/issue' };
  const handoff = reviewHandoff({ nativeDecisions: [
    { ...card, runId: 'another-run' }, { ...card, proposalId: 'another-proposal' }, card,
  ] }, request);
  assert.equal(handoff.native, card);
  const candidate = reviewCandidate({ run, decisions: [{ id: work.proposalId, runId: run.id,
    outcome: 'Review this proposed behavior', reason: 'Persisted reason' }] }, work, node, request);
  assert.equal(candidate.proposal, 'Review this proposed behavior');
  assert.deepEqual(candidate.artifacts, []);
});
