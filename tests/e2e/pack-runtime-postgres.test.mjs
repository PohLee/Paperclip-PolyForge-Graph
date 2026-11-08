import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recordPackRuntime, getPackRuntime } from '../../src/plugin/store.mjs';
import { createPostgresTemporaryAgentDatabase, postgresTemporaryAgentAvailable } from '../helpers/postgres-temporary-agent.mjs';

test('PostgreSQL Pack runtime binding is immutable, company-scoped and safe under competing inserts', {
  skip: !postgresTemporaryAgentAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const { db, sql, namespace, companyId, otherCompanyId } = await createPostgresTemporaryAgentDatabase(t);
  // Keep the foreign-key fixture in the disposable test schema, never public.companies.
  await sql.unsafe(`CREATE TABLE ${namespace}.companies (id uuid PRIMARY KEY)`);
  await sql.unsafe(`INSERT INTO ${namespace}.companies VALUES ($1), ($2)`, [companyId, otherCompanyId]);
  const migration = (await readFile(new URL('../../migrations/014_pack_runtime_binding.sql', import.meta.url), 'utf8'))
    .replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
    .replaceAll('public.companies', `${namespace}.companies`);
  await sql.unsafe(migration);
  const identity = { packId: 'adlc', packVersion: '0.3.2', packDigest: 'sha256:pack',
    adapterId: 'adlc-host-api', adapterVersion: '1', adapterBundleDigest: 'sha256:bundle' };
  assert.equal(await getPackRuntime(db, companyId, 'run'), null);
  const replays = await Promise.all(Array.from({ length: 8 }, () => recordPackRuntime(db, companyId, 'run', identity)));
  assert.ok(replays.every(value => JSON.stringify(value) === JSON.stringify(identity)));
  assert.deepEqual(await getPackRuntime(db, companyId, 'run'), identity);
  assert.equal(await getPackRuntime(db, otherCompanyId, 'run'), null);
  const changed = { ...identity, adapterBundleDigest: 'sha256:replacement' };
  await assert.rejects(recordPackRuntime(db, companyId, 'run', changed), /identity changed/);
  await recordPackRuntime(db, otherCompanyId, 'run', changed);
  assert.deepEqual(await getPackRuntime(db, companyId, 'run'), identity);
  assert.deepEqual(await getPackRuntime(db, otherCompanyId, 'run'), changed);
  const results = await Promise.allSettled([
    recordPackRuntime(db, companyId, 'race', identity),
    recordPackRuntime(db, companyId, 'race', changed),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const rows = await sql.unsafe(`SELECT * FROM ${namespace}.graph_pack_runtime WHERE graph_run_id='race'`);
  assert.equal(rows.length, 1);
});
