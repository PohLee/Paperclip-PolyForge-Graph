import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { alignOrganization } from '../src/plugin/alignment.mjs';

const auth = JSON.parse(await readFile('.e2e/auth.json', 'utf8'));
const fixture = JSON.parse(await readFile('.e2e/result.json', 'utf8'));
const companyId = process.env.POLYFORGE_ORG_COMPANY_ID ?? fixture.companyId;
const issueId = process.env.POLYFORGE_ORG_ISSUE_ID ?? fixture.issueId;
const base = process.env.POLYFORGE_E2E_BASE_URL ?? 'http://localhost:3310';
const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stableProfile(agent) {
  // PATCH /api/agents/:id changes reporting plus the host's edit timestamp.
  // Every other returned profile field must remain byte-for-byte equivalent.
  const profile = structuredClone(agent);
  delete profile.reportsTo;
  delete profile.updatedAt;
  delete profile.updated_at;
  // The host computes this read-only chain diagnosis from reportsTo.
  delete profile.orgChainHealth;
  return profile;
}

async function request(method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { Origin: base, Cookie: auth.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

const agentsBefore = await request('GET', `/api/companies/${companyId}/agents`);
const beforeHashes = Object.fromEntries(agentsBefore.map((agent) => [agent.id, hash(agent)]));
const beforeStableHashes = Object.fromEntries(agentsBefore.map((agent) => [agent.id, hash(stableProfile(agent))]));
const snapshotName = `.e2e/reporting-before-${companyId}-${randomUUID()}.json`;
await writeFile(snapshotName, JSON.stringify({
  companyId, recordedAt: new Date().toISOString(), sha256ByAgentId: beforeHashes,
  stableProfileSha256ByAgentId: beforeStableHashes,
}, null, 2));
console.log(`Saved ${agentsBefore.length} agent profile hashes in ${snapshotName}`);
const { plan, confirmation } = await alignOrganization({
  companyId, issueId, provisionFirst: process.argv.includes('--provision'), newKey: randomUUID,
  command: (body) => request('POST', graphPath, body),
  readAgent: (agentId) => request('GET', `/api/agents/${agentId}`),
  patchAgent: (agentId, reportsTo) => request('PATCH', `/api/agents/${agentId}`, { reportsTo }),
});
assert.equal(plan.assignments?.length, 11, 'Expected exactly 11 plugin-managed agents');
assert.equal(plan.conflicts?.length, 0, 'A nonempty custom manager must not be overwritten');
const managedIds = new Set(plan.assignments.map((item) => item.agentId));
assert.equal(managedIds.size, 11, 'Managed IDs must be unique');
console.log(`Plan ${plan.planDecisionId}: ${plan.changes.length} manager changes, ${plan.assignments.length} managed agents`);
assert.equal(confirmation.aligned, true);
const agentsAfter = await request('GET', `/api/companies/${companyId}/agents`);
const byId = new Map(agentsAfter.map((agent) => [agent.id, agent]));
for (const assignment of plan.assignments) {
  assert.equal(byId.get(assignment.agentId)?.reportsTo ?? null, assignment.toReportsTo,
    `${assignment.roleId} reporting manager differs from Pack`);
}
for (const [id, beforeHash] of Object.entries(beforeHashes)) {
  if (!managedIds.has(id)) assert.equal(hash(byId.get(id)), beforeHash, `Non-managed agent ${id} changed`);
  else assert.equal(hash(stableProfile(byId.get(id))), beforeStableHashes[id],
    `Managed agent ${id} changed outside reporting and host edit timestamp`);
}
const roots = plan.assignments.filter((item) => item.toReportsTo === null);
const edges = plan.assignments.filter((item) => item.toReportsTo !== null);
assert.equal(roots.length, 2);
assert.equal(edges.length, 9);
console.log(`Aligned: ${edges.length} reporting edges, ${roots.length} Board roots; all existing non-reporting profile fields unchanged`);
for (const item of plan.assignments) console.log(`${item.roleId}: ${item.agentId} -> ${item.toReportsTo ?? 'Board'}`);
