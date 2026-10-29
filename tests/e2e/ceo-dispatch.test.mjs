import test from 'node:test';
import assert from 'node:assert/strict';
import { boundCeo, nativeIntakeAssignee, wakeCeoIssue } from '../../src/plugin/ceo-dispatch.mjs';

const companyId = 'company-a', ceoId = 'ceo-a', issueId = 'issue-a';
const setup = { organization: { ceo: { id: ceoId },
  authorityPolicy: { ceoOperations: ['intake'] } } };
const config = { roleBindings: { ceo: ceoId } };
const agent = { id: ceoId, companyId, status: 'idle', adapterType: 'process',
  adapterConfig: { command: 'node', args: ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs'], timeoutSec: 120 },
  budgetMonthlyCents: 10000, spentMonthlyCents: 0 };

test('native CEO intake assignment follows the bound singleton and explicit Board intake delegation', async () => {
  const host = { agents: { get: async (id) => id === ceoId ? agent : null } };
  assert.equal((await boundCeo({ host, companyId, setup, config, scope: 'intake' })).id, ceoId);
  assert.equal(await nativeIntakeAssignee({ host, companyId, setup, config,
    intake: { status: 'ceo-review', assigneeId: null } }), ceoId);
  assert.equal(await nativeIntakeAssignee({ host, companyId, setup,
    config: { roleBindings: { ceo: 'different' } }, intake: { status: 'ceo-review' } }), null);
  assert.equal(await nativeIntakeAssignee({ host, companyId,
    setup: { organization: { ceo: { id: ceoId }, authorityPolicy: {} } }, config,
    intake: { status: 'ceo-review' } }), null);
  await assert.rejects(nativeIntakeAssignee({ host, companyId, setup, config,
    intake: { status: 'offered', assigneeId: 'foreign-agent' } }), /not a company Agent/);
});

test('only the fixed local process CEO receives a stable native wakeup request', async () => {
  const calls = [];
  const host = { agents: { get: async () => agent }, issues: {
    get: async () => ({ id: issueId, companyId, assigneeAgentId: ceoId }),
    requestWakeup: async (...args) => { calls.push(args); return { status: 'requested' }; },
  } };
  const input = { host, companyId, issueId, setup, config, scope: 'intake', sourceId: 'intake-a' };
  assert.equal((await wakeCeoIssue(input)).status, 'requested');
  assert.equal(calls[0][2].idempotencyKey, 'polyforge-ceo:company-a:intake:intake-a');
  host.agents.get = async () => ({ ...agent, adapterType: 'codex_local',
    adapterConfig: { model: 'configured-model' } });
  assert.equal((await wakeCeoIssue({ ...input, sourceId: 'intake-b' })).status, 'requested');
  assert.equal(calls[1][2].idempotencyKey, 'polyforge-ceo:company-a:intake:intake-b');
  host.agents.get = async () => ({ ...agent, adapterType: 'codex_local',
    adapterConfig: { model: 'configured-model' }, budgetMonthlyCents: 0 });
  assert.equal((await wakeCeoIssue(input)).status, 'unavailable');
  assert.equal(calls.length, 2);
});
