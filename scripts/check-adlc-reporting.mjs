import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pack } from '../../Paperclip-PolyForge-Graph-ADLC/index.mjs';

// Original organization requirement, deliberately independent of the Pack's
// Graph review supervisorRole and of the host's current reporting values.
const expectedManagers = {
  cpo: null, 'cto-caio': null,
  'internal-product-analyst': 'cpo', 'external-product-analyst': 'cpo',
  'product-manager': 'cpo', 'product-owner': 'cpo', 'ui-ux-designer-lead': 'cpo',
  'principal-engineer': 'cto-caio', 'lead-engineer': 'cto-caio',
  'qa-engineer': 'cto-caio', 'security-engineer': 'cto-caio',
};

// Read-only live regression signal for the isolated Docker fixture.
// Never print the local test owner's session cookie or password.
const auth = JSON.parse(await readFile('.e2e/auth.json', 'utf8'));
const fixture = JSON.parse(await readFile('.e2e/result.json', 'utf8'));
const base = process.env.POLYFORGE_E2E_BASE_URL ?? 'http://localhost:3310';
const companyId = process.env.POLYFORGE_ORG_COMPANY_ID ?? fixture.companyId;
const issueId = process.env.POLYFORGE_ORG_ISSUE_ID ?? fixture.issueId;

async function get(path) {
  const response = await fetch(new URL(path, base), {
    headers: { Origin: base, Cookie: auth.cookie },
  });
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return response.json();
}

const graph = await get(`/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`);
const agents = await get(`/api/companies/${companyId}/agents`);
const managedIds = new Set(Object.values(graph.config?.roleBindings ?? {}));
assert.equal(managedIds.size, 11, 'Expected 11 managed ADLC role bindings');
const managed = agents.filter((agent) => managedIds.has(agent.id));
assert.equal(managed.length, managedIds.size, 'Every managed binding must resolve to a host agent');
const byId = new Map(managed.map((agent) => [agent.id, agent]));
assert.deepEqual(Object.keys(graph.config.roleBindings).sort(), Object.keys(expectedManagers).sort());
assert.deepEqual(Object.keys(pack.roles).sort(), Object.keys(expectedManagers).sort());
for (const [roleId, managerRole] of Object.entries(expectedManagers)) {
  assert.equal(pack.roles[roleId].reportsToRole, managerRole, `Pack organization differs for ${roleId}`);
  const agentId = graph.config.roleBindings[roleId];
  const expectedId = managerRole === null ? null : graph.config.roleBindings[managerRole];
  assert.equal(byId.get(agentId)?.reportsTo ?? null, expectedId, `${roleId} host manager differs`);
}
assert.equal(managed.filter((agent) => agent.reportsTo === null).length, 2, 'Expected two Board roots');
assert.equal(managed.filter((agent) => agent.reportsTo !== null).length, 9, 'Expected nine reporting edges');
console.log('Managed ADLC agents: 11; exact reporting edges: 9; Board roots: 2');
