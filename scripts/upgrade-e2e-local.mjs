import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = 'http://localhost:3310';
const auth = JSON.parse(await readFile(new URL('../.e2e/auth.json', import.meta.url), 'utf8'));
const prior = JSON.parse(await readFile(new URL('../.e2e/result.json', import.meta.url), 'utf8'));
const pluginId = 'pohlee.polyforge-graph';
async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { Cookie: auth.cookie, Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status}: ${String(data.error ?? 'unknown').slice(0, 250)}`);
  return data;
}
for (let poll = 0; poll < 60; poll++) {
  try { if ((await request('GET', '/api/health')).status === 'ok') break; }
  catch { /* service is starting */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const upgraded = await request('POST', `/api/plugins/${pluginId}/upgrade`, {});
assert.equal(upgraded.version, '0.6.0');
assert.equal(upgraded.status, 'ready');
const installed = await request('GET', `/api/plugins/${pluginId}`);
assert.equal(installed.status, 'ready');
const graph = await request('GET', `/api/plugins/${pluginId}/api/issues/${prior.issueId}/graph`);
assert.equal(graph.pack.version, '0.1.8');
const implementation = graph.pack.graphs.find(item => item.id === 'implementation');
const design = graph.pack.graphs.find(item => item.id === 'ui-ux-design');
assert.equal(implementation.version, '0.1.2');
assert.equal(design.version, '0.1.2');
console.log(JSON.stringify({ pluginVersion: upgraded.version, status: installed.status,
  packVersion: graph.pack.version, graphCount: graph.pack.graphs.length,
  designVersion: design.version, implementationVersion: implementation.version,
  managedAgentCount: installed.manifest?.agents?.length,
  managedSkillCount: installed.manifest?.skills?.length }));
