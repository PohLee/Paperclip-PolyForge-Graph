import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { alignCompanyOrganization } from '../../src/plugin/alignment.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

function fixture() {
  const catalog = [
    { id: 'adlc', version: '1.0.0', roles: { cpo: { id: 'cpo', reportsToRole: 'ceo' } } },
    { id: 'creative', version: '1.0.0', roles: { head: { id: 'head', reportsToRole: 'ceo' } },
      organization: { conditionalReportingLines: [
        { roleId: 'head', reportsToRole: 'adlc:cpo', when: { packId: 'adlc', minVersion: '1.0.0', maxExclusiveVersion: '2.0.0' } },
      ] } },
  ];
  const companyId = 'company-a';
  const actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const agents = new Map(['ceo', 'adlc:cpo', 'creative:head'].map(id => [id,
    { id, companyId, reportsTo: null, adapterConfig: { custom: id } }]));
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const setup = { organization: { board: { id: actor.id }, ceo: { id: 'ceo' },
    domainHeads: [{ domain: 'product', agentId: 'adlc:cpo' }, { domain: 'creative', agentId: 'creative:head' }] } };
  let config = { roleBindings: { 'creative:head': 'creative:head' }, userRoles: {} };
  const reconciled = [];
  const resolution = (key) => ({ agentId: key === 'company:ceo' ? 'ceo' : key, resourceKey: key, pluginKey: 'test.graph' });
  const host = { db: {}, manifest: { id: 'test.graph', agents: [{ agentKey: 'adlc:cpo' }, { agentKey: 'creative:head' }] },
    agents: { get: async id => structuredClone(agents.get(id)), managed: {
      get: async key => resolution(key), reconcile: async key => { reconciled.push(key); return resolution(key); },
    } } };
  const readSetup = () => ({ companyId, ...structuredClone(setup),
    enabledPacks: catalog.map(pack => ({ packId: pack.id, version: pack.version })) });
  async function updateSetup() {
    const state = await store.read() ?? { revision: 0, packs: {}, runs: {}, decisions: [], audit: [], idempotency: {} };
    const expected = state.revision++;
    state.control = readSetup();
    await store.write(state, expected);
  }
  const api = createCompanyApi({ host, catalog: () => catalog,
    getConfig: async () => config,
    setConfig: async (_db, _companyId, next) => { config = next; },
    trustedActor: async (_companyId, hostActor) => ({ actor: { ...actor, ...hostActor.actor },
      isAdministrator: hostActor.isAdministrator ?? true }),
    capabilitiesFor: async () => ({}), engineFor: async () => ({ engine,
      control: { getSetup: async () => (await store.read()).control,
        configureSetup: async ({ organization }) => { setup.organization = organization; await updateSetup(); return organization; },
      } }),
  });
  const command = async (operation, fields, { companyId: callerCompany = companyId, hostActor = {} } = {}) => {
    await updateSetup();
    return api.command({ companyId: callerCompany, hostActor,
      body: { operation, reason: 'Review organization', idempotencyKey: crypto.randomUUID(), ...fields } });
  };
  return { actor, engine, setup, catalog, agents, host, reconciled, command, decisions: () => engine.listDecisions(),
    plan: (fields, options) => command('organization-reporting-plan', fields, options),
    confirm: (planDecisionId, fields, options) => command('organization-reporting-confirm', { planDecisionId, ...fields }, options),
    apply: (plan) => { for (const change of plan.changes) agents.get(change.agentId).reportsTo = change.toReportsTo; },
  };
}

test('compatible enabled Packs resolve conditional reporting to the managed company agent', async () => {
  const f = fixture();
  const plan = await f.plan();
  assert.equal(plan.assignments.find(item => item.roleId === 'adlc:cpo').toReportsTo, 'ceo');
  assert.equal(plan.assignments.find(item => item.roleId === 'creative:head').toReportsTo, 'adlc:cpo');
  assert.equal((await f.decisions())[0].status, 'approved');
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
  assert.equal((await cyclic.decisions()).length, 0);

  const duplicate = fixture();
  duplicate.host.agents.managed.get = async key => ({ agentId: 'adlc:cpo', resourceKey: key, pluginKey: 'test.graph' });
  await assert.rejects(duplicate.plan(), /duplicate managed agent/);
  assert.equal((await duplicate.decisions()).length, 0);
});

test('conditional managers must belong to an enabled Pack role', async () => {
  const f = fixture();
  f.catalog[1].organization.conditionalReportingLines[0].reportsToRole = 'disabled:head';
  await assert.rejects(f.plan(), /not in the enabled organization/);
  assert.equal((await f.decisions()).length, 0);
});

test('company alignment reprovisions and resumes after a partial native PATCH failure', async () => {
  const f = fixture();
  const patches = [];
  const plans = [];
  let failOnce = true;
  const align = () => alignCompanyOrganization({ companyId: 'company-a', organization: f.setup.organization,
    pack: f.catalog[0],
    command: async (operation, fields) => {
      const result = await f.command(operation, fields);
      if (operation === 'organization-reporting-plan') plans.push(result);
      return result;
    },
    readAgent: (id) => f.host.agents.get(id, 'company-a'),
    patchAgent: async (id, reportsTo) => {
      patches.push(id);
      if (id === 'creative:head' && failOnce) { failOnce = false; throw new Error('Host PATCH failed'); }
      const agent = f.agents.get(id);
      agent.reportsTo = reportsTo;
      return structuredClone(agent);
    },
  });

  await assert.rejects(align(), /Organization alignment is pending.*Host PATCH failed/);
  assert.equal(f.agents.get('adlc:cpo').reportsTo, 'ceo');
  assert.equal(f.agents.get('creative:head').reportsTo, null);
  await assert.rejects(f.confirm(plans[0].planDecisionId), /links do not match/);
  await align();

  const [intent, result] = await f.decisions();
  assert.equal(plans[1].planDecisionId, intent.id);
  assert.equal(plans[1].resumed, true);
  assert.deepEqual(plans[1].changes.map((change) => change.agentId), ['creative:head']);
  assert.deepEqual(patches, ['adlc:cpo', 'creative:head', 'creative:head']);
  assert.deepEqual(f.reconciled, ['company:ceo', 'adlc:cpo', 'company:ceo', 'adlc:cpo']);
  assert.equal(f.agents.get('creative:head').reportsTo, 'adlc:cpo');
  assert.deepEqual(f.agents.get('creative:head').adapterConfig, { custom: 'creative:head' });
  assert.deepEqual([intent.type, intent.status, intent.outcome], ['company_reporting', 'approved', 'requested']);
  assert.deepEqual([result.status, result.outcome, result.supersedes], ['applied', 'aligned', intent.id]);
  assert.equal(result.reason, 'Verify the applied Paperclip reporting links');
  assert.deepEqual(result.evidence[0].enabledPacks, intent.evidence[0].enabledPacks);
  assert.equal((await f.decisions()).length, 2);
});

test('company reporting plans bind the actor, company, intended targets, and enabled releases', async () => {
  const f = fixture();
  const first = await f.plan();
  const differentActor = { hostActor: { actor: { id: 'another-admin' } } };
  const another = await f.plan({}, differentActor);
  assert.notEqual(another.planDecisionId, first.planDecisionId);
  await assert.rejects(f.confirm(first.planDecisionId, {}, differentActor), /another actor/);
  await assert.rejects(f.confirm(first.planDecisionId, {}, { companyId: 'company-b' }), /another actor or company/);
  await assert.rejects(f.plan({}, { hostActor: { actor: { kind: 'agent' } } }), /company owner or admin/);

  f.catalog[0].version = '1.1.0';
  const newRelease = await f.plan();
  assert.deepEqual(newRelease.assignments, first.assignments);
  assert.notEqual(newRelease.planDecisionId, first.planDecisionId);
  await assert.rejects(f.confirm(first.planDecisionId), /enabled Pack scope is stale/);

  f.agents.set('replacement-ceo', { id: 'replacement-ceo', companyId: 'company-a', reportsTo: null });
  f.setup.organization.ceo.id = 'replacement-ceo';
  const changedTargets = await f.plan();
  assert.notEqual(changedTargets.planDecisionId, newRelease.planDecisionId);
  f.apply(changedTargets);
  await assert.rejects(f.confirm(newRelease.planDecisionId), /links do not match/);
  assert.equal((await f.confirm(changedTargets.planDecisionId)).aligned, true);
});

test('Pack order does not invalidate a company approval, while an unknown legacy release scope does', async () => {
  const f = fixture();
  const current = await f.plan();
  const legacy = await f.engine.recordDecision({ type: 'company_reporting', status: 'approved', outcome: 'requested',
    actor: f.actor, reason: 'Earlier plan', evidence: [{ kind: 'organization_plan', companyId: 'company-a',
      assignments: current.assignments, conflicts: [] }] });
  f.catalog.reverse();
  const retried = await f.plan();
  assert.equal(retried.planDecisionId, current.planDecisionId);
  assert.equal(retried.resumed, true);
  f.apply(retried);
  await assert.rejects(f.confirm(legacy.id), /enabled Pack scope is stale/);
  assert.equal((await f.confirm(current.planDecisionId)).aligned, true);
});

test('company reporting blocks a custom manager and rejects stale confirmation after native drift', async () => {
  const f = fixture();
  const plan = await f.plan({ idempotencyKey: 'original-plan' });
  f.apply(plan);
  const applied = await f.confirm(plan.planDecisionId);
  assert.equal((await f.confirm(plan.planDecisionId)).decisionId, applied.decisionId);

  f.agents.get('creative:head').reportsTo = 'custom-manager';
  const blocked = await f.plan();
  assert.deepEqual(blocked.conflicts.map((item) => item.fromReportsTo), ['custom-manager']);
  assert.equal((await f.decisions()).at(-1).outcome, 'custom_manager_conflict');
  assert.notEqual(blocked.planDecisionId, plan.planDecisionId);
  await assert.rejects(f.confirm(plan.planDecisionId), /links do not match/);
  await assert.rejects(f.confirm(blocked.planDecisionId), /Reporting plan belongs/);
  f.agents.get('creative:head').reportsTo = null;
  await assert.rejects(f.plan({ idempotencyKey: 'original-plan' }), /recorded reporting request is stale/i);
  const fresh = await f.plan();
  assert.notEqual(fresh.planDecisionId, plan.planDecisionId);
  assert.notEqual(fresh.planDecisionId, blocked.planDecisionId);
  assert.equal(fresh.resumed, undefined);
});

test('reporting keys stay bound to the request even when an existing intent or result is reused', async () => {
  const f = fixture();
  const original = await f.plan({ idempotencyKey: 'plan-key' });
  f.agents.get('adlc:cpo').reportsTo = 'ceo';
  assert.equal((await f.plan({ idempotencyKey: 'plan-key' })).planDecisionId, original.planDecisionId);
  assert.equal((await f.plan({ idempotencyKey: 'retry-key' })).planDecisionId, original.planDecisionId);
  await assert.rejects(f.plan({ idempotencyKey: 'retry-key', reason: 'Another reason' }), /Idempotency key reused/);
  await assert.rejects(f.plan({ idempotencyKey: 'plan-key', reason: 'Another reason' }), /Idempotency key reused/);

  f.apply(original);
  const applied = await f.confirm(original.planDecisionId, { idempotencyKey: 'confirm-key' });
  assert.deepEqual(await f.confirm(original.planDecisionId, { idempotencyKey: 'confirm-key' }), applied);
  await f.confirm(original.planDecisionId, { idempotencyKey: 'second-confirm-key' });
  await assert.rejects(f.confirm(original.planDecisionId, { idempotencyKey: 'second-confirm-key', reason: 'Another reason' }), /Idempotency key reused/);
  const second = await f.plan();
  assert.notEqual(second.planDecisionId, original.planDecisionId);
  await f.confirm(second.planDecisionId);
  await assert.rejects(f.confirm(second.planDecisionId, { idempotencyKey: 'confirm-key' }), /Idempotency key reused/);
});
