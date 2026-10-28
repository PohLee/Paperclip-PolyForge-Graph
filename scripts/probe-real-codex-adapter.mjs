import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const base = 'http://localhost:3311';
const auth = JSON.parse(await readFile(new URL('../.e2e/real-auth.json', import.meta.url), 'utf8'));
async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: base, Cookie: auth.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path} returned HTTP ${response.status}`);
  return data;
}

const company = await request('POST', '/api/companies', {
  name: `PolyForge real adapter probe ${Date.now()}`,
  description: 'Bounded real Codex local execution check; separate from Graph acceptance',
});
const agent = await request('POST', `/api/companies/${company.id}/agents`, {
  name: 'Codex adapter probe', role: 'general', title: 'Isolated runtime check',
  adapterType: 'codex_local',
  adapterConfig: { engine: 'cli', cwd: '/workspace/decision-register/.probe', model: 'gpt-6-sol',
    modelReasoningEffort: 'high', timeoutSec: 300, dangerouslyBypassApprovalsAndSandbox: true,
    extraArgs: ['--skip-git-repo-check'] },
  budgetMonthlyCents: 500,
});
const issue = await request('POST', `/api/companies/${company.id}/issues`, {
  title: 'Verify local Codex agent execution',
  description: 'Write a file named PROBE.txt in your current workspace containing exactly: Paperclip Codex adapter executed. Then report the result in this task.',
  status: 'todo', priority: 'medium', assigneeAgentId: agent.id,
});
await writeFile(new URL('../.e2e/real-adapter-probe.json', import.meta.url),
  JSON.stringify({ companyId: company.id, agentId: agent.id, issueId: issue.id }, null, 2));
const started = await request('POST', `/api/agents/${agent.id}/wakeup`, {
  source: 'on_demand', reason: 'Bounded authenticated Codex adapter smoke',
  payload: { issueId: issue.id }, idempotencyKey: randomUUID(),
});
let heartbeatId = started.id ?? started.runId ?? started.run?.id;
if (!heartbeatId) {
  for (let attempt = 0; attempt < 15 && !heartbeatId; attempt++) {
    const runs = await request('GET', `/api/companies/${company.id}/heartbeat-runs`);
    heartbeatId = runs.find((item) => item.agentId === agent.id && item.issueId === issue.id)?.id;
    if (!heartbeatId) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
assert.ok(heartbeatId, 'Paperclip wakeup did not create a heartbeat run');
await writeFile(new URL('../.e2e/real-adapter-probe.json', import.meta.url),
  JSON.stringify({ companyId: company.id, agentId: agent.id, issueId: issue.id, runId: heartbeatId }, null, 2));
console.log(`Real adapter probe started: company ${company.id}, issue ${issue.id}, run ${heartbeatId}`);
let state;
for (let attempt = 0; attempt < 120; attempt++) {
  state = await request('GET', `/api/heartbeat-runs/${heartbeatId}`);
  if (['succeeded', 'completed', 'failed', 'cancelled', 'timed_out'].includes(state.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log(JSON.stringify({ status: state?.status, errorCode: state?.errorCode,
  exitCode: state?.exitCode, adapterType: agent.adapterType, model: 'gpt-6-sol', reasoning: 'high' }));
assert.ok(['succeeded', 'completed'].includes(state?.status), 'Real Codex heartbeat did not succeed');
const artifact = await readFile(new URL('../examples/decision-register/.probe/PROBE.txt', import.meta.url), 'utf8');
assert.equal(artifact.trim(), 'Paperclip Codex adapter executed.', 'The agent did not create the requested file');
console.log('Real Codex agent wrote the exact requested workspace artifact.');
