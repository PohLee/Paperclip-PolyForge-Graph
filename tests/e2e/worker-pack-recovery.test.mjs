import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { GraphEngine } from '../../src/core/index.mjs';

test('worker revalidation authenticates owner and root issue, records invalid results without dispatch', async () => {
  const fixture = new GraphEngine();
  await fixture.registerPack({ id: 'adlc', version: '0.0.1', graphs: [{ id: 'old-graph', version: '1', start: 'task',
    nodes: [{ id: 'task', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'task', to: 'end' }] }], decisionRules: [] });
  const run = await fixture.startRun({ packId: 'adlc', packVersion: '0.0.1', graphId: 'old-graph',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'], executionId: null },
    input: { paperclipIssueId: 'root-issue' } });
  let state = await fixture.store.read();
  const audits = [], effects = [];
  const host = { manifest, logger: { warn() {} },
    db: { namespace: 'plugin_test',
      async query(sql, args = []) {
        if (sql.includes('WITH locked_state AS MATERIALIZED')) {
          audits.push(args);
          return [{ validation_revision: audits.length, validation_token: args[4], status: args[5],
            source_graph_revision: args[2], source_digest: args[3], adapter_identity: null,
            previous_identity: null, actor: JSON.parse(args[7]), reason: args[8], issues: JSON.parse(args[9]),
            validated_subject_refs: JSON.parse(args[10]), rebound_count: 0 }];
        }
        if (sql.includes('graph_state')) return [{ revision: state.revision, document: structuredClone(state) }];
        return [];
      },
      async execute(sql, args) {
        assert.ok(sql.includes('graph_state'), `Unexpected mutation: ${sql}`);
        if (sql.includes('UPDATE') && state.revision === args[3]) {
          state = JSON.parse(args[2]); return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    issues: { get: async id => ({ id }), create: async () => { effects.push('issue'); } },
    agents: { wakeup: async () => { effects.push('wakeup'); } },
    access: { members: { list: async () => ['owner', 'member'].map(id => ({ principalType: 'user',
      principalId: id, status: 'active', membershipRole: id })) } },
    events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} },
  };
  await plugin.definition.setup(host);
  const invoke = (actor, issueId = 'root-issue') => plugin.definition.onApiRequest({ routeKey: 'graph-command',
    companyId: 'company', params: { issueId }, actor, body: { operation: 'revalidate-run', runId: run.id,
      reason: 'Check existing run', idempotencyKey: 'explicit-request', actor: { kind: 'human', roles: ['human-owner'] } } });
  for (const actor of [{ actorType: 'agent', agentId: 'agent', runId: 'execution' },
    { actorType: 'user', userId: 'member' }]) {
    assert.match((await invoke(actor)).body.error, /requires a human owner/);
  }
  assert.equal(audits.length, 0);
  assert.match((await invoke({ actorType: 'user', userId: 'owner' }, 'other-issue')).body.error, /rooted at this Paperclip issue/);
  assert.equal(audits.length, 0);
  const result = await invoke({ actorType: 'user', userId: 'owner' });
  assert.equal(result.body.valid, false, JSON.stringify(result));
  assert.equal(result.body.issues[0].code, 'trusted-adapter-unavailable');
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0][7]).id, 'owner');
  assert.deepEqual(effects, []);
});
