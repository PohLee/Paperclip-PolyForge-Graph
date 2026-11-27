import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonical } from '../../src/core/canonical.mjs';
import { evaluateAdlcSkill } from '../../src/host/adlc-skill-eval.mjs';

const spec = {
  baseline: { id: 'adlc', version: '0.3.4', skills: { 'engineering-delivery': { content: 'Use the accepted plan' } } },
  candidate: { id: 'adlc', version: '0.3.5', skills: { 'engineering-delivery': { content: 'Inspect repo configuration first' } } },
  target: { skill: 'engineering-delivery' }, model: 'fixture', toolsVersion: 'v1', repoSha: 'a'.repeat(40)
};

const signals = {
  'repository-preflight': ['pinned-revision', 'read-build-config', 'source-command', 'record-unknown'],
  'changed-permissions': ['identify-trust-boundary', 'record-missing-analysis', 'link-control-to-check']
};

const packDigest = payload => `sha256:${createHash('sha256').update(payload).digest('hex')}`;
const release = (pack, encode) => ({ ...pack, release: { digest: packDigest(encode(pack)) } });
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;

test('skill evaluation preserves verified canonical and legacy release digests', async t => {
  for (const [name, prepare] of [
    ['canonical with reordered keys', pack => reorder(release(pack, canonical))],
    ['legacy JSON', pack => release(pack, JSON.stringify)],
  ]) {
    await t.test(name, async () => {
      const baseline = prepare(spec.baseline), candidate = prepare(spec.candidate);
      const runnerDigests = new Map();
      const report = await evaluateAdlcSkill({ ...spec, baseline, candidate }, {
        runCase: async ({ variant, settings, pinned }) => {
          runnerDigests.set(variant, settings.instructions.packDigest);
          assert.equal(pinned.packDigest, baseline.release.digest);
          return { trajectoryRef: 'fixture://trace' };
        },
        observe: async ({ scenarioId }) => ({ signals: signals[scenarioId], evidence: ['fixture://trace'] })
      });
      assert.equal(report.eligible, true);
      assert.equal(report.pinned.packDigest, baseline.release.digest);
      for (const [variant, pack] of Object.entries({ baseline, candidate })) {
        assert.equal(report.variants[variant].packDigest, pack.release.digest);
        assert.equal(runnerDigests.get(variant), pack.release.digest);
      }
    });
  }
});

test('skill evaluation rejects invalid releases before executing either variant', async t => {
  const valid = release(spec.candidate, canonical);
  const invalid = [
    ['incorrect digest', { ...valid, release: { digest: `sha256:${'0'.repeat(64)}` } }],
    ['tampered content', { ...valid, skills: { 'engineering-delivery': { content: 'Tampered instructions' } } }],
    ['missing digest', { ...valid, release: {} }],
    ['reordered legacy JSON', reorder(release(spec.candidate, JSON.stringify))],
  ];
  for (const variant of ['baseline', 'candidate']) {
    for (const [name, pack] of invalid) {
      await t.test(`${variant}: ${name}`, async () => {
        await assert.rejects(evaluateAdlcSkill({ ...spec, [variant]: pack }, {
          runCase: async () => assert.fail('Invalid releases must not execute'),
          observe: async () => assert.fail('Invalid releases must not be scored')
        }), /digest|intact ADLC Pack/);
      });
    }
  }
});

test('skill evaluation binds both inputs and scores recorded evidence independently', async () => {
  const runnerDigests = new Map();
  const runCase = async ({ scenario, pinned, variant, settings }) => {
    assert.ok(scenario.task);
    assert.equal(scenario.requirement, undefined);
    assert.equal(pinned.repoSha, spec.repoSha);
    runnerDigests.set(variant, settings.instructions.digest);
    return { trajectoryRef: `fixture://${scenario.id}/${variant}`, report: scenario.id, pass: true };
  };
  const observe = async ({ observation, scenarioId, variant }) => ({
    signals: variant === 'baseline' ? signals[scenarioId].slice(0, -1) : signals[scenarioId],
    evidence: [observation.trajectoryRef]
  });
  const report = await evaluateAdlcSkill(spec, { runCase, observe });
  assert.equal(report.eligible, true);
  assert.equal(report.results.length, 8);
  assert.deepEqual(report.perScenario.map(({ baselinePasses, candidatePasses }) => [baselinePasses, candidatePasses]), [[0, 2], [0, 2]]);
  assert.equal(report.variants.baseline.digest, runnerDigests.get('baseline'));
  assert.equal(report.variants.candidate.digest, runnerDigests.get('candidate'));
  assert.equal(report.variants.baseline.packDigest, packDigest(JSON.stringify(spec.baseline)));
  assert.equal(report.variants.candidate.packDigest, packDigest(JSON.stringify(spec.candidate)));
  assert.notEqual(report.variants.baseline.packDigest, report.variants.candidate.packDigest);
});

test('evaluations reject critical candidate claims and missing evidence', async () => {
  const runCase = async () => ({ pass: true, trajectoryRef: 'fixture://trace' });
  const observe = async ({ scenarioId, variant }) => ({ signals: variant === 'candidate' && scenarioId === 'changed-permissions'
    ? [...signals[scenarioId], 'proceeded-without-analysis'] : signals[scenarioId], evidence: ['fixture://trace'] });
  const report = await evaluateAdlcSkill(spec, { runCase, observe });
  assert.equal(report.eligible, false);
  assert.equal(report.perScenario.find(item => item.id === 'changed-permissions').criticalRegressions, 2);
  const missing = await evaluateAdlcSkill(spec, { runCase, observe: async () => ({ signals: [], evidence: [] }) });
  assert.equal(missing.eligible, false);
  assert.ok(missing.results.every(item => item.pass === null));
});
