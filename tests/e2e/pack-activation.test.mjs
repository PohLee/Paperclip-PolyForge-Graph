import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectableRunPacks } from '../../src/core/pack-activation.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import plugin from '../../src/plugin/worker.mjs';
import { createSeatDispatch } from '../../src/plugin/seat-dispatch.mjs';
import * as seatRules from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/product-method-contracts.mjs';

test('New run preserves catalog and single-Pack fallbacks when the legacy response omits activation', () => {
  const current = { id: 'planning', version: '2.0.0' };
  const older = { id: 'planning', version: '1.0.0' };
  assert.deepEqual(selectableRunPacks({ catalog: [current, older], pack: current }), [current, older]);
  assert.deepEqual(selectableRunPacks({ pack: current }), [current]);
  assert.deepEqual(selectableRunPacks({ catalog: [current], enabledPacks: null }), []);
  assert.deepEqual(selectableRunPacks({ catalog: [current], pack: older,
    enabledPacks: [{ packId: older.id, version: older.version }] }), []);
});

test('New run projects company activation and the worker rechecks it after a version switch', async (t) => {
  const packId = 'planning';
  const older = '1.0.0';
  const current = '2.0.0';
  const directory = await mkdtemp(join(tmpdir(), 'polyforge-activation-'));
  const entry = join(directory, 'packs.mjs');
  const priorEntries = process.env.POLYFORGE_PACK_ENTRIES;
  t.after(async () => {
    if (priorEntries === undefined) delete process.env.POLYFORGE_PACK_ENTRIES;
    else process.env.POLYFORGE_PACK_ENTRIES = priorEntries;
    await unlink(entry);
    await rmdir(directory);
  });
  const packs = [current, older].map(version => ({ id: packId, version, roles: {},
    skills: { planning: { id: 'planning' } },
    graphStartRoles: { plan: ['human-owner'] }, decisionRules: [],
    graphs: ['1', '2'].map(version => ({ id: 'plan', version, start: 'end', nodes: [{ id: 'end', type: 'end' }], edges: [] })) }));
  await writeFile(entry, `export const packs = ${JSON.stringify(packs)};`);
  process.env.POLYFORGE_PACK_ENTRIES = entry;

  const states = new Map();
  let userId = 'other-admin';
  await plugin.definition.setup({ manifest, logger: { warn() {} },
    config: { get: async () => ({ adlcProjects: { project: { ownerId: 'project-owner' } } }) }, db: {
    namespace: 'plugin_test',
    async query(sql, [companyId] = []) {
      const state = states.get(companyId);
      return sql.includes('graph_state') && state
        ? [{ revision: state.revision, document: structuredClone(state) }] : [];
    },
    async execute(sql, [companyId, , document, expectedRevision]) {
      if (sql.includes('DELETE FROM plugin_test.graph_dispatch_slot')) return { rowCount: 0 };
      assert.ok(sql.includes('graph_state'), `Unexpected database mutation: ${sql}`);
      if (states.get(companyId)?.revision !== expectedRevision) return { rowCount: 0 };
      states.set(companyId, JSON.parse(document));
      return { rowCount: 1 };
    },
  }, issues: { get: async id => ({ id, projectId: 'project' }), list: async () => [],
    create: async () => ({ id: 'planned-issue' }) },
  projects: { get: async id => ({ id }) },
  access: { members: { list: async () => ['other-admin', 'project-owner'].map(principalId => ({
    principalType: 'user', principalId, status: 'active', membershipRole: principalId === 'other-admin' ? 'admin' : 'member',
  })) } },
  events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} } });

  const companyId = 'activation-company';
  const issueId = 'issue';
  const invoke = (routeKey, fields, scope = companyId) => plugin.definition.onApiRequest({ routeKey,
    companyId: scope, actor: { actorType: 'user', userId }, params: { issueId }, ...fields });
  async function read(runId, scope) {
    const response = await invoke('graph-read', { query: { runId } }, scope);
    assert.equal(response.body.error, undefined);
    return response.body;
  }
  async function activate(version) {
    userId = 'other-admin';
    const response = await invoke('company-command', { body: { companyId, operation: 'enable-pack',
      packId, version, reason: 'Select company planning Pack', idempotencyKey: `activate-${version}` } });
    assert.deepEqual(response.body, { packId, version });
    userId = 'project-owner';
  }
  const start = (packVersion, idempotencyKey, scope, graphVersion, input) => invoke('graph-command', { body: { operation: 'start',
    packId, packVersion, graphId: 'plan', ...(graphVersion === undefined ? {} : { graphVersion }), idempotencyKey, input } }, scope);

  const provision = await invoke('graph-command', { body: { operation: 'provision', packId, packVersion: current } });
  assert.match(provision.body.error, /Installed manifest lacks this Pack's managed resources/);

  const empty = await read();
  assert.deepEqual(empty.catalog.map(pack => pack.version), [current, older]);
  assert.deepEqual(empty.enabledPacks, []);
  assert.deepEqual(selectableRunPacks(empty), []);
  assert.match((await start(older, 'before-activation')).body.error, /Pack is not enabled for this company/);

  await activate(older);
  const openForm = selectableRunPacks(await read());
  assert.deepEqual(openForm.map(pack => [pack.id, pack.version]), [[packId, older]]);
  assert.deepEqual(selectableRunPacks(await read(undefined, 'other-company')), []);
  assert.match((await start(older, 'wrong-company', 'other-company')).body.error, /Pack is not enabled for this company/);
  const seatOverrides = { draft: { model: 'project-owner-model' } };
  userId = 'other-admin';
  assert.match((await start(older, 'admin-start', companyId, '1', { seatOverrides })).body.error, /Actor role/);
  userId = 'project-owner';
  const started = await start(older, 'old-run', companyId, '1', { seatOverrides });
  assert.deepEqual(started.body.run?.startedBy.roles, ['human-owner']);
  assert.deepEqual(started.body.run?.input.seatOverrides, seatOverrides);
  const draft = { id: 'draft', role: 'maker', seat: { name: 'author' } };
  const resolveSeat = createSeatDispatch({
    manifest,
    config: { get: async () => ({ adlcProjects: { project: { seatGroups: { plan: [{ draft: {} }] } } } }) },
    agents: { list: async () => [{ id: 'agent', adapterType: 'claude_local', adapterConfig: { model: 'default' } }] },
  }, seatRules);
  const selection = await resolveSeat({ companyId,
    engine: { listDecisions: async () => [] }, node: draft, attempt: 1,
    run: { ...started.body.run, packId: 'adlc', graph: { id: 'plan', nodes: [draft] } },
    config: { roleBindings: { maker: 'agent' } },
  });
  assert.equal(selection.selection?.adapterConfig.model, 'project-owner-model');


  const planCommand = (operation, fields) => invoke('company-command', { body: {
    companyId, operation, reason: 'Plan project work', idempotencyKey: operation, ...fields,
  } });
  userId = 'other-admin';
  const plan = (await planCommand('create-plan', { projectId: 'project',
    items: [{ id: 'item', priority: 1, packId, packVersion: older, graphId: 'plan' }],
  })).body;
  assert.ok(plan.id, JSON.stringify(plan));
  const startPlan = () => planCommand('start-plan-item', { planId: plan.id, itemId: 'item' });
  assert.match((await startPlan()).body.error, /CEO agent run required/);
  userId = 'project-owner';
  const planned = (await startPlan()).body;
  assert.equal(planned.run?.startedBy.id, 'project-owner', JSON.stringify(planned));
  assert.deepEqual(planned.run.startedBy.roles, ['human-owner']);

  assert.equal(started.body.run?.packVersion, older, JSON.stringify(started.body));

  await activate(current);
  const stale = await start(openForm[0].version, 'stale-form');
  assert.match(stale.body.error, /Pack is not enabled for this company/);
  const pinned = await read(started.body.run.id);
  assert.deepEqual(pinned.runs.map(run => run.id), [started.body.run.id]);
  assert.equal(pinned.run.packVersion, older);
  assert.deepEqual(selectableRunPacks(pinned).map(pack => [pack.id, pack.version]), [[packId, current]]);
  for (const invalidVersion of ['', '  ', null, 2]) {
    const invalid = await start(current, 'invalid-version', companyId, invalidVersion);
    assert.match(invalid.body.error, /graphVersion must be a non-blank string/);
  }
  const fresh = await start(current, 'new-run', companyId, '2');
  assert.equal(started.body.run.graph.version, '1');
  assert.equal(fresh.body.run?.graph.version, '2', JSON.stringify(fresh.body));
  assert.match((await start(current, 'unknown-version', companyId, '3')).body.error, /Exact Graph version/);
  assert.equal(fresh.body.run?.packVersion, current, JSON.stringify(fresh.body));
});
