// Controls only this uniquely named, disposable V1 container. Never creates volumes.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { buildStartInvocation } from './e2e-minimal-helpers.mjs';
import { candidateMetadata } from './e2e-candidate-metadata.mjs';

const name = 'polyforge-v1-triage-20261112';
const image = 'ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da';
async function docker(args, timeoutMs = 120000, env = process.env) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try { const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`docker ${args[0]} (${code}): ${err || out}`); return out; }
  finally { clearTimeout(timer); }
}
const mode = process.argv[2];
if (mode === 'start') {
  const candidate = resolve(process.argv[3]);
  const fixture = resolve('scripts/e2e-minimal-fixture-agent.mjs');
  const driver = resolve('scripts/e2e-minimal-graph.mjs');
  const helper = resolve('scripts/e2e-minimal-helpers.mjs');
  const identity = await candidateMetadata(process.argv[5], candidate);
  const { args, env } = buildStartInvocation({ candidate, fixture, driver, helper, image, name, identity });
  console.log(JSON.stringify({ stage: 'candidate-verified', candidateSha256: identity.sha256, version: identity.version }));
  await docker(args, 120000, env);
  console.log(JSON.stringify({ stage: 'container-created', name, createdAt: new Date().toISOString() }));
  const logs = spawn('docker', ['logs', '--follow', name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('Startup deadline exceeded')), 180000);
      const onData = chunk => { output += chunk; if (output.includes('Server startup recovery complete on 127.0.0.1:3100')) { clearTimeout(timer); ok(); } };
      logs.stdout.on('data', onData); logs.stderr.on('data', onData);
      logs.once('error', error => { clearTimeout(timer); fail(error); });
      logs.once('close', code => { clearTimeout(timer); fail(new Error(`Logs ended ${code} before readiness`)); });
    });
    console.log(JSON.stringify({ stage: 'startup-recovery-complete', name }));
  } catch (error) {
    await writeFile(resolve(process.argv[4]), JSON.stringify({ stage: 'startup-failed', message: error.message, logTail: output.slice(-12000) }, null, 2));
    throw error;
  } finally { logs.kill(); }
} else if (mode === 'run') {
  console.log(await docker(['exec', '-u', 'node', name, 'node', '/opt/v1/driver.mjs'], 180000));
} else if (mode === 'evidence') {
  const output = await docker(['exec', '-u', 'node', name, 'cat', '/paperclip/v1-evidence.json']);
  await writeFile(resolve(process.argv[3]), output); console.log(output);
} else if (mode === 'logs') {
  const output = await docker(['logs', '--tail', '400', name]);
  await writeFile(resolve(process.argv[3]), output); console.log('Saved isolated Host logs');
} else if (mode === 'stop') {
  console.log(await docker(['stop', '--time', '30', name]));
} else throw new Error('Use start, run, evidence, logs, or stop');
