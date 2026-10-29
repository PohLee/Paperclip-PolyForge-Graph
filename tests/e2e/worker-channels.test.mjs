import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';

test('worker registers native company-scoped event, jobs, webhook, and channel routes', async () => {
  const events = new Map(), jobs = new Map(), actions = new Map(), tools = new Map();
  const configs = new Map();
  const states = new Map();
  const host = {
    manifest,
    logger: { warn() {} },
    db: { namespace: 'plugin_test',
      async query(sql, args = []) {
        if (sql.includes('graph_channel_config')) return configs.has(args[0]) ? [{ settings: configs.get(args[0]) }] : [];
        if (sql.includes('graph_state')) return states.has(args[0])
          ? [{ revision: states.get(args[0]).revision, document: structuredClone(states.get(args[0])) }] : [];
        if (sql.includes('graph_config')) return [];
        if (sql.includes('graph_evidence_config')) return [];
        if (sql.includes('graph_state')) return [];
        return [];
      },
      async execute(sql, args) {
        if (sql.includes('graph_channel_config')) { configs.set(args[0], JSON.parse(args[1])); return { rowCount: 1 }; }
        if (sql.includes('graph_state')) {
          if (sql.includes('INSERT') && !states.has(args[0]) || sql.includes('UPDATE') && states.get(args[0])?.revision === args[3]) {
            states.set(args[0], JSON.parse(args[2])); return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        throw new Error(`Unexpected write: ${sql}`);
      } },
    access: { members: { list: async ({ companyId }) => companyId === 'c'
      ? [{ principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' }] : [] } },
    events: { on: (key, handler) => events.set(key, handler) },
    jobs: { register: (key, handler) => jobs.set(key, handler) },
    actions: { register: (key, handler) => actions.set(key, handler) },
    tools: { register: (key, _decl, handler) => tools.set(key, handler) },
  };
  await plugin.definition.setup(host);
  assert.equal(typeof events.get('issue.comment.created'), 'function');
  for (const job of manifest.jobs) assert.equal(typeof jobs.get(job.jobKey), 'function', job.jobKey);
  assert.equal(typeof plugin.definition.onWebhook, 'function');
  assert.ok(manifest.webhooks.some(item => item.endpointKey === 'telegram'));
  assert.ok(manifest.capabilities.includes('events.subscribe'));
  assert.ok(manifest.capabilities.includes('webhooks.receive'));
  assert.ok(manifest.capabilities.includes('issue.comments.create_human_attributed'));

  const actor = { actorType: 'user', userId: 'owner' };
  const saved = await plugin.definition.onApiRequest({ routeKey: 'channel-configure', companyId: 'c', actor,
    body: { companyId: 'c', settings: { outboundMode: 'simulate', recipients: [] },
      reason: 'Configure local simulation', idempotencyKey: 'setup' } });
  assert.equal(saved.body.outboundMode, 'simulate', JSON.stringify(saved));
  const read = await plugin.definition.onApiRequest({ routeKey: 'channel-read', companyId: 'c', actor });
  assert.equal(read.body.outboundMode, 'simulate');
  const deliveries = await plugin.definition.onApiRequest({ routeKey: 'channel-deliveries', companyId: 'c', actor });
  assert.deepEqual(deliveries.body, []);
  const crossCompany = await plugin.definition.onApiRequest({ routeKey: 'channel-configure', companyId: 'c', actor,
    body: { companyId: 'other', settings: { recipients: [] } } });
  assert.equal(crossCompany.status, 400);
  assert.equal(configs.get('c').outboundMode, 'simulate');
});
