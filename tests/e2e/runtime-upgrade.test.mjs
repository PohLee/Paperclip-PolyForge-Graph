import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ARTIFACT_FILES, createRuntimeArtifact, verifyRuntimeArtifact } from '../../scripts/runtime-artifact.mjs';
import { runRuntimePreflight } from '../../scripts/runtime-preflight.mjs';
import { assertReviewedPreflight, upgradeRuntime } from '../../scripts/upgrade-runtime.mjs';

test('upgrade checks actual candidate bytes, complete admin company scope and installed source before mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ARTIFACT_FILES) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), file === 'package.json' ? '{"version":"0.8.0"}' : '// synthetic artifact, never executed');
  }
  const runtime = { version: '0.8.0', schemaVersion: 1, contracts: { graph: 1 }, capabilities: { 'company-control': '1.0.0' } };
  await createRuntimeArtifact(root, runtime, runtime.version);
  assert.equal((await verifyRuntimeArtifact(root)).artifact.runtime.version, '0.8.0');
  const auth = join(root, 'private-auth.json'), report = join(root, 'report.json');
  await writeFile(auth, '{"cookie":"synthetic-session"}');
  const calls = [], companies = [{ id: 'a' }, { id: 'b' }];
  let admin = true, compatible = true, installedPath = '/some-other-source';
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method });
    let value;
    if (path === '/api/cli-auth/me') value = { isInstanceAdmin: admin, userId: 'owner' };
    else if (path === '/api/companies') value = companies;
    else if (path.endsWith('/api/company')) value = { ok: compatible, checked: true };
    else if (path.endsWith('/upgrade')) value = { version: '0.8.0' };
    else value = { packageName: '@pohlee/paperclip-polyforge-graph', packagePath: installedPath };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const options = { base: 'http://localhost:3312', auth, candidate: root, report };
  const reviewed = await runRuntimePreflight(options, fetchImpl);
  assert.deepEqual(reviewed.companyIds, ['a', 'b']);
  await writeFile(report, JSON.stringify(reviewed));
  assert.equal((await upgradeRuntime(options, fetchImpl)).applied, false);
  await assert.rejects(upgradeRuntime({ ...options, apply: true }, fetchImpl), /Installed source/);
  assert.equal(calls.some(call => call.path.endsWith('/upgrade')), false);
  installedPath = root;
  assert.equal((await upgradeRuntime({ ...options, apply: true }, fetchImpl)).applied, true);
  admin = false;
  await assert.rejects(runRuntimePreflight(options, fetchImpl), /verified Paperclip instance admin/);
  admin = true; compatible = false;
  const rejected = await runRuntimePreflight(options, fetchImpl);
  assert.throws(() => assertReviewedPreflight(reviewed, rejected), /compatible preflight changed/);
  compatible = true; companies.push({ id: 'c' });
  assert.throws(() => assertReviewedPreflight(reviewed, { ...reviewed, companyIds: ['a', 'b', 'c'] }), /company set/);
  await writeFile(join(root, 'dist/worker.js'), '// modified after review');
  await assert.rejects(runRuntimePreflight(options, fetchImpl), /byte mismatch/);
});
