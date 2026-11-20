import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

const companyId = 'workspace-company';
const human = { id: 'owner', kind: 'human', roles: ['human-owner', 'owner'], executionId: null };
const contract = { version: 1,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, properties: {} }, outputMapping: {} };

async function fixture({ scope = 'node', declaration = 'exclusive', workflow = false, assigned = false } = {}) {
  const engine = new GraphEngine({ store: new MemoryStore() });
  const policy = { writeAccess: declaration };
  if (workflow) await engine.registerPack({ id: 'child-pack', version: '1', graphs: [{
    id: 'child', version: '1', start: 'make', workflowContract: contract,
    nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
  }], roles: { maker: { documents: {} } } });
  await engine.registerPack({ id: 'parent-pack', version: '1', ...(scope === 'pack' ? { workspace: policy } : {}),
    roles: { maker: { documents: {} } }, graphs: [{ id: 'parent', version: '1', start: 'make',
      nodes: [{ id: 'make', ...(scope === 'node' ? { workspace: policy } : {}),
        ...(workflow ? { type: 'workflow', workflow: {
          packId: 'child-pack', packVersion: '1', graphId: 'child', graphVersion: '1',
        }, inputMapping: {} } : { type: 'task', role: 'maker' }) }], edges: [] }] });
  const run = await engine.startRun({ packId: 'parent-pack', packVersion: '1', graphId: 'parent', actor: human,
    input: { paperclipCompanyId: companyId, paperclipIssueId: 'root', workflowInput: {} } });
  const counters = { assignments: 0, creates: 0, reservations: 0, starts: 0, reconciles: 0 };
  const row = { issue_id: 'existing', agent_id: 'agent', agent_run_id: null, state: 'issued' };
  const host = { manifest: { id: 'plugin.workspace' }, issues: {
    get: async id => ({ id, companyId, assigneeAgentId: id === 'existing' && assigned ? 'agent' : null }),
    update: async () => { counters.assignments++; },
    create: async () => { counters.creates++; throw new Error('Unexpected issue creation'); },
  }, agents: { get: async id => ({ id }) } };
  const persistence = { get: async (_company, id) => !workflow && id === run.id ? row : null,
    readState: () => engine.store.read(), reserveSlot: async () => { counters.reservations++; return true; },
    reconcileSlots: async () => [] };
  const dispatch = createDispatch(host, async () => ({ engine }), async () => ({}), persistence);
  const originalStart = engine.startChildWorkflow.bind(engine);
  engine.startChildWorkflow = async (...args) => { counters.starts++; return originalStart(...args); };
  const originalReconcile = engine.reconcileChildWorkflow.bind(engine);
  engine.reconcileChildWorkflow = async (...args) => { counters.reconciles++; return originalReconcile(...args); };
  return { engine, run, counters, dispatch, originalStart };
}

test('recovering an unassigned issue enforces pinned node and Pack workspace policy', async t => {
  for (const scope of ['node', 'pack']) for (const declaration of ['exclusive', 'invalid']) {
    await t.test(`${scope} ${declaration}`, async () => {
      const f = await fixture({ scope, declaration });
      const actions = await f.dispatch.dispatchReady(companyId, f.engine, f.run.id, { roleBindings: {} });
      assert.equal(actions[0].status, 'blocked');
      assert.equal(actions[0].reason, declaration === 'exclusive' ? 'workspace_admission_unavailable' : 'invalid_workspace_declaration');
      assert.equal(f.counters.assignments, 0);
      assert.equal(f.counters.reservations, 0);
    });
  }
});

test('existing assigned exclusive issues can report state, while unmanaged recovery still assigns', async () => {
  const assigned = await fixture({ assigned: true });
  assert.equal((await assigned.dispatch.dispatchReady(companyId, assigned.engine, assigned.run.id, {}))[0].status, 'issued');
  assert.equal(assigned.counters.assignments, 0);
  const unmanaged = await fixture({ declaration: 'none' });
  assert.equal((await unmanaged.dispatch.dispatchReady(companyId, unmanaged.engine, unmanaged.run.id, {}))[0].status, 'issued');
  assert.equal(unmanaged.counters.assignments, 1);
});

test('new and resumed workflows inherit parent node and Pack workspace policy', async t => {
  for (const scope of ['node', 'pack']) for (const declaration of ['exclusive', 'invalid']) {
    for (const linked of [false, true]) await t.test(`${scope} ${declaration} linked=${linked}`, async () => {
      const f = await fixture({ scope, declaration, workflow: true });
      const child = linked ? await f.originalStart({ runId: f.run.id, nodeId: 'make',
        actor: { id: 'plugin.workspace', kind: 'system', roles: [], executionId: null } }) : null;
      const actions = await f.dispatch.dispatchReady(companyId, f.engine, f.run.id, { roleBindings: {} });
      assert.equal(actions[0].status, 'blocked');
      assert.equal(actions[0].reason, declaration === 'exclusive' ? 'workspace_admission_unavailable' : 'invalid_workspace_declaration');
      assert.equal(f.counters.starts, 0);
      assert.equal(f.counters.creates, 0);
      assert.equal(f.counters.reconciles, 0);
      assert.equal(f.counters.reservations, 0);
      assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.childRunId, child?.id);
      if (child) {
        assert.deepEqual(await f.dispatch.dispatchReady(companyId, f.engine, child.id, { roleBindings: {} }), []);
        assert.equal(f.counters.creates, 0);
        assert.equal(f.counters.reconciles, 0);
      }
    });
  }
});
