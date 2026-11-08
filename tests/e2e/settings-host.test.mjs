import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';
import { mappingSuggestions, settingsRoles, validateSettings } from '../../src/plugin/settings.mjs';
import { DELIVERY_LIMITS } from '../../src/core/delivery-limits.mjs';

const catalog = [{ id: 'adlc', version: '1.0.0', roles: { maker: { name: 'Maker' } } }];
function fixture(initial = {}) {
  let config = { revision: 1, roleBindings: {}, userRoles: {}, defaultMode: 'manual', deliveryLimits: { ...DELIVERY_LIMITS }, ...initial };
  const decisions = [];
  const host = { db: {}, manifest: { id: 'test.graph' },
    agents: { get: async (id, companyId) => id === 'agent-a' && companyId === 'company-a' ? { id } : null,
      list: async () => [{ id: 'agent-a', name: 'Maker', status: 'idle' }], managed: { get: async () => null } },
    access: { members: { list: async () => [{ principalType: 'user', principalId: 'owner', status: 'active' }] } } };
  const api = createCompanyApi({ host, catalog: () => catalog, engineFor: async () => ({
    engine: { listDecisions: async () => decisions, recordDecision: async value => {
      const result = { ...value, id: `decision-${decisions.length}` }; decisions.push(result); return result;
    } },
  }), getConfig: async () => config, compareAndSetConfig: async (_db, _id, rev, next) => {
    if (rev !== config.revision) return false; config = { ...next, revision: rev + 1 }; return true;
  }, trustedActor: async (_id, actor) => ({ actor: { id: actor.userId, kind: 'human', roles: ['human-owner'] }, isAdministrator: actor.userId === 'owner' }),
  capabilitiesFor: async () => ({}) });
  const call = (patch, userId = 'owner') => api.command({ companyId: 'company-a', hostActor: { userId }, body: {
    operation: 'configure-settings', reason: 'Set company policy', idempotencyKey: crypto.randomUUID(), ...patch } });
  return { call, config: () => config, decisions, host,
    read: () => api.settings({ companyId: 'company-a', hostActor: { userId: 'owner' } }) };
}
test('settings retries replay the same request after its revision has advanced', async () => {
  const f = fixture();
  const request = { defaultMode: 'assisted', expectedRevision: 1, idempotencyKey: 'retry-save' };
  const saved = await f.call(request);
  const replay = await f.call(request);
  assert.equal(replay.decisionId, saved.decisionId);
  assert.equal(replay.config.revision, 2);
  assert.equal(f.decisions.length, 2);
  await assert.rejects(f.call({ ...request, defaultMode: 'autonomous' }), /Idempotency key reused/);
});

test('settings exposes inactive and removed member mappings so an owner can revoke them', async () => {
  const f = fixture({ userRoles: { inactive: ['adlc:maker'], removed: ['human-owner'] } });
  f.host.access.members.list = async () => [
    { principalType: 'user', principalId: 'owner', status: 'active' },
    { principalType: 'user', principalId: 'inactive', status: 'suspended' },
  ];
  const view = await f.read();
  assert.deepEqual(view.members.map(member => member.id), ['owner']);
  assert.deepEqual(view.unavailableMembers.map(({ id, status }) => ({ id, status })), [
    { id: 'inactive', status: 'suspended' }, { id: 'removed', status: 'removed' },
  ]);
  await assert.rejects(f.call({ defaultMode: 'assisted' }), /Inactive or unknown human/);
  const saved = await f.call({ userRoles: {}, defaultMode: 'assisted', expectedRevision: 1 });
  assert.deepEqual(saved.config.userRoles, {});
  assert.deepEqual((await f.read()).unavailableMembers, []);
});
test('company settings save without an issue and reject foreign actors, roles, bounds and stale revisions', async () => {
  const f = fixture();
  await assert.rejects(f.call({ defaultMode: 'assisted' }, 'viewer'), /owner or admin/);
  await assert.rejects(f.call({ roleBindings: { 'adlc:maker': 'foreign-agent' } }), /Invalid agent binding/);
  await assert.rejects(f.call({ userRoles: { stranger: ['human-owner'] } }), /unknown human/);
  await assert.rejects(f.call({ userRoles: { owner: ['made-up-role'] } }), /Invalid human role/);
  await assert.rejects(f.call({ deliveryLimits: { parallelAgents: 99 } }), /Invalid delivery limit/);
  await assert.rejects(f.call({ expectedRevision: 0 }), /Settings changed/);
  assert.equal(f.decisions.length, 0);
  const result = await f.call({ roleBindings: { 'adlc:maker': 'agent-a' }, userRoles: { owner: ['adlc:maker'] },
    defaultMode: 'assisted', deliveryLimits: { ...DELIVERY_LIMITS, parallelAgents: 2 }, expectedRevision: 1 });
  assert.equal(result.config.defaultMode, 'assisted');
  assert.equal(f.config().deliveryLimits.parallelAgents, 2);
  assert.equal(f.decisions.length, 2);
  await assert.rejects(f.call({ defaultMode: 'manual', expectedRevision: 1 }), /Settings changed/);
  assert.equal(f.config().defaultMode, 'assisted');
});
test('auto mapping uses verified managed identities and preserves existing and legacy mappings', async () => {
  const host = { manifest: { id: 'test.graph' }, agents: { managed: { get: async key => ({
    pluginKey: 'test.graph', resourceKey: key, agentId: key === 'company:ceo' ? 'ceo-a' : 'agent-a' }) } } };
  const roles = settingsRoles(catalog), agents = [{ id: 'ceo-a' }, { id: 'agent-a' }, { id: 'same-name', name: 'Maker' }];
  const suggest = bindings => mappingSuggestions({ host, companyId: 'company-a', roles, agents, bindings });
  assert.deepEqual(await suggest({}), { ceo: 'ceo-a', 'adlc:maker': 'agent-a' });
  assert.deepEqual(await suggest({ ceo: 'custom', maker: 'legacy' }), {});
  host.agents.managed.get = async key => ({ pluginKey: 'foreign-plugin', resourceKey: key, agentId: 'agent-a' });
  assert.deepEqual(await suggest({}), {});
});

test('historical mappings remain visible and can be preserved or removed, but cannot grant a new unknown role', async () => {
  const config = { roleBindings: { retired: 'agent-a' }, userRoles: { owner: ['retired'] }, defaultMode:'manual' };
  const host = { agents: { get: async () => ({id:'agent-a'}) }, access: { members: { list: async () => [
    {principalType:'user',principalId:'owner',status:'active'}, {principalType:'user',principalId:'other',status:'active'}] } } };
  const validate = payload => validateSettings({payload,config,catalog,host,companyId:'company-a'});
  assert.equal(settingsRoles(catalog, config).find(role=>role.id==='retired').historical,true);
  assert.equal((await validate({defaultMode:'assisted'})).roleBindings.retired,'agent-a');
  await assert.rejects(validate({roleBindings:{retired:'agent-b'}}), /Invalid agent binding/);
  await assert.rejects(validate({userRoles:{other:['retired']}}), /Invalid human role/);
  assert.deepEqual((await validate({roleBindings:{},userRoles:{}})).roleBindings,{});
});
