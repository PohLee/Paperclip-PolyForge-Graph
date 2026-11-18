import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import { packDigest } from '../../src/plugin/pack-snapshot.mjs';
import { createPackHostAdapterRegistry } from '../../src/plugin/pack-host-support.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'], executionId: null };
const system = { id: 'plugin', kind: 'system', roles: [], executionId: null };
async function fixture({ mutate = false } = {}) {
  const contract = { version: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputMapping: {} };
  const pack = { id: 'adlc', version: 'test', graphStartRoles: { parent: ['owner'], child: ['owner'] }, graphs: [
    { id: 'parent', version: '1', start: 'call', workflowContract: contract, nodes: [
      { id: 'call', type: 'workflow', workflow: { packId: 'adlc', packVersion: 'test', graphId: 'child', graphVersion: '1' }, inputMapping: {} },
      { id: 'end', type: 'end' }], edges: [{ from: 'call', to: 'end' }] },
    { id: 'child', version: '1', start: 'task', workflowContract: contract,
      nodes: [{ id: 'task', type: 'task' }, { id: 'end', type: 'end' }], edges: [{ from: 'task', to: 'end' }] },
  ] };
  const raw = new GraphEngine(); await raw.registerPack(pack);
  const records = new Map(), validated = [];
  let fail = false;
  const registry = createPackHostAdapterRegistry({ adapterBundleDigest: 'bundle', runValidationDigest, systemActorId: 'plugin',
    runtimeStore: { get: async (_company, id) => records.get(id), record: async (_company, id, identity) => {
      if (fail) throw new Error('binding interrupted'); records.set(id, identity);
    } },
    trustedAdapters: [{ packId: pack.id, packVersion: pack.version, packDigest: packDigest(pack), adapterId: 'adlc-host-api', adapterVersion: '1',
      createHostApi: ({ engine, resolveActor }) => ({ startRun: async args => {
        const actor = await resolveActor({ claimedActor: args.actor, context: { operation: 'startRun' } });
        validated.push(actor.id);
        return engine.startRun({ ...args, actor, ...(mutate && args.graphId === 'child' ? { input: { ...args.input, paperclipCompanyId: 'foreign' } } : {}) });
      } }) }],
  });
  const engine = registry.withEngine(raw, 'company', [pack]);
  const parent = await engine.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'parent', actor: owner,
    input: { paperclipCompanyId: 'company', paperclipIssueId: 'issue', workflowInput: {} } });
  return { raw, engine, registry, parent, records, validated, failBinding: value => { fail = value; } };
}

test('governed child validates original actor and repairs interrupted adapter binding without duplicate creation', async () => {
  const f = await fixture(); f.failBinding(true);
  const args = { runId: f.parent.id, nodeId: 'call', actor: system };
  await assert.rejects(f.engine.startChildWorkflow(args), /binding interrupted/);
  const childId = (await f.raw.getRun(f.parent.id)).nodeStates.call.childRunId;
  assert.ok(childId);
  assert.equal((await f.registry.runStatus(f.raw, 'company', await f.raw.getRun(childId))).available, false);
  f.failBinding(false);
  const child = await f.engine.startChildWorkflow(args);
  assert.equal(child.id, childId);
  assert.deepEqual(f.validated, ['owner', 'owner', 'owner']);
  assert.equal((await f.registry.runStatus(f.raw, 'company', child)).available, true);
  assert.equal(Object.keys((await f.raw.store.read()).runs).length, 2);
  f.records.delete(f.parent.id);
  assert.equal((await f.registry.runStatus(f.raw, 'company', child)).available, false);
  assert.deepEqual(await f.engine.getWorkItems(child.id), []);
  await assert.rejects(f.engine.submitNode({ runId: child.id, nodeId: 'task', actor: owner }), /adapter identity is missing/);
});

test('child adapter cannot change trusted start context before atomic creation', async () => {
  const f = await fixture({ mutate: true });
  const before = await f.raw.store.read();
  await assert.rejects(f.engine.startChildWorkflow({ runId: f.parent.id, nodeId: 'call', actor: system }), /changed the pinned/);
  assert.deepEqual(await f.raw.store.read(), before);
});
