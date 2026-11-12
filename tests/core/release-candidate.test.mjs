import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CORE_RUNTIME } from '../../src/core/compatibility.mjs';
import { ARTIFACT_FILES, createRuntimeArtifact } from '../../scripts/runtime-artifact.mjs';
import { candidateMetadata } from '../../scripts/e2e-candidate-metadata.mjs';
import { assertCandidateIdentity, buildStartInvocation } from '../../scripts/e2e-minimal-helpers.mjs';

test('release source metadata is aligned and public identity is mandatory', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const manifest = (await import('../../src/plugin/manifest.mjs')).default;
  assert.equal(pkg.version, '0.8.9');
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
  const create = async (parent, marker) => {
    const dir = join(parent, 'package');
    for (const name of ARTIFACT_FILES) {
      const path = join(dir, name); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, name === 'package.json' ? '{"version":"0.8.9"}' : marker);
    }
    await mkdir(join(dir, 'migrations')); await writeFile(join(dir, 'migrations/001.sql'), 'select 1;');
    await createRuntimeArtifact(dir, { version: '0.8.9', schemaVersion: 1, contracts: {}, capabilities: {} }, '0.8.9');
    return dir;
  };
  const a = await create(join(root, 'a'), 'A'), b = await create(join(root, 'b'), 'B');
  const archive = join(root, 'candidate.tar');
  execFileSync('tar', ['-cf', archive, '-C', join(root, 'a'), 'package']);
  const identity = await candidateMetadata(archive, a);
  assert.match(identity.sha256, /^[0-9a-f]{64}$/); assert.equal(identity.version, '0.8.9');
  await assert.rejects(candidateMetadata(archive, b), /differs from archive/);
  const corruptedArchive = join(root, 'corrupted.tar');
  await writeFile(join(a, 'dist/worker.js'), 'altered only in archive');
  execFileSync('tar', ['-cf', corruptedArchive, '-C', join(root, 'a'), 'package']);
  await writeFile(join(a, 'dist/worker.js'), 'A');
  await assert.rejects(candidateMetadata(corruptedArchive, a), /differs from archive: dist\/worker.js/);
  await writeFile(join(a, 'dist/worker.js'), 'tampered');
  await assert.rejects(candidateMetadata(archive, a), /byte mismatch/);
});
