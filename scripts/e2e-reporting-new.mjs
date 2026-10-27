import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const auth = JSON.parse(await readFile('.e2e/auth.json', 'utf8'));
const base = process.env.POLYFORGE_E2E_BASE_URL ?? 'http://localhost:3310';
async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: { Origin: base, Cookie: auth.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} returned HTTP ${response.status}`);
  return response.json();
}

const company = await post('/api/companies', {
  name: `PolyForge reporting fixture ${Date.now()}`,
  description: 'Isolated organization reporting validation; no Graph runs',
});
assert.ok(company.id);
const issue = await post(`/api/companies/${company.id}/issues`, {
  title: 'ADLC organization setup', description: 'Isolated reporting validation', status: 'todo', priority: 'medium',
});
assert.ok(issue.id);
const sentinel = await post(`/api/companies/${company.id}/agents`, {
  name: 'Unmanaged sentinel', role: 'general', title: 'Custom local agent', capabilities: 'Do not modify during plugin reporting reconciliation',
  adapterType: 'codex_local', adapterConfig: {}, budgetMonthlyCents: 0, status: 'paused',
});
assert.ok(sentinel.id);
await writeFile('.e2e/reporting-new-fixture.json', JSON.stringify({ companyId: company.id, issueId: issue.id, sentinelId: sentinel.id }, null, 2));
console.log(`New isolated company ${company.id}; issue ${issue.id}; non-managed sentinel ${sentinel.id}`);
execFileSync(process.execPath, ['scripts/reconcile-adlc-reporting.mjs', '--provision'], {
  env: { ...process.env, POLYFORGE_ORG_COMPANY_ID: company.id, POLYFORGE_ORG_ISSUE_ID: issue.id },
  stdio: 'inherit',
});
