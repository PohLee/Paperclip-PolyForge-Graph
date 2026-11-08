import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

function fixture() {
  const catalog = [
    { id: 'adlc', version: '1.0.0', roles: { cpo: { reportsToRole: null } } },
    { id: 'creative', version: '1.0.0', roles: { head: { reportsToRole: null } },
      organization: { conditionalReportingLines: [
        { roleId: 'head', reportsToRole: 'adlc:cpo', when: { packId: 'adlc', minVersion: '1.0.0', maxExclusiveVersion: '2.0.0' } },
      ] } },
  ];
  const agents = new Map(['ceo', 'adlc:cpo', 'creative:head'].map(id => [id, { id, companyId: 'company-a', reportsTo: null }]));
  const decisions = [];
  const host = { db: {}, manifest: { id: 'test.graph' }, agents: {
    get: async id => agents.get(id), managed: { get: async key => ({ agentId: key, resourceKey: key, pluginKey: 'test.graph' }) },
  } };
  const api = createCompanyApi({ host, catalog: () => catalog,
    getConfig: async () => ({ roleBindings: {}, userRoles: {} }),
    trustedActor: async () => ({ actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, isAdministrator: true }),
    capabilitiesFor: async () => ({}), engineFor: async () => ({
      engine: { recordDecision: async value => { decisions.push(value); return { ...value, id: 'plan' }; } },
      control: { getSetup: async () => ({
        enabledPacks: catalog.map(pack => ({ packId: pack.id, version: pack.version })),
        organization: { ceo: { id: 'ceo' }, domainHeads: [{ agentId: 'adlc:cpo' }, { agentId: 'creative:head' }] },
      }) },
    }),
  });
  return { catalog, agents, host, decisions, plan: () => api.command({ companyId: 'company-a', hostActor: {},
    body: { operation: 'organization-reporting-plan', reason: 'Review organization', idempotencyKey: crypto.randomUUID() } }) };
}

test('compatible enabled Packs resolve conditional reporting to the managed company agent', async () => {
  const f = fixture();
  const plan = await f.plan();
  assert.equal(plan.assignments.find(item => item.roleId === 'adlc:cpo').toReportsTo, 'ceo');
  assert.equal(plan.assignments.find(item => item.roleId === 'creative:head').toReportsTo, 'adlc:cpo');
  assert.equal(f.decisions[0].status, 'approved');
  f.agents.get('adlc:cpo').companyId = 'company-b';
  await assert.rejects(f.plan(), /missing from this company/);
});

test('conditional reporting respects prerelease and exclusive upper version bounds', async () => {
  for (const version of ['1.0.0-alpha', '2.0.0']) {
    const f = fixture();
    f.catalog[0].version = version;
    const plan = await f.plan();
    assert.equal(plan.assignments.find(item => item.roleId === 'creative:head').toReportsTo, 'ceo');
  }
});

test('cross-Pack cycles and duplicate execution identities cannot produce an approved reporting plan', async () => {
  const cyclic = fixture();
  cyclic.catalog[0].organization = { conditionalReportingLines: [
    { roleId: 'cpo', reportsToRole: 'creative:head', when: { packId: 'creative' } },
  ] };
  await assert.rejects(cyclic.plan(), /reporting cycle/);
  assert.equal(cyclic.decisions.length, 0);

  const duplicate = fixture();
  duplicate.host.agents.managed.get = async key => ({ agentId: 'adlc:cpo', resourceKey: key, pluginKey: 'test.graph' });
  await assert.rejects(duplicate.plan(), /duplicate managed agent/);
  assert.equal(duplicate.decisions.length, 0);
});

test('conditional managers must belong to an enabled Pack role', async () => {
  const f = fixture();
  f.catalog[1].organization.conditionalReportingLines[0].reportsToRole = 'disabled:head';
  await assert.rejects(f.plan(), /not in the enabled organization/);
  assert.equal(f.decisions.length, 0);
});
