// Build and run the contracted workflow fixture in the pinned official Host image.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { assertPackReleaseDigest } from '../src/core/pack-release.mjs';
import { loadCatalog, selectPack } from '../src/plugin/catalog.mjs';
import { readPackSnapshot } from '../src/plugin/pack-snapshot.mjs';
import { candidateMetadata } from './e2e-candidate-metadata.mjs';
import { signerEnvironment, assertSignerArgv } from './e2e-minimal-helpers.mjs';

const image = 'ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da';
const name = `polyforge-composition-${process.pid}`;
const driver = resolve('scripts/e2e-workflow-composition.mjs');
const fixture = resolve('scripts/e2e-workflow-composition-fixture-agent.mjs');
const helper = resolve('scripts/e2e-minimal-helpers.mjs');

async function docker(args, timeoutMs = 120000, env = process.env) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error(`docker ${args[0]} (${code}): ${err || out}`);
    return args[0] === 'logs' ? out + err : out;
  } finally { clearTimeout(timer); }
}

async function waitReady() {
  const logs = spawn('docker', ['logs', '--follow', name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Official Host startup deadline exceeded')), 180000);
      const onData = chunk => {
        output += chunk;
        if (output.includes('Server startup recovery complete on 127.0.0.1:3100')) { clearTimeout(timer); resolveReady(); }
      };
      logs.stdout.on('data', onData); logs.stderr.on('data', onData);
      logs.once('error', error => { clearTimeout(timer); reject(error); });
      logs.once('close', code => { clearTimeout(timer); reject(new Error(`Host logs ended ${code} before readiness`)); });
    });
  } catch (error) {
    await writeFile(resolve('.e2e/workflow-composition-startup-failed.json'), JSON.stringify({ error: error.message, logTail: output.slice(-12000) }, null, 2));
    throw error;
  } finally { logs.kill(); }
}

export async function preflightWorkflowCompositionHost({ archive, candidate, packs }) {
  const identity = await candidateMetadata(archive, candidate);
  const archivedPacks = readPackSnapshot(JSON.parse(await readFile(resolve(candidate, 'dist/packs-catalog.json'), 'utf8')));
  const mountedPacks = await loadCatalog({ entries: [resolve(packs, 'index.mjs')] });
  for (const pack of archivedPacks) {
    const mountedPack = selectPack(mountedPacks, pack.id, pack.version);
    assert.deepEqual(mountedPack, pack, `Mounted Pack ${pack.id}@${pack.version} differs from candidate snapshot`);
    // A legacy digest depends on each copy's key order.
    assertPackReleaseDigest(pack);
    assertPackReleaseDigest(mountedPack);
  }
  assert.equal(mountedPacks.length, archivedPacks.length, 'Mounted Pack release inventory differs from candidate snapshot');
  return identity;
}

async function main() {
  const candidate = resolve(process.argv[2] ?? '.');
  const archive = resolve(process.argv[3] ?? '.e2e/workflow-composition-candidate.tgz');
  const evidence = resolve(process.argv[4] ?? '.e2e/workflow-composition-evidence.json');
  const packs = resolve(process.argv[5] ?? '../Paperclip-PolyForge-Graph-Packs');
  // Operator config is outside the immutable runtime manifest. Place it in the
  // disposable extracted candidate so Kiri need not create a nested mount point
  // under an already read-only bind mount. Never replace an existing config.
  const runtimeConfig = resolve(candidate, 'polyforge.runtime.json');
  const identity = await preflightWorkflowCompositionHost({ archive, candidate, packs });
  const creativeToken = randomBytes(32).toString('hex');
  const signer = { ...signerEnvironment(), POLYFORGE_CREATIVE_E2E_TOKEN: creativeToken,
    POLYFORGE_CREATIVE_E2E_PORT: '3218', POLYFORGE_COMPOSITION_PACK: process.argv[6] ?? '' };
  await writeFile(runtimeConfig, JSON.stringify({ creativeHost: {
    artifactRoot: '/paperclip/creative-artifacts', gatewayUrl: 'http://127.0.0.1:3218',
    gatewayTokenFile: '/paperclip/creative-gateway-token', timeoutMs: 8000, allowedImageProviderIds: [],
  } }, null, 2), { mode: 0o600, flag: 'wx' });
  let savedEvidence = false;
  try {
  const args = ['run', '--pull', 'never', '-d', '--name', name, '--network', 'none', '--memory', '3g', '--cpus', '3',
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
    '--tmpfs', '/paperclip:rw,uid=1000,gid=1000,mode=0700,size=536870912', '--tmpfs', '/tmp:rw,mode=1777,size=134217728',
    '--mount', `type=bind,source=${candidate},target=/opt/polyforge/plugin,readonly`,
    '--mount', `type=bind,source=${packs},target=/opt/polyforge/packs,readonly`,
    '--mount', `type=bind,source=${driver},target=/opt/v1/driver.mjs,readonly`,
    '--mount', `type=bind,source=${fixture},target=/opt/v1/fixture.mjs,readonly`,
    '--mount', `type=bind,source=${helper},target=/opt/v1/e2e-minimal-helpers.mjs,readonly`,
    '-e', 'HOST=127.0.0.1', '-e', 'PAPERCLIP_BIND=loopback', '-e', 'PAPERCLIP_DEPLOYMENT_MODE=local_trusted',
    '-e', 'SERVE_UI=false', '-e', 'PAPERCLIP_TELEMETRY_DISABLED=1',
    '-e', 'POLYFORGE_PACK_ENTRIES=/opt/polyforge/packs/index.mjs',
    '-e', 'POLYFORGE_FIXTURE_AGENT_SCRIPT=/opt/v1/fixture.mjs',
    '-e', 'POLYFORGE_COMPOSITION_WRONG_AGENT_FILE=/paperclip/workflow-composition-wrong-agent.json',
    '-e', 'POLYFORGE_CREATIVE_E2E_TOKEN', '-e', 'POLYFORGE_CREATIVE_E2E_PORT',
    '-e', 'POLYFORGE_COMPOSITION_PACK',
    '-e', 'PAPERCLIP_AGENT_JWT_SECRET',
    '-e', `POLYFORGE_V1_CANDIDATE_SHA256=${identity.sha256}`,
    '-e', `POLYFORGE_V1_CANDIDATE_VERSION=${identity.version}`, image];
  assertSignerArgv(args, signer);
  console.log(JSON.stringify({ stage: 'candidate-verified', sha256: identity.sha256, version: identity.version, image }));
    // Kiri may need several minutes to materialize a cold multi-gigabyte image.
    await docker(args, 600000, signer);
    await waitReady();
    console.log(JSON.stringify({ stage: 'official-host-ready', name }));
    let runError = null;
    try {
      const output = await docker(['exec', '-u', 'node', name, 'node', '/opt/v1/driver.mjs'], 30 * 60_000);
      console.log(output);
    } catch (error) { runError = error; }
    try {
      const recorded = await docker(['exec', '-u', 'node', name, 'cat', '/paperclip/workflow-composition-evidence.json']);
      await writeFile(evidence, recorded, { mode: '0600' });
      savedEvidence = true;
      console.log(JSON.stringify({ stage: 'evidence-saved', path: evidence }));
    } catch (error) { if (!runError) runError = error; }
    if (runError) throw runError;
  } catch (error) {
    if (!savedEvidence) {
      const startup = await readFile(resolve('.e2e/workflow-composition-startup-failed.json'), 'utf8').catch(() => null);
      await writeFile(evidence, JSON.stringify({ stage: 'host-or-driver-failed', error: error.message,
        startupFailure: startup ? JSON.parse(startup) : null }, null, 2), { mode: 0o600 }).catch(() => {});
    }
    throw error;
  } finally {
    const hostLog = await docker(['logs', '--tail', '120', name]).catch(error => error.message);
    await writeFile(`${evidence}.host.log`, hostLog);
    await docker(['stop', '--time', '30', name], 45000).catch(error => console.error(`Container cleanup: ${error.message}`));
    await docker(['rm', name]).catch(error => console.error(`Container removal: ${error.message}`));
    await rm(runtimeConfig, { force: true }).catch(error => console.error(`Runtime config cleanup: ${error.message}`));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
