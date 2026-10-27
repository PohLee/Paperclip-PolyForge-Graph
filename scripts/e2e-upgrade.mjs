import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const origin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const pluginId = 'pohlee.polyforge-graph';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const auth = JSON.parse(await readFile(resolve(root, '.e2e/auth.json'), 'utf8'));
const previous = JSON.parse(await readFile(resolve(root, '.e2e/result.json'), 'utf8'));
const expectedPluginVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const graphPath = `/api/plugins/${pluginId}/api/issues/${previous.issueId}/graph`;

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: origin, Cookie: auth.cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 250) }; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ready() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* the service is restarting */ }
    await sleep(1500);
  }
  throw new Error('Paperclip did not become ready after restart');
}

await ready();
const upgrade = await request('POST', `/api/plugins/${pluginId}/upgrade`, {});
assert.equal(upgrade.version, expectedPluginVersion);
const oldAutonomous = await request('GET', `${graphPath}?runId=${previous.completed['ui-ux-design']}`);
assert.equal(oldAutonomous.run.status, 'completed');
assert.equal(oldAutonomous.run.mode, 'autonomous');
assert.equal(oldAutonomous.run.packVersion, '0.1.0');
const priorBindings = oldAutonomous.config.roleBindings;
const priorUserRoles = oldAutonomous.config.userRoles;

const configure = async (mode, suffix) => request('POST', graphPath, {
  operation: 'configure', defaultMode: mode,
  reason: `Synthetic owner changes the E2E company default to ${mode}`,
  idempotencyKey: `e2e:default-mode:${suffix}`
});
const firstConfig = await configure('manual', 'manual');
assert.equal(firstConfig.defaultMode, 'manual');
assert.deepEqual(firstConfig.roleBindings, priorBindings);
assert.deepEqual(firstConfig.userRoles, priorUserRoles);

const originalInput = oldAutonomous.run.input;
const input = fixture => ({
  feature: originalInput.feature,
  product_decision_refs: originalInput.product_decision_refs,
  productDecisionRefs: originalInput.productDecisionRefs,
  versioned_requirement: originalInput.versioned_requirement,
  fixture
});
const start = (fixture, mode) => request('POST', graphPath, {
  operation: 'start', graphId: 'ui-ux-design', input: input(fixture),
  ...(mode ? { mode } : {}), idempotencyKey: `e2e:default-mode:start:${fixture}`
});
const manual = await start('default-mode-manual');
assert.equal(manual.run.mode, 'manual');
assert.ok(manual.dispatch.some(item => item.nodeId === 'classify-design' && item.status === 'waiting_human'));
const secondConfig = await configure('assisted', 'assisted');
assert.equal(secondConfig.defaultMode, 'assisted');
const oldManual = await request('GET', `${graphPath}?runId=${manual.run.id}`);
assert.equal(oldManual.run.mode, 'manual');
assert.equal(oldManual.config.defaultMode, 'assisted');

execFileSync('docker', ['compose', '-f', 'compose.e2e.yml', '-p', 'polyforge-graph-e2e', 'restart', 'paperclip'], { cwd: root, stdio: 'ignore' });
await ready();
const afterManual = await request('GET', `${graphPath}?runId=${manual.run.id}`);
const afterAutonomous = await request('GET', `${graphPath}?runId=${previous.completed['ui-ux-design']}`);
assert.equal(afterManual.run.mode, 'manual');
assert.equal(afterManual.config.defaultMode, 'assisted');
assert.equal(afterAutonomous.run.mode, 'autonomous');
assert.equal(afterAutonomous.run.status, 'completed');
const assisted = await start('default-mode-assisted');
assert.equal(assisted.run.mode, 'assisted');
assert.equal(assisted.run.packVersion, '0.1.0');
const result = { pluginVersion: upgrade.version, companyId: previous.companyId, issueId: previous.issueId,
  existingAutonomousRunId: previous.completed['ui-ux-design'], omittedManualRunId: manual.run.id,
  omittedAssistedRunId: assisted.run.id, persistedDefaultMode: 'assisted', restarted: true };
await writeFile(resolve(root, '.e2e/upgrade-result.json'), JSON.stringify(result, null, 2));
console.log(`Default-mode upgrade E2E passed for company ${previous.companyId}; state saved in .e2e/upgrade-result.json`);
