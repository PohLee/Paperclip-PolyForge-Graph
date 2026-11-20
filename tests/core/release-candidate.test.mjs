import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonical } from '../../src/core/canonical.mjs';
import { CORE_RUNTIME } from '../../src/core/compatibility.mjs';
import { GraphEngine } from '../../src/core/index.mjs';
import { createPackSnapshot } from '../../src/plugin/pack-snapshot.mjs';
import { ARTIFACT_FILES, createRuntimeArtifact } from '../../scripts/runtime-artifact.mjs';
import { candidateMetadata } from '../../scripts/e2e-candidate-metadata.mjs';
import { assertCandidateIdentity, buildStartInvocation } from '../../scripts/e2e-minimal-helpers.mjs';
import { preflightWorkflowCompositionHost } from '../../scripts/e2e-workflow-composition-host.mjs';

async function createCandidate(parent, marker, snapshot = marker) {
  const dir = join(parent, 'package');
  for (const name of ARTIFACT_FILES) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name === 'package.json' ? '{"version":"0.8.10"}' :
      name === 'dist/packs-catalog.json' ? snapshot : marker);
  }
  await mkdir(join(dir, 'migrations'));
  await writeFile(join(dir, 'migrations/001.sql'), 'select 1;');
  await createRuntimeArtifact(dir, { version: '0.8.10', schemaVersion: 1, contracts: {}, capabilities: {} }, '0.8.10');
  return dir;
}

async function createCompositionCandidate(dir, packs) {
  const candidate = await createCandidate(dir, 'fixture', JSON.stringify(createPackSnapshot(packs)));
  const archive = join(dir, 'candidate.tar');
  await writeFile(archive, execFileSync('tar', ['-cf', '-', 'package'], { cwd: dir }));
  return { archive, candidate };
}

test('release source metadata is aligned and public identity is mandatory', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const manifest = (await import('../../src/plugin/manifest.mjs')).default;
  assert.equal(pkg.version, '0.8.10');
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(CORE_RUNTIME.version, pkg.version); assert.equal(manifest.version, pkg.version);
  assert.throws(() => assertCandidateIdentity({ sha256: 'bad', version: pkg.version }), /required/);
  assert.throws(() => assertCandidateIdentity({ sha256: 'a'.repeat(64), version: '' }), /required/);
  const identity = { sha256: 'a'.repeat(64), version: pkg.version };
  const { args } = buildStartInvocation({ candidate: 'c', fixture: 'f', driver: 'd', helper: 'h', image: 'i', name: 'n', identity, baseEnv: {}, generate: () => 'fixture-secret' });
  assert.ok(args.includes(`POLYFORGE_V1_CANDIDATE_SHA256=${identity.sha256}`));
  assert.ok(args.includes(`POLYFORGE_V1_CANDIDATE_VERSION=${identity.version}`));
  assert.throws(() => buildStartInvocation({ candidate: 'c', fixture: 'f', driver: 'd', helper: 'h', image: 'i', name: 'n', baseEnv: {}, generate: () => 'fixture-secret' }), /required/);
});

test('archive identity matches the verified extracted artifact and rejects a different root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-rc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await createCandidate(join(root, 'a'), 'A'), b = await createCandidate(join(root, 'b'), 'B');
  const archive = join(root, 'candidate.tar');
  await writeFile(archive, execFileSync('tar', ['-cf', '-', 'package'], { cwd: join(root, 'a') }));
  const identity = await candidateMetadata(archive, a);
  assert.match(identity.sha256, /^[0-9a-f]{64}$/); assert.equal(identity.version, '0.8.10');
  await assert.rejects(candidateMetadata(archive, b), /differs from archive/);
  const corruptedArchive = join(root, 'corrupted.tar');
  await writeFile(join(a, 'dist/worker.js'), 'altered only in archive');
  await writeFile(corruptedArchive, execFileSync('tar', ['-cf', '-', 'package'], { cwd: join(root, 'a') }));
  await writeFile(join(a, 'dist/worker.js'), 'A');
  await assert.rejects(candidateMetadata(corruptedArchive, a), /differs from archive: dist\/worker.js/);
  await writeFile(join(a, 'dist/worker.js'), 'tampered');
  await assert.rejects(candidateMetadata(archive, a), /byte mismatch/);
});

test('Core registration and workflow composition host preflight validate the same release digest formats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-pack-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = { version: '1.0.0', id: 'release-fixture', roles: {}, graphs: [
    { version: '1', start: 'end', nodes: [{ type: 'end', id: 'end' }], id: 'graph', edges: [] },
  ] };
  const digest = json => `sha256:${createHash('sha256').update(json).digest('hex')}`;
  const legacy = digest(JSON.stringify(payload));
  const sorted = digest(canonical(payload));
  assert.notEqual(legacy, sorted);
  const legacyRelease = { ...payload, release: { digest: legacy } };
  const canonicalRelease = { ...payload, release: { digest: sorted, status: 'candidate' } };
  const reorder = pack => Object.fromEntries(Object.entries(pack).reverse());
  const reorderedLegacy = reorder(legacyRelease);
  assert.deepEqual(reorderedLegacy, legacyRelease);
  assert.notEqual(JSON.stringify(reorderedLegacy), JSON.stringify(legacyRelease));
  const tampered = { ...canonicalRelease, graphs: [{ ...payload.graphs[0], description: 'changed after hashing' }] };
  const cases = [
    { name: 'legacy', pack: legacyRelease, core: true, host: true },
    { name: 'canonical with different key orders', pack: canonicalRelease, mounted: reorder(canonicalRelease), core: true, host: true },
    { name: 'legacy digest invalid for archive', pack: reorderedLegacy, mounted: legacyRelease, core: false, host: false },
    { name: 'legacy digest invalid for mount', pack: legacyRelease, mounted: reorderedLegacy, core: true, host: false },
    { name: 'tampered content', pack: tampered, core: false, host: false },
    { name: 'absent release', pack: payload, core: true, host: false },
    { name: 'release without a digest', pack: { ...payload, release: {} }, core: false, host: false },
  ];
  for (const [index, { name, pack, mounted = pack, core, host }] of cases.entries()) {
    await t.test(name, async () => {
      const dir = join(root, String(index));
      const candidate = await createCompositionCandidate(dir, [pack]);
      await writeFile(join(dir, 'index.mjs'), `export const packs = ${JSON.stringify([mounted])};`);

      const registered = new GraphEngine().registerPacks([pack]);
      const preflight = preflightWorkflowCompositionHost({ ...candidate, packs: dir });
      const releaseMismatch = /Immutable release digest does not match Pack payload/;
      await Promise.all([
        core ? assert.doesNotReject(registered) : assert.rejects(registered, releaseMismatch),
        host ? assert.doesNotReject(preflight) : assert.rejects(preflight, releaseMismatch),
      ]);
    });
  }
});

test('workflow composition host preflight verifies the exact releases loaded from the mounted entry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-pack-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = { id: 'release-fixture', version: '1.0.0', roles: {}, graphs: [
    { id: 'graph', version: '1', start: 'end', nodes: [{ id: 'end', type: 'end' }], edges: [] },
  ] };
  const release = pack => ({ ...pack, release: { digest: `sha256:${createHash('sha256').update(canonical(pack)).digest('hex')}` } });
  const expected = release(payload);
  const changed = release({ ...payload, description: 'different mounted content' });
  const otherVersion = release({ ...payload, version: '2.0.0' });
  const candidate = await createCompositionCandidate(join(root, 'candidate'), [expected]);
  const cases = [
    { name: 'single Pack export', source: `export const pack = ${JSON.stringify(expected)};` },
    { name: 'contradictory packCatalog export',
      source: `export const packs = ${JSON.stringify([changed])};
        export const packCatalog = ${JSON.stringify({ [expected.id]: expected })};`,
      error: /Mounted Pack release-fixture@1\.0\.0 differs from candidate snapshot/ },
    { name: 'missing exact release', source: `export const packs = ${JSON.stringify([otherVersion])};`,
      error: /Pack release-fixture@1\.0\.0 is not installed/ },
    { name: 'unexpected installed release', source: `export const packs = ${JSON.stringify([expected, otherVersion])};`,
      error: /Mounted Pack release inventory differs from candidate snapshot/ },
  ];
  for (const [index, { name, source, error }] of cases.entries()) {
    await t.test(name, async () => {
      const packs = join(root, String(index));
      await mkdir(packs);
      await writeFile(join(packs, 'index.mjs'), source);
      const preflight = preflightWorkflowCompositionHost({ ...candidate, packs });
      if (error) await assert.rejects(preflight, error);
      else await assert.doesNotReject(preflight);
    });
  }
});
