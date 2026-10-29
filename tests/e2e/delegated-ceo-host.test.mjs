import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

function fixture(policy = { ceoOperations: ['intake', 'decision', 'work-plan', 'agent-goal', 'strategy', 'cross-pack'],
  ceoDecisions: ['intake'] }) {
  const setup = { organization: { ceo: { id: 'ceo-a' }, authorityPolicy: policy }, enabledPacks: [] };
  const intake = { id: 'intake-a', assigneeId: 'worker-a', status: 'offered' };
  const escalation = { id: 'escalation-a', status: 'pending', eligibleRole: 'ceo', subjectType: 'intake' };
  const calls = [];
  const control = { getSetup: async () => setup, getIntake: async () => [intake],
    getEscalations: async () => [escalation],
    createWorkPlan: async (request) => { calls.push({ operation: 'plan', request }); return { id: 'plan-a' }; },
    routeIntake: async (request) => { calls.push({ operation: 'route', request });
      return { ...intake, status: 'offered', assigneeId: request.assigneeId, id: request.intakeId }; },
    adjudicate: async (request) => { calls.push({ operation: 'adjudicate', request }); return { id: request.escalationId }; } };
  const host = { db: {}, manifest: { id: 'test.graph' },
    agents: { get: async (id, companyId) => companyId === 'company-a' ? { id, companyId } : null },
    projects: { get: async (id, companyId) => id === 'project-a' && companyId === 'company-a' ? { id } : null },
    issues: { list: async () => [] } };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ control }),
    getConfig: async () => ({ roleBindings: { ceo: 'ceo-a' }, defaultMode: 'manual' }),
    trustedActor: async (_companyId, hostActor) => ({ actor: {
      id: hostActor.agentId, kind: 'agent', roles: hostActor.agentId === 'ceo-a' ? ['ceo'] : ['worker'],
      executionId: hostActor.runId }, isAdministrator: false }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const call = (actorId, operation, fields = {}) => api.command({ companyId: 'company-a',
    hostActor: { actorType: 'agent', agentId: actorId, runId: `${actorId}-run` },
    body: { operation, reason: 'Delegated work', idempotencyKey: `${operation}-${actorId}`,
      ...fields } });
  return { call, calls };
}

test('bound CEO may plan and assign intake within explicit Board delegation', async () => {
  const { call, calls } = fixture();
  await call('ceo-a', 'create-plan', { projectId: 'project-a', items: [{ id: 'item-a' }] });
  await call('ceo-a', 'route-intake', { intakeId: 'intake-a', outcome: 'assign', assigneeId: 'worker-b' });
  await call('ceo-a', 'adjudicate', { escalationId: 'escalation-a', outcome: 'accept', evidence: [{ id: 'proof' }] });
  assert.deepEqual(calls.map((item) => item.operation), ['plan', 'route', 'adjudicate']);
  assert.equal(calls[1].request.assigneeId, 'worker-b');
});

test('unbound agent and missing Board scopes cannot use CEO authority', async () => {
  const { call } = fixture({ ceoOperations: ['intake'], ceoDecisions: [] });
  await assert.rejects(call('ceo-a', 'create-plan', { projectId: 'project-a', items: [] }), /has not delegated CEO work-plan/);
  await assert.rejects(call('worker-a', 'create-plan', { projectId: 'project-a', items: [] }), /bound company CEO/);
  await assert.rejects(call('ceo-a', 'adjudicate', { escalationId: 'escalation-a', outcome: 'accept', evidence: [{ id: 'proof' }] }),
    /has not delegated CEO decision/);
});

test('assigned Agent may reject only its own persisted intake offer', async () => {
  const { call, calls } = fixture();
  await call('worker-a', 'route-intake', { intakeId: 'intake-a', outcome: 'reject', assigneeId: 'other-agent' });
  assert.equal(calls[0].request.outcome, 'reject');
  await assert.rejects(call('worker-b', 'route-intake', { intakeId: 'intake-a', outcome: 'reject', assigneeId: 'worker-b' }),
    /bound company CEO/);
});
