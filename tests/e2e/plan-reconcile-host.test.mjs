import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

test('company plan read reconciles a completed linked Graph run before showing dependencies', async () => {
  const item = { id: 'item-a', packId: 'adlc', packVersion: '0.8.0', graphId: 'delivery',
    status: 'active', runId: 'run-a' };
  const plan = { id: 'plan-a', companyId: 'company-a', projectId: 'project-a', version: 2, items: [item] };
  const state = { control: { companyId: 'company-a', plans: [plan], escalations: [], reviews: [] },
    runs: { 'run-a': { id: 'run-a', packId: 'adlc', packVersion: '0.8.0', graph: { id: 'delivery' },
      status: 'completed', input: { planId: 'plan-a', planItemId: 'item-a',
        paperclipCompanyId: 'company-a', projectId: 'project-a' } } } };
  const calls = [];
  const store = { read: async () => state };
  const control = {
    getShadowPolicy: async () => ({ enabled: false }), getTemporaryAgentPolicy: async () => ({ enabled: false }),
    getSetup: async () => ({ organization: null, enabledPacks: [] }),
    readReconciledWorkPlans: async (request) => {
      calls.push(request);
      if (item.status !== 'completed') { item.status = 'completed'; plan.version++; }
      return state;
    },
  };
  const host = { db: { namespace: 'plugin_test', query: async () => [] }, manifest: { id: 'test.graph' },
    agents: { list: async () => [] }, projects: { list: async () => [] }, goals: { list: async () => [] } };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store, control }),
    getConfig: async () => ({ roleBindings: {}, defaultMode: 'manual' }),
    trustedActor: async () => ({ actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'] },
      isAdministrator: true }), capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const result = await api.read({ companyId: 'company-a', hostActor: { userId: 'owner-a' } });
  assert.equal(result.control.plans[0].items[0].status, 'completed');
  assert.deepEqual(calls[0].actor, { id: 'test.graph', kind: 'system', roles: ['work-plan-reconciler'] });
  await api.read({ companyId: 'company-a', hostActor: { userId: 'owner-a' } });
  assert.equal(calls.length, 2);
});

test('company setup readiness uses native budget and primary workspace, not structural setup alone', async () => {
  const setup = { ready: true, organization: { board: { id: 'owner-a' }, ceo: { id: 'ceo-a' },
    domainHeads: [{ domain: 'product', agentId: 'lead-a' }] },
    enabledPacks: [{ packId: 'pack-a', version: '1.0.0' }] };
  const pack = { id: 'pack-a', version: '1.0.0', roles: { lead: {} },
    graphs: [{ id: 'graph-a', nodes: [{ id: 'work', role: 'lead' }], edges: [] }] };
  const agent = (id, budgetMonthlyCents) => ({ id, status: 'idle', adapterType: 'process',
    adapterConfig: { command: 'fixture-agent' }, budgetMonthlyCents, spentMonthlyCents: 0 });
  const host = { db: { namespace: 'plugin_test', query: async (sql) => {
    if (sql.includes('graph_channel_config')) return [{ settings: {
      outboundMode: 'simulate', telegram: { webhookSecretRef: 'secret-webhook',
        botTokenSecretRef: 'secret-bot', bindings: [{ chatId: 'chat-a' }] },
      email: { tokenSecretRef: 'secret-email', endpoint: 'https://example.invalid/send' },
    } }];
    if (sql.includes('graph_notification_delivery')) return [{ notification_id: 'notice-a',
      channel: 'telegram', status: 'simulated', receipt: { provider: 'local-simulation' } }];
    return [];
  } }, manifest: { id: 'test.graph' },
    agents: { list: async () => [agent('ceo-a', 0), agent('lead-a', 100)] },
    projects: { list: async () => [{ id: 'project-a', name: 'Project A', status: 'active',
      codebase: { repoUrl: 'https://example.invalid/repo' } }],
    getPrimaryWorkspace: async () => ({ cwd: 'C:/repo', repoUrl: 'https://example.invalid/repo' }) },
    goals: { list: async () => [] } };
  const store = { read: async () => ({ control: { plans: [], audit: [], reviews: [] }, runs: {}, decisions: [] }) };
  const control = { getSetup: async () => setup, getShadowPolicy: async () => ({ enabled: false }), getTemporaryAgentPolicy: async () => ({ enabled: false }),
    readReconciledWorkPlans: async () => store.read() };
  const api = createCompanyApi({ host, catalog: () => [pack], engineFor: async () => ({ store, control }),
    getConfig: async () => ({ roleBindings: { ceo: 'ceo-a', 'pack-a:lead': 'lead-a' }, defaultMode: 'manual' }),
    trustedActor: async () => ({ actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'] },
      isAdministrator: true }), capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const result = await api.read({ companyId: 'company-a', hostActor: { userId: 'owner-a' } });
  assert.equal(result.setup.organizationReady, true);
  assert.equal(result.setup.ready, false);
  assert.equal(result.readiness.roles.find((role) => role.id === 'company:ceo').status, 'blocked');
  assert.equal(result.readiness.projects[0].status, 'ready');
  assert.equal(result.channels.telegram, 'simulated');
  assert.equal(result.channels.email, 'simulated');
  assert.equal(result.channels.deliveries[0].status, 'simulated');
  assert.equal(JSON.stringify(result.channels).includes('secret-webhook'), false);
});
