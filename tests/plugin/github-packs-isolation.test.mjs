import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubPacks, importedPacks } from '../../src/plugin/github-packs.mjs';
import { createPackRegistry } from '../../src/plugin/pack-registry.mjs';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';

const pack = { id: 'sample', version: '1.0.0', roles: { maker: { id: 'maker' } },
  graphs: [{ id: 'work', version: '1.0.0', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }], edges: [{ from: 'make', to: 'end' }] }] };

test('imports are company scoped, retain distinct same-version content and cannot shadow built-ins', async () => {
  const rows = new Map(), stores = new Map();
  const db = { namespace: 'plugin_test',
    async execute(sql, args) {
      assert.match(sql, /ON CONFLICT \(company_id,pack_id,version\)/);
      const [id, version, companyId, document, source, digest] = args;
      const key = [companyId, id, version].join(':');
      if (!rows.has(key)) rows.set(key, { companyId, id, version, document, source, digest });
    },
    async query(sql, args) {
      if (sql.includes('SELECT document')) return [...rows.values()].filter(row => row.companyId === args[0]);
      if (sql.includes('SELECT digest')) return [...rows.values()].filter(row => row.companyId === args[0] && row.id === args[1] && row.version === args[2]);
      return [];
    },
  };
  const makeRegistry = () => createPackRegistry({ load: async () => [{ ...pack, id: 'adlc' }],
    loadImported: companyId => importedPacks(db, companyId),
    async prepareCompany(companyId, previous) {
      if (previous) return previous;
      const store = stores.get(companyId) ?? new MemoryStore(); stores.set(companyId, store);
      return { store, engine: new GraphEngine({ store }) };
    } });
  let registry = makeRegistry();
  const service = createGithubPacks({ db, registry });
  const candidate = (document, digest) => ({ pack: document, preview: { digest, source: {} } });
  const other = { ...pack, graphs: [{ ...pack.graphs[0], title: 'Company B' }] };
  await service.install('a', candidate(pack, 'a'));
  assert.deepEqual((await registry.forCompany('b')).pack.id, 'adlc');
  assert.deepEqual(registry.catalog('b').map(item => item.id), ['adlc']);
  await service.install('b', candidate(other, 'b'));
  assert.equal(registry.catalog('a').find(item => item.id === 'sample').graphs[0].title, undefined);
  assert.equal(registry.catalog('b').find(item => item.id === 'sample').graphs[0].title, 'Company B');
  await assert.rejects(service.install('a', candidate({ ...pack, id: 'adlc', version: '2.0.0' }, 'x')), /built-in/);
  await assert.rejects(service.install('a', candidate(other, 'b')), /changed without a version bump/);
  registry = makeRegistry();
  await registry.forCompany('a'); await registry.forCompany('b');
  assert.equal(registry.catalog('b').find(item => item.id === 'sample').graphs[0].title, 'Company B');
  assert.equal(registry.catalog('a').find(item => item.id === 'sample').graphs[0].title, undefined);
  assert.equal((await stores.get('a').read()).packs['sample@1.0.0'].graphs[0].title, undefined);
});
