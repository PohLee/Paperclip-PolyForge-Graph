import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureShadowAgent, fixtureShadowAvailable, shadowActorForRun } from '../../src/plugin/fixture-shadow.mjs';

const script = '/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs';
const fixtureAgent = (changes = {}) => ({ id: 'reviewer-a', adapterType: 'process', status: 'idle',
  adapterConfig: { command: 'node', args: [script], timeoutSec: 120 },
  budgetMonthlyCents: 10000, spentMonthlyCents: 0, ...changes });

test('Agent Shadow ownership resolves only the pinned Pack role and retains authenticated identity', () => {
  const actor = { id: 'qa-a', kind: 'agent', roles: ['adlc:qa-engineer', 'marketing:analyst'], executionId: 'run-a' };
  const run = { packId: 'adlc' }, node = { role: 'qa-engineer' };
  assert.deepEqual(shadowActorForRun(actor, run, node), { ...actor, roles: [...actor.roles, 'qa-engineer'] });
  assert.deepEqual(actor.roles, ['adlc:qa-engineer', 'marketing:analyst']);
  for (const invalid of [ { ...actor, executionId: null }, { ...actor, roles: ['marketing:qa-engineer'] },
    { ...actor, roles: ['qa-engineer'] }, { ...actor, roles: [] } ]) {
    assert.throws(() => shadowActorForRun(invalid, run, node), /Owning Graph Agent/);
  }
});
test('optional Shadow discovery is unavailable when a proactive company has no native scope', async () => {
  const host = { agents: { get: async () => { throw new Error('missing, expired, or unknown invocation scope'); } } };
  assert.equal(await fixtureShadowAvailable(host, 'unconfigured-company', ['reviewer-a']), false);
  host.agents.get = async () => fixtureAgent({ companyId: 'configured-company' });
  assert.equal(await fixtureShadowAvailable(host, 'configured-company', ['reviewer-a']), true);
  assert.equal(await fixtureShadowAvailable(host, 'other-company', ['reviewer-a']), false);
});

test('only the exact local process fixture with a bounded timeout and remaining native budget can review', () => {
  assert.equal(fixtureShadowAgent(fixtureAgent()), true);
  for (const changes of [
    { adapterType: 'codex_local' }, { adapterType: 'process', adapterConfig: { command: 'npx', args: [script], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: [script, '--model'], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: ['/tmp/other.mjs'], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: [script], timeoutSec: 901 } },
    { budgetMonthlyCents: 0 }, { spentMonthlyCents: 10000 }, { status: 'paused' },
  ]) assert.equal(fixtureShadowAgent(fixtureAgent(changes)), false);
});
