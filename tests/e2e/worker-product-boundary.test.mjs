import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';

test('agent cannot omit Graph run ID for a dispatched child issue', async () => {
  let state;
  const childIssueId = 'graph-child';
  const host = {
    manifest,
    logger: { warn() {} },
    db: {
      namespace: 'plugin_test',
      async query(sql, args = []) {
        if (sql.includes('graph_dispatch')) return args[1] === childIssueId
          ? [{ graph_run_id: 'graph-run', node_id: 'make', issue_id: childIssueId,
            agent_id: 'maker', agent_run_id: 'paperclip-run', state: 'woken' }] : [];
        if (sql.includes('graph_state')) return state
          ? [{ revision: state.revision, document: structuredClone(state) }] : [];
        return [];
      },
      async execute(sql, args) {
        if (!sql.includes('graph_state')) throw new Error(`Unexpected write: ${sql}`);
        if (sql.includes('INSERT') && !state || sql.includes('UPDATE') && state?.revision === args[3]) {
          state = JSON.parse(args[2]);
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    issues: {
      get: async (id) => ({ id }),
      assertCheckoutOwner: async () => ({ checkoutRunId: 'paperclip-run', assigneeAgentId: 'maker' }),
    },
    access: { members: { list: async () => [] } },
    events: { on() {} },
    jobs: { register() {} },
    actions: { register() {} },
    tools: { register() {} },
  };
  await plugin.definition.setup(host);
  const result = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
    params: { issueId: childIssueId }, actor: { actorType: 'agent', agentId: 'maker', runId: 'paperclip-run' },
    body: { operation: 'product-decision', status: 'proposed', feature: 'calculator',
      outcome: 'Change behavior', reason: 'Requested', changeScope: ['/api'] } });
  assert.match(result.body.error, /Graph runId is required for a dispatched child issue/);
  assert.equal(state.decisions.length, 0);

  const standalone = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
    params: { issueId: 'standalone' }, actor: { actorType: 'agent', agentId: 'maker', runId: 'paperclip-run' },
    body: { operation: 'product-decision', status: 'proposed', feature: 'calculator',
      outcome: 'Change behavior', reason: 'Requested', changeScope: ['/api'] } });
  assert.equal(standalone.body.result.status, 'proposed', JSON.stringify(standalone));
  assert.equal(standalone.body.result.issueId, 'standalone');
});
