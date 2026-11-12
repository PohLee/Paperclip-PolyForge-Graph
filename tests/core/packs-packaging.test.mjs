import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { readBuildPackSource } from '../../scripts/pack-build-source.mjs';
import { trustedPackImportPlugin } from '../../scripts/trusted-pack-imports.mjs';
import { readPackSnapshot, packDigest } from '../../src/plugin/pack-snapshot.mjs';
import { ARTIFACT_FILES, createRuntimeArtifact, verifyRuntimeArtifact } from '../../scripts/runtime-artifact.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-packaging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(path, data) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
async function workerHealth(path) {
  const env = { ...process.env };
  for (const name of ['POLYFORGE_PACK_ENTRIES', 'POLYFORGE_PACKS_ENTRY', 'POLYFORGE_ADLC_PACK_ENTRY']) delete env[name];
  const child = spawn(process.execPath, [path], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    return await new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker health timed out: ${errors}`)), 15000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`worker exited ${code}: ${errors}`)));
      child.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.method && message.id !== undefined) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'db.query' ? [] : null })}\n`);
          } else if (message.id === 1) {
            if (!message.result?.ok) { clearTimeout(timeout); reject(new Error(JSON.stringify(message))); return; }
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'health', params: {} })}\n`);
          } else if (message.id === 2) { clearTimeout(timeout); resolveResult(message.result); }
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        manifest: { id: 'pohlee.polyforge-graph', tools: [{ name: 'graph-command' }, { name: 'company-command' }] },
        config: {}, databaseNamespace: 'plugin_worker_smoke',
      } })}\n`);
    });
  } finally { child.kill(); }
}
const fixturePack = (id, marker) => ({ id, version: '1.0.0', graphs: [],
  roles: { maker: { id: 'maker', name: marker, capabilityRequirements: [], skills: [], documents: { instruction: marker } } },
  skills: { skill: { id: 'skill', content: marker } } });
async function fixture(root, marker) {
  const adlc = fixturePack('adlc', marker), creative = fixturePack('creative-team', marker);
  await write(join(root, 'packs/adlc/index.mjs'), `export const pack=${JSON.stringify(adlc)};`);
  await write(join(root, 'packs/adlc-creative-team/index.mjs'), `export const pack=${JSON.stringify(creative)};`);
  await write(join(root, 'packs/adlc/runtime/host-api.mjs'), `export function createAdlcHostApi(){return '${marker}';}`);
  await write(join(root, 'packs/adlc-creative-team/runtime/host-api.mjs'), `export function createCreativeHostApi(){return '${marker}';} export const creativeRequiredServicesByGraph={};`);
  await write(join(root, 'index.mjs'), `import {pack as a} from './packs/adlc/index.mjs'; import {pack as c} from './packs/adlc-creative-team/index.mjs'; export const packs=[a,c,${JSON.stringify(fixturePack('marketing', marker))}];`);
}

test('selected Pack root supplies manifest, snapshot, digests and executable adapters', async t => {
  const dir = await temp(t), a = join(dir, 'A'), b = join(dir, 'B'), out = join(dir, 'package');
  await fixture(a, 'from-A'); await fixture(b, 'from-B');
  const sourceA = await readBuildPackSource(a), source = await readBuildPackSource(b);
  assert.notEqual(source.snapshot.packs[0].digest, sourceA.snapshot.packs[0].digest);
  await assert.rejects(readBuildPackSource(join(dir, 'missing')));
  const extra = join(dir, 'extra');
  await fixture(extra, 'extra');
  await write(join(extra, 'index.mjs'), `export const packs=[${JSON.stringify(fixturePack('adlc', 'extra'))},${JSON.stringify(fixturePack('creative-team', 'extra'))},${JSON.stringify(fixturePack('marketing', 'extra'))},${JSON.stringify(fixturePack('experimental', 'extra'))}];`);
  await assert.rejects(readBuildPackSource(extra), /exactly the main/);
  await write(join(out, 'package.json'), JSON.stringify({ name: '@pohlee/paperclip-polyforge-graph', type: 'module' }));
  const snapshotBytes = JSON.stringify(source.snapshot);
  const snapshotDigest = createHash('sha256').update(snapshotBytes).digest('hex');
  const snapshotDefine = { __POLYFORGE_BUILT__: 'true', __PACK_SNAPSHOT_SHA256__: JSON.stringify(snapshotDigest) };
  await write(join(out, 'dist/packs-catalog.json'), snapshotBytes);
  await build({ entryPoints: ['src/plugin/manifest.mjs'], outfile: join(out, 'dist/manifest.js'), bundle: true, packages: 'bundle', platform: 'node', format: 'esm', logLevel: 'silent',
    define: { ...snapshotDefine, __BUILT_PACK_CATALOG__: JSON.stringify(source.snapshot.packs.map(row => row.pack)) } });
  await build({ entryPoints: ['src/plugin/catalog.mjs'], outfile: join(out, 'dist/catalog.js'), bundle: true, packages: 'bundle', platform: 'node', format: 'esm', logLevel: 'silent', define: snapshotDefine });
  await build({ entryPoints: ['src/plugin/catalog-loader-worker.mjs'], outfile: join(out, 'dist/catalog-loader-worker.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  await build({ entryPoints: ['src/plugin/trusted-pack-adapters.mjs'], outfile: join(out, 'dist/trusted-pack-adapters.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [trustedPackImportPlugin(b)],
    define: { __TRUSTED_ADLC_PACK__: JSON.stringify(JSON.stringify(source.adlc)), __TRUSTED_CREATIVE_PACK__: JSON.stringify(JSON.stringify(source.creative)) } });
  await build({ entryPoints: ['src/plugin/worker.mjs'], outfile: join(out, 'dist/worker.js'), bundle: true, packages: 'bundle', platform: 'node', format: 'esm', logLevel: 'silent', external: ['./trusted-pack-adapters.mjs'], define: snapshotDefine });
  const manifest = (await import(pathToFileURL(join(out, 'dist/manifest.js')).href)).default;
  const adapters = (await import(pathToFileURL(join(out, 'dist/trusted-pack-adapters.mjs')).href)).trustedPackAdapters;
  assert.equal(manifest.agents.find(x => x.agentKey === 'adlc:maker').displayName, 'adlc · from-B');
  assert.equal(manifest.skills.find(x => x.skillKey === 'adlc:skill').markdown, 'from-B');
  assert.equal(adapters[0].createHostApi(), 'from-B');
  assert.equal(adapters[1].createHostApi(), 'from-B');
  assert.equal(adapters[0].packDigest, source.snapshot.packs[0].digest);
  assert.equal(adapters[0].packDigest, packDigest(source.adlc));
  const catalog = await import(pathToFileURL(join(out, 'dist/catalog.js')).href);
  assert.equal((await catalog.loadCatalog()).length, 3);
  const ready = await workerHealth(join(out, 'dist/worker.js'));
  assert.equal(ready.status, 'ok');
  assert.deepEqual(ready.details.catalog, ['adlc@1.0.0', 'creative-team@1.0.0', 'marketing@1.0.0']);
  const truncated = structuredClone(source.snapshot); truncated.packs.pop();
  await write(join(out, 'dist/packs-catalog.json'), JSON.stringify(truncated));
  await assert.rejects(catalog.loadCatalog({ force: true }), /build digest/);
  await assert.rejects(import(`${pathToFileURL(join(out, 'dist/manifest.js')).href}?truncated`), /build digest/);
  const degraded = await workerHealth(join(out, 'dist/worker.js'));
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.message, /build digest/);
  await write(join(out, 'dist/packs-catalog.json'), snapshotBytes);
  await write(join(out, 'polyforge.runtime.json'), JSON.stringify({ packEntries: [join(a, 'index.mjs')] }));
  assert.equal((await catalog.loadCatalog({ force: true }))[0].roles.maker.name, 'from-A');
  const overridden = (await import(`${pathToFileURL(join(out, 'dist/manifest.js')).href}?configured`)).default;
  assert.equal(overridden.agents.find(x => x.agentKey === 'adlc:maker').displayName, 'adlc · from-A');
  await assert.rejects(catalog.loadCatalog({ entries: [join(dir, 'missing.mjs')] }));
  await write(join(out, 'polyforge.runtime.json'), JSON.stringify({ packEntries: [join(dir, 'missing.mjs')] }));
  await assert.rejects(catalog.loadCatalog());
  await rm(join(out, 'polyforge.runtime.json'));
  await write(join(out, 'dist/packs-catalog.json'), '{bad json');
  await assert.rejects(catalog.loadCatalog({ force: true }), /build digest/);
  await assert.rejects(import(`${pathToFileURL(join(out, 'dist/manifest.js')).href}?invalid`), /build digest/);
  const invalid = structuredClone(source.snapshot); invalid.packs[0].pack.version = '2.0.0';
  await write(join(out, 'dist/packs-catalog.json'), JSON.stringify(invalid));
  await assert.rejects(catalog.loadCatalog({ force: true }), /build digest/);
  const duplicate = structuredClone(source.snapshot); duplicate.packs.push(duplicate.packs[0]);
  await write(join(out, 'dist/packs-catalog.json'), JSON.stringify(duplicate));
  await assert.rejects(catalog.loadCatalog(), /build digest/);
  await rm(join(out, 'dist/packs-catalog.json'));
  await assert.rejects(catalog.loadCatalog(), { code: 'ENOENT' });
});

test('snapshot rejects corruption, digest mismatch and duplicate releases', () => {
  const pack = fixturePack('adlc', 'valid'), row = { pack, digest: packDigest(pack) };
  assert.deepEqual(readPackSnapshot({ schemaVersion: 1, packs: [row] }), [pack]);
  assert.throws(() => readPackSnapshot({ schemaVersion: 1, packs: [{ ...row, digest: 'bad' }] }), /digest/);
  assert.throws(() => readPackSnapshot({ schemaVersion: 1, packs: [row, row] }), /Duplicate/);
  assert.throws(() => readPackSnapshot({ schemaVersion: 2, packs: [row] }), /Invalid/);
});

test('v3 binds catalog bytes and rejects v2; v2 verifier rejects v3', async t => {
  const root = await temp(t);
  for (const file of ARTIFACT_FILES) await write(join(root, file), file === 'package.json' ? '{"version":"0.8.7"}' : 'fixture');
  await write(join(root, 'migrations/001.sql'), 'select 1;');
  const artifact = await createRuntimeArtifact(root, { version: '0.8.7', schemaVersion: 1, contracts: {}, capabilities: {} }, '0.8.7');
  await verifyRuntimeArtifact(root);
  const old = execFileSync('git', ['show', 'e8c3e5f01c5b1cb4dfd8509e099328c2630f778f:scripts/runtime-artifact.mjs'], { encoding: 'utf8' })
    .replace("from 'semver'", `from '${pathToFileURL(resolve('node_modules/semver/index.js')).href}'`);
  const oldPath = join(root, 'old-verifier.mjs'); await writeFile(oldPath, old);
  const oldVerifier = await import(pathToFileURL(oldPath).href);
  await assert.rejects(oldVerifier.verifyRuntimeArtifact(root), /Invalid candidate runtime artifact/);
  const v2 = { ...artifact, format: 'polyforge-runtime-artifact-v2', files: { ...artifact.files } };
  delete v2.files['dist/packs-catalog.json'];
  await write(join(root, 'dist/runtime-artifact.json'), JSON.stringify(v2));
  await oldVerifier.verifyRuntimeArtifact(root);
  await assert.rejects(verifyRuntimeArtifact(root), /Invalid candidate runtime artifact/);
  await write(join(root, 'dist/runtime-artifact.json'), JSON.stringify(artifact));
  await write(join(root, 'dist/packs-catalog.json'), 'tampered');
  await assert.rejects(verifyRuntimeArtifact(root), /byte mismatch/);
});
