import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { loadCatalog } from '../../src/plugin/catalog.mjs';
import { createPackRegistry } from '../../src/plugin/pack-registry.mjs';

const pack = (version, title = `Graph ${version}`) => ({
  id: 'adlc', version, roles: { maker: { id: 'maker' } },
  graphs: [{ id: 'work', version, title, start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'make', to: 'end' }] }],
});
const actor = { id: 'owner', kind: 'human', roles: ['human-owner'], executionId: 'ui' };

async function fixture(t, initial) {
  const directory = await mkdtemp(join(tmpdir(), 'polyforge-packs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'index.mjs');
  const publish = (packs) => writeFile(entry, `export const packs = ${JSON.stringify(packs)};\n`);
  await publish(initial);
  const instances = new Map();
  const counts = new Map();
  const registry = createPackRegistry({
    load: (options) => loadCatalog({ ...options, entries: [entry] }),
    async prepareCompany(companyId, previous) {
      if (previous) return previous;
      const store = new MemoryStore();
      class CountingEngine extends GraphEngine {
        async registerPacks(releases) {
          counts.set(companyId, (counts.get(companyId) ?? 0) + releases.length);
          return super.registerPacks(releases);
        }
      }
      const instance = { store, engine: new CountingEngine({ store }) };
      instances.set(companyId, instance);
      return instance;
    },
  });
  return { entry, publish, registry, instances, counts };
}

test('catalog loads from a local Pack entry and refreshes the entry snapshot', async (t) => {
  const f = await fixture(t, [pack('1')]);
  const first = await loadCatalog({ entries: [f.entry] });
  assert.deepEqual(first.map(item => item.version), ['1']);
  await f.publish([pack('1'), pack('2')]);
  const second = await loadCatalog({ entries: [f.entry], force: true });
  assert.deepEqual(second.map(item => item.version), ['1', '2']);
});

test('concurrent company reads register each release once and isolate company stores', async (t) => {
  const f = await fixture(t, [pack('1')]);
  assert.equal(f.registry.health().status, 'degraded');
  const companies = await Promise.all(Array.from({ length: 12 }, (_, i) => f.registry.forCompany(i % 2 ? 'acme' : 'beta')));
  assert.equal(f.counts.get('acme'), 1);
  assert.equal(f.counts.get('beta'), 1);
  assert.equal(companies[0].pack.version, '1');
  assert.notEqual(companies[0].store, companies[1].store);
  assert.equal((await f.instances.get('acme').store.read()).audit.filter(item => item.kind === 'pack.registered').length, 1);
  assert.equal(f.registry.health().status, 'ok');
});

test('a reload racing initial company registration audits each release once', async (t) => {
  const f = await fixture(t, [pack('1')]);
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let readStarted;
  const firstRead = new Promise(resolve => { readStarted = resolve; });
  let reloadLoaded;
  const forcedLoad = new Promise(resolve => { reloadLoaded = resolve; });
  class BarrierStore extends MemoryStore {
    reads = 0;
    async read() {
      if (++this.reads === 1) {
        readStarted();
        await readGate;
      }
      return super.read();
    }
  }
  const store = new BarrierStore();
  const registry = createPackRegistry({
    load: async (options) => {
      const result = await loadCatalog({ ...options, entries: [f.entry] });
      if (options?.force) reloadLoaded();
      return result;
    },
    async prepareCompany(_companyId, previous) {
      return previous ?? { store, engine: new GraphEngine({ store }) };
    },
  });
  const initial = registry.forCompany('acme');
  await firstRead;
  await f.publish([pack('1'), pack('2')]);
  const reloading = registry.reload('acme', { version: '2' });
  await forcedLoad;
  await new Promise(resolve => setImmediate(resolve));
  releaseRead();
  await Promise.all([initial, reloading]);
  const state = await store.read();
  assert.deepEqual(state.audit.filter(item => item.kind === 'pack.registered')
    .map(item => `${item.packId}@${item.packVersion}`), ['adlc@1', 'adlc@2']);
  assert.equal(state.revision, 2);
});

test('a removed release cannot return with changed bytes under its old version', async (t) => {
  const f = await fixture(t, [pack('1')]);
  await f.registry.forCompany('acme');
  await f.publish([pack('2')]);
  await f.registry.reload('acme', { version: '2' });
  await f.publish([pack('1', 'Reused version'), pack('2')]);
  await assert.rejects(f.registry.reload('acme', { version: '1' }), /changed without a version bump/);
  assert.deepEqual(f.registry.catalog().map(item => item.version), ['2']);
  assert.equal(f.registry.health().status, 'degraded');
  assert.equal((await f.instances.get('acme').store.read()).packs['adlc@1'].graphs[0].title, 'Graph 1');
});

test('a company registration failure stays visible until that company recovers', async () => {
  let failBeta = true;
  const instances = new Map();
  const registry = createPackRegistry({
    load: async () => [pack('1')],
    async prepareCompany(companyId, previous) {
      if (companyId === 'beta' && failBeta) throw new Error('beta store unavailable');
      if (previous) return previous;
      const store = new MemoryStore();
      const instance = { store, engine: new GraphEngine({ store }) };
      instances.set(companyId, instance);
      return instance;
    },
  });
  await assert.rejects(registry.forCompany('beta'), /beta store unavailable/);
  await registry.forCompany('acme');
  assert.match(registry.health().message, /beta store unavailable/);
  failBeta = false;
  await registry.forCompany('beta');
  assert.equal(registry.health().status, 'ok');
});

test('reload rejects changed releases and invalid new releases while preserving pinned runs', async (t) => {
  const f = await fixture(t, [pack('1')]);
  const { engine } = await f.registry.forCompany('acme');
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'work', actor });

  await f.publish([pack('1', 'Altered without a version')]);
  await assert.rejects(f.registry.reload('acme'), /changed without a version bump/);
  assert.deepEqual(f.registry.catalog().map(item => item.version), ['1']);
  assert.equal(f.registry.health().status, 'degraded');

  const invalid = { ...pack('3'), graphs: [{ ...pack('3').graphs[0], start: 'missing' }] };
  await f.publish([pack('1'), pack('2'), invalid]);
  const beforeFailedBatch = await f.instances.get('acme').store.read();
  await assert.rejects(f.registry.reload('acme', { version: '2' }), /Invalid node ids\/start/);
  assert.deepEqual(f.registry.catalog().map(item => item.version), ['1']);
  assert.deepEqual(await f.instances.get('acme').store.read(), beforeFailedBatch);
  await assert.rejects(engine.startRun({ packId: 'adlc', packVersion: '2', graphId: 'work', actor }), /Pack version not registered/);

  await f.publish([pack('1'), pack('2'), pack('3')]);
  const selected = await f.registry.reload('acme', { version: '2' });
  assert.equal(selected.version, '2');
  assert.deepEqual(f.registry.catalog().map(item => item.version), ['1', '2', '3']);
  assert.equal(f.registry.health().status, 'ok');
  assert.equal((await engine.getRun(run.id)).graph.title, 'Graph 1');
  assert.equal((await engine.getRun(run.id)).packVersion, '1');
  assert.ok((await f.instances.get('acme').store.read()).packs['adlc@2']);

  await f.publish([pack('2')]);
  await f.registry.reload('acme', { version: '2' });
  assert.deepEqual(f.registry.catalog().map(item => item.version), ['2']);
  assert.equal((await engine.getRun(run.id)).pack.version, '1');
  assert.equal((await engine.getRun(run.id)).graph.title, 'Graph 1');
});

test('failed initial catalog load can recover on a later call', async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(f.registry.installed(), /No Pack index.mjs found/);
  assert.equal(f.registry.health().status, 'degraded');
  await f.publish([pack('1')]);
  assert.deepEqual((await f.registry.installed()).map(item => item.version), ['1']);
  assert.equal(f.registry.health().status, 'ok');
});
