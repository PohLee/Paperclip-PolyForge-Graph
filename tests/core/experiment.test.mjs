import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBehavior, trajectoryReview } from '../../src/host/experiment.mjs';

const experiment = {
  model: 'pinned-model', toolsVersion: 'tools-1', repoSha: 'a'.repeat(40), packDigest: 'b'.repeat(64),
  changedVariable: 'skillDescription',
  baseline: { temperature: 0, skillDescription: 'generic' },
  candidate: { temperature: 0, skillDescription: 'triggered' },
  scenarios: [{ id: 'missing-telemetry', requirement: 'Missing telemetry remains unknown' },
    { id: 'independent-review', requirement: 'Review current candidate' }], repetitions: 2,
};

test('behavior comparison reports per-scenario flips and critical regressions', async () => {
  const report = await compareBehavior(experiment, {
    runCase: async ({ scenario, variant }) => ({ response: `${scenario.id}:${variant}`, trajectoryRef: 'trace:1' }),
    assess: async ({ scenario, variant }) => ({
      pass: scenario.id === 'missing-telemetry' ? variant === 'baseline' : true,
      criticalFailure: scenario.id === 'missing-telemetry' && variant === 'candidate', evidence: ['trace:1'],
    }),
  });
  assert.equal(report.eligible, false);
  assert.equal(report.perScenario[0].passToFail, 2);
  assert.equal(report.perScenario[0].criticalRegressions, 2);
  assert.equal(report.results[0].metrics.inputTokens, null);
  assert.equal(report.results.length, 8);
  await assert.rejects(compareBehavior({ ...experiment,
    candidate: { temperature: 1, skillDescription: 'triggered' } }, { runCase() {}, assess() {} }), /exactly the changed variable/);
});

test('trajectory review uses observable actions and failure references', () => {
  assert.deepEqual(trajectoryReview([{ action: 'tool', inputRef: 'call:1', resultRef: 'result:1' },
    { action: 'submit', error: 'missing evidence' }]).map(item => item.failure), [null, 'missing evidence']);
});

test('provider failure is an invalid trial rather than a measured regression', async () => {
  const report = await compareBehavior({ ...experiment, scenarios: experiment.scenarios.slice(0, 1) }, {
    runCase: async ({ variant }) => {
      if (variant === 'candidate') throw new Error('provider unavailable');
      return { response: 'healthy' };
    },
    assess: async () => ({ pass: true, criticalFailure: false, evidence: ['result'] }),
  });
  assert.equal(report.eligible, false);
  assert.equal(report.perScenario[0].invalidTrials, 2);
  assert.equal(report.perScenario[0].passToFail, 0);
});
