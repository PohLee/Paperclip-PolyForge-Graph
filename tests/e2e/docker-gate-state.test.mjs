import test from 'node:test';
import assert from 'node:assert/strict';
import { manualReviewReady, assistedAcceptanceReady } from '../../scripts/e2e-gate-state.mjs';

test('assisted polling waits for state, ready nodes and human work to agree', () => {
  const settled = { run: { status: 'running', mode: 'assisted', nodeStates: {
    'acceptance-gate': { status: 'pending', attempts: [] }, qa: { status: 'completed', attempts: [{}, {}] }
  } }, ready: [{ id: 'acceptance-gate' }], work: [{ nodeId: 'acceptance-gate', kind: 'human', operation: 'decide' }] };
  const missingWork = structuredClone(settled); missingWork.work = [];
  const staleQa = structuredClone(settled); staleQa.run.nodeStates.qa.status = 'pending';
  const consumed = structuredClone(settled); consumed.run.nodeStates['acceptance-gate'].attempts = [{}];
  const autonomous = structuredClone(settled); autonomous.run.mode = 'autonomous';
  const paused = structuredClone(settled); paused.run.status = 'paused';
  assert.deepEqual([{}, missingWork, staleQa, consumed, autonomous, paused, settled]
    .map(assistedAcceptanceReady), [false, false, false, false, false, false, true]);
});

test('manual polling waits for the untouched review and human policy projection together', () => {
  const settled = { run: { status: 'running', mode: 'manual', nodeStates: {
    'assess-request': { status: 'awaiting_supervisor_review', artifacts: [{ id: 'brief' }],
      attempts: [{ supervisorReview: null }] }, 'triage-disposition': { attempts: [] }
  } }, work: [{ nodeId: 'assess-request', phase: 'supervisor', kind: 'human', operation: 'review' }] };
  const missingWork = structuredClone(settled); missingWork.work = [];
  const noArtifacts = structuredClone(settled); noArtifacts.run.nodeStates['assess-request'].artifacts = [];
  const reviewed = structuredClone(settled); reviewed.run.nodeStates['assess-request'].attempts[0].supervisorReview = { outcome: 'accept' };
  const gateConsumed = structuredClone(settled); gateConsumed.run.nodeStates['triage-disposition'].attempts = [{}];
  assert.deepEqual([{}, missingWork, noArtifacts, reviewed, gateConsumed, settled]
    .map(manualReviewReady), [false, false, false, false, false, true]);
});
