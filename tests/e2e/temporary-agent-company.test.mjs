import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, CompanyControlPlane } from '../../src/core/index.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

function fixture() {
  const store = new MemoryStore(), control = new CompanyControlPlane({ store, companyId: 'company-a' });
  const calls = [];
  const runtime = Object.fromEntries(['open', 'stop'].map(method => [method, async input => { calls.push({ method, input }); return { status: 'active' }; }]));
  const api = createCompanyApi({ host: { manifest: { id: 'test.graph' }, db: {} },
    catalog: () => [], engineFor: async () => ({ store, control }),
    getConfig: async () => ({}), trustedActor: async (_companyId, actor) => ({ actor,
      isAdministrator: actor.kind === 'human' && actor.roles.includes('human-owner') }),
    capabilitiesFor: async () => ({}), temporaryAgentRuntime: runtime });
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const parent = { id: 'parent', kind: 'agent', roles: ['adlc:lead-engineer'], executionId: 'run-a' };
  const command = (actor, body) => api.command({ companyId: 'company-a', hostActor: actor,
    body: { reason: 'Bounded delegation test', idempotencyKey: 'one', ...body } });
  return { control, store, calls, command, owner, parent };
}

test('temporary policy is owner controlled, idempotent and audited', async () => {
  const f = fixture();
  assert.equal((await f.control.getTemporaryAgentPolicy()).enabled, false);
  const body = { operation: 'configure-temporary-agent-policy', policy: { enabled: true } };
  await assert.rejects(f.command(f.parent, body), /owner/);
  await f.command(f.owner, body);
  await f.command(f.owner, body);
  assert.equal((await f.control.getTemporaryAgentPolicy()).enabled, true);
  assert.equal((await f.control.getAudit()).filter(row => row.type === 'temporary-agent.policy-configured' || row.kind === 'temporary-agent.policy-configured').length, 1);
  await assert.rejects(f.command(f.owner, { ...body, policy: { enabled: false } }), /Idempotency/);
});

test('temporary commands forward trusted actor and reject nonowner human stop', async () => {
  const f = fixture(), request = { id: 'bounded-one' };
  await f.command(f.parent, { operation: 'open-temporary-agent', request,
    actor: { id: 'attacker', kind: 'human' } });
  assert.equal(f.calls[0].input.actor.id, 'parent');
  assert.equal(f.calls[0].input.actor.executionId, 'run-a');
  assert.deepEqual(f.calls[0].input.request, request);
  await assert.rejects(f.command({ id: 'viewer', kind: 'human', roles: [] },
    { operation: 'stop-temporary-agent', temporaryAgentId: 'child' }), /owner/);
  await f.command(f.owner, { operation: 'stop-temporary-agent', temporaryAgentId: 'child' });
  assert.equal(f.calls[1].input.temporaryAgentId, 'child');
});
