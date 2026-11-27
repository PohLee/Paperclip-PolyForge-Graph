import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

async function reportingCompany() {
  const companyId = 'company';
  const pack = { id: 'adlc', version: '1', roles: { lead: { reportsToRole: 'ceo' } } };
  const agents = new Map(['ceo', 'lead'].map(id => [id, { id, companyId, reportsTo: null }]));
  const store = new MemoryStore();
  await store.write({ revision: 1, packs: {}, runs: {}, decisions: [], audit: [], idempotency: {},
    control: { companyId, enabledPacks: [{ packId: pack.id, version: pack.version }],
      organization: { board: { id: 'owner' }, ceo: { id: 'ceo' }, domainHeads: [{ domain: 'engineering', agentId: 'lead' }] } },
  }, 0);
  function worker(readAgent = async id => agents.get(id)) {
    const engine = new GraphEngine({ store });
    const api = createCompanyApi({ catalog: () => [pack],
      host: { db: {}, manifest: { id: 'graph' }, agents: { get: readAgent, managed: {
        get: async key => ({ agentId: 'lead', resourceKey: key, pluginKey: 'graph' }),
      } } },
      getConfig: async () => ({ roleBindings: {}, userRoles: {} }),
      trustedActor: async () => ({ actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, isAdministrator: true }),
      capabilitiesFor: async () => ({}),
      engineFor: async () => ({ store, engine, control: { getSetup: async () => (await store.read()).control } }),
    });
    return (operation, fields = {}) => api.command({ companyId, hostActor: {}, body: {
      operation, reason: 'Align reporting', idempotencyKey: crypto.randomUUID(), ...fields,
    } });
  }
  return { store, agents, worker };
}

test('a company changing Pack scope during native verification cannot confirm the old plan', async () => {
  const { agents, store, worker } = await reportingCompany();
  const plan = await worker()('organization-reporting-plan');
  agents.get('lead').reportsTo = 'ceo';
  const reading = Promise.withResolvers(), resume = Promise.withResolvers();
  const confirm = worker(async id => {
    reading.resolve();
    await resume.promise;
    return agents.get(id);
  })('organization-reporting-confirm', { planDecisionId: plan.planDecisionId });
  await reading.promise;
  const before = await store.read();
  before.control.enabledPacks[0].version = '2';
  await store.write({ ...before, revision: before.revision + 1 }, before.revision);
  resume.resolve();
  await assert.rejects(confirm, /organization setup changed/i);
  assert.ok(!(await store.read()).decisions.some(item => item.status === 'applied'));
});

test('independent company workers converge on one approval and one confirmation', async () => {
  const { agents, store, worker } = await reportingCompany();
  const workers = [worker(), worker()];
  const plans = await Promise.all(workers.map(cmd => cmd('organization-reporting-plan')));
  assert.equal(plans[0].planDecisionId, plans[1].planDecisionId);
  agents.get('lead').reportsTo = 'ceo';
  const confirmed = await Promise.all(workers.map((cmd, i) => cmd('organization-reporting-confirm', {
    planDecisionId: plans[i].planDecisionId, reason: 'Verified by worker ' + i,
  })));
  assert.equal(confirmed[0].decisionId, confirmed[1].decisionId);
  assert.deepEqual((await store.read()).decisions.map(item => item.status), ['approved', 'applied']);
});
