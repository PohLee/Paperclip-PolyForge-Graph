import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareReviewerCases, scoreReviewerCase } from '../../eval/reviewer-blind.mjs';

test('review packets show passing candidate tests and keep independent probe outcomes out of each session', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'polyforge-reviewer-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'evidence');
  const cases = await prepareReviewerCases(directory);
  assert.deepEqual(cases.map(item => [item.contractConforms, item.publicTest.exitCode]), [[false, 0], [true, 0]]);
  const packets = await Promise.all(cases.map(item => readFile(join(directory, item.id, 'review.md'), 'utf8')));
  assert.match(packets[0], /\+.*toFixed\(5\)/);
  assert.match(packets[1], /\+.*assert\.equal\(countAmount\(3, 0\.41234\), 1\.237\)/);
  for (const prompt of packets) {
    assert.match(prompt, /Approved product decision AMOUNT-PRECISION@1/);
    assert.match(prompt, /# pass 2\n# fail 0/);
    assert.doesNotMatch(prompt, /approved":|actual":|r01|r02|observer\.json|0\.3333333/);
  }
  assert.doesNotMatch(packets[0], /\+.*assert\.equal/);
  assert.doesNotMatch(packets[1], /toFixed\(5\)/);
});

test('the observer scores verified evidence, false positives and missing decision citations separately', () => {
  const decisionRef = 'AMOUNT-PRECISION@1';
  const defect = { id: 'r01', decisionRef, contractConforms: false, changedPath: 'amount.mjs', changedLine: 2,
    probes: [{ actual: 1.23702, approved: 1.237 }] };
  const correct = { id: 'r02', decisionRef, contractConforms: true, changedPath: 'amount.test.mjs', changedLine: 6,
    probes: [{ actual: 1.237, approved: 1.237 }] };
  const reject = { verdict: 'request-changes', decisionRefs: [decisionRef], reason: 'The implementation permits excess precision.',
    findings: [{ path: 'amount.mjs', line: 2, evidence: 'The candidate returns 1.23702. The decision requires 1.237.',
      proposedFix: 'Preserve rounding to three decimal places and correct the test expectation.' }] };
  const accept = { verdict: 'accept', decisionRefs: [decisionRef], reason: 'The test enforces the existing three-place rounding.', findings: [] };
  const score = (item, review) => scoreReviewerCase(item, JSON.stringify(review));
  const grounded = score(defect, reject);
  assert.equal(grounded.passed, true);
  assert.equal(grounded.evidence.changedLineCited, true);
  assert.equal(grounded.evidence.independentProbeMatched, true);
  assert.equal(score(correct, accept).passed, true);
  assert.equal(score(defect, accept).missedDefect, true);
  assert.equal(score(correct, reject).falsePositive, true);
  assert.equal(score(defect, { ...reject, findings: [{ ...reject.findings[0], evidence: 'The output looks suspect.' }] }).missedDefect, true);
  const missingCitation = score(correct, { ...accept, decisionRefs: [] });
  assert.equal(missingCitation.citedDecision, false);
  assert.equal(missingCitation.missedDefect, false);
  assert.equal(missingCitation.falsePositive, false);
  assert.equal(missingCitation.passed, false);
  assert.equal(scoreReviewerCase(correct, '{}').valid, false);
});

test('the reviewer can detect the precision regression without matching the hidden probe or exact line', () => {
  const decisionRef = 'AMOUNT-PRECISION@1';
  const defect = { id: 'r01', decisionRef, contractConforms: false, changedPath: 'amount.mjs', changedLine: 2,
    probes: [{ actual: 1.23702, approved: 1.237 }] };
  const score = (evidence, decisionRefs) => scoreReviewerCase(defect, JSON.stringify({
    verdict: 'request-changes', decisionRefs, reason: 'The change exceeds the approved precision.',
    findings: [{ path: 'amount.mjs', line: 1, evidence, proposedFix: 'Restore toFixed(3) and correct the test.' }],
  }));
  const mechanism = score('Changing toFixed(5) permits five decimal places where only three are approved.', []);
  assert.equal(mechanism.detectedDefect, true);
  assert.equal(mechanism.missedDefect, false);
  assert.equal(mechanism.citedDecision, false);
  assert.equal(mechanism.evidence.precisionMechanism, true);
  assert.equal(mechanism.evidence.changedLineCited, false);
  assert.equal(mechanism.evidence.independentProbeMatched, false);

  const newExample = score('countAmount(1, 4.12345) returns 4.12345 but should return 4.123.', [decisionRef]);
  assert.equal(newExample.detectedDefect, true);
  assert.equal(newExample.evidence.numericCounterexample, true);
  assert.equal(newExample.evidence.independentProbeMatched, false);
  assert.equal(newExample.passed, true);
});
