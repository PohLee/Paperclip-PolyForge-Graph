import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.POLYFORGE_E2E_URL ?? 'http://localhost:3310';
const auth = JSON.parse(await readFile('.e2e/auth.json', 'utf8'));
const { companyId } = JSON.parse(await readFile('.e2e/result.json', 'utf8'));
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { Cookie: auth.cookie, Origin: base, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}
const settings = await request(`/plugins/pohlee.polyforge-graph/api/settings?companyId=${companyId}`);
assert.equal(settings.canEdit, true);
assert.ok(settings.agents.length > 0);
const payload = { companyId, operation: 'configure-settings', ...settings.config,
  expectedRevision: settings.config.revision, reason: 'Verify issue-free settings save with unchanged values',
  idempotencyKey: crypto.randomUUID() };
const saved = await request('/plugins/pohlee.polyforge-graph/api/company', 'POST', payload);
assert.deepEqual(saved.config, settings.config);
await assert.rejects(request('/plugins/pohlee.polyforge-graph/api/company', 'POST', {
  ...payload, expectedRevision: -1, idempotencyKey: crypto.randomUUID(),
}), /Settings changed/);

const agent = settings.agents.find(item => item.name === 'Product Owner');
assert.ok(agent, 'The E2E company needs its provisioned Product Owner');
for (const path of ['decision_model.md', 'goal.md', 'instruction.md', 'role.md', 'soul.md']) {
  const endpoint = `/agents/${agent.id}/instructions-bundle/file`;
  const before = await request(`${endpoint}?path=${encodeURIComponent(path)}`);
  assert.equal(before.editable, true);
  assert.equal(typeof before.contentHash, 'string');
  const updated = await request(endpoint, 'PUT', { path, content: before.content, baseHash: before.contentHash });
  const after = await request(`${endpoint}?path=${encodeURIComponent(path)}`);
  assert.equal(updated.content, before.content);
  assert.equal(after.content, before.content);
}
const result = { companyId, settingsSavedWithoutIssue: true, staleRevisionRejected: true,
  documentsReadSavedAndReread: 5, valuesAndDocumentsUnchanged: true,
  roles: settings.roles.length, agents: settings.agents.length };
await writeFile('.e2e/settings-host-acceptance.json', JSON.stringify(result, null, 2) + '\n');
console.log('Settings E2E passed: issue-free save, stale revision rejection and five native documents. Original values preserved.');
