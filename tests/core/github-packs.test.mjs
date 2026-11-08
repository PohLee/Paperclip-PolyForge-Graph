import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubPacks, githubSource, mergeCatalogs, importedPacks } from '../../src/plugin/github-packs.mjs';
import { createPackRegistry } from '../../src/plugin/pack-registry.mjs';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';

const pack = { id: 'sample', version: '1.0.0', roles: { maker: { id: 'maker' } },
  graphs: [{ id: 'work', version: '1.0.0', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }], edges: [{ from: 'make', to: 'end' }] }] };
const commit = 'a'.repeat(40);
test('GitHub source accepts only repository-relative JSON and fixed GitHub hosts', () => {
  assert.deepEqual(githubSource({ repository: 'https://github.com/example/packs', ref: 'v1.0', path: 'packs/sample.json' }), { repository:'example/packs', ref:'v1.0', path:'packs/sample.json' });
  for (const source of [{ repository: 'https://evil.test/x/y' }, { path:'../pack.json' }, { path:'index.mjs' }, { ref:'../../secret' }]) {
    assert.throws(() => githubSource({repository:'example/packs',ref:'main',path:'pack.json',...source}));
  }
});
test('GitHub preview resolves a commit, validates content and persists an immutable release through restart', async () => {
  let row; const requests = [];
  const db = { namespace:'plugin_test', query: async sql => row ? [sql.includes('SELECT document') ? { document: row.document } : row] : [],
    execute: async (_sql,args) => { row ??= { document:args[3], digest:args[5] }; } };
  const prepareCompany = async () => { const store = new MemoryStore(); return { store, engine: new GraphEngine({ store }) }; };
  const load = async () => mergeCatalogs([{ ...pack, id:'local' }], await importedPacks(db));
  let registry = createPackRegistry({ load, prepareCompany });
  const service = createGithubPacks({ db, registry, fetcher: async (url, options) => {
    requests.push(url); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(url.includes('api.github.com') ? { sha:commit } : { pack }));
  } });
  const candidate = await service.preview({ repository:'example/packs',ref:'main',path:'pack.json' });
  assert.equal(candidate.preview.source.ref, commit);
  assert.match(requests[1], new RegExp(commit));
  await service.install('company-a',candidate);
  assert.equal(registry.catalog().length,2);
  registry = createPackRegistry({load,prepareCompany});
  assert.equal((await registry.installed()).find(p=>p.id==='sample').version,'1.0.0');
  await assert.rejects(registry.install('company-a',{...pack,roles:{}},async()=>{}), /changed without a version bump/);
  assert.throws(()=>mergeCatalogs([pack],[{...pack,roles:{}}]), /changed without a version bump/);
});
test('GitHub preview rejects malformed and oversized data without importing code', async () => {
  const input={repository:'example/packs',ref:commit,path:'pack.json'};
  for (const body of ['export const pack = {};', JSON.stringify({pack:{id:'broken'}}),
    JSON.stringify({ pack: { ...pack, version: 'not-semver' } }), ' '.repeat(5*1024*1024+1)]) {
    const service=createGithubPacks({db:{},registry:{},fetcher:async()=>new Response(body)});
    await assert.rejects(service.preview(input));
  }
});

test('a failed import persistence cannot register an executable company Pack', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store });
  const registry = createPackRegistry({ load: async () => [{ ...pack, id: 'local' }],
    prepareCompany: async () => ({ store, engine }) });
  await registry.forCompany('company-a');
  await assert.rejects(registry.install('company-a', pack, async () => { throw new Error('database unavailable'); }), /database unavailable/);
  assert.deepEqual(registry.catalog().map(item => item.id), ['local']);
  assert.equal((await store.read()).packs['sample@1.0.0'], undefined);
  await registry.install('company-a', pack, async () => {});
  assert.ok((await store.read()).packs['sample@1.0.0']);
});
