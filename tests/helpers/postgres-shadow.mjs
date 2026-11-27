import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphCoreReadTables, validatePluginRuntimeExecute, validatePluginRuntimeQuery } from './paperclip-sql-validator.mjs';

export const postgresShadowAvailable = process.env.POLYFORGE_RUN_POSTGRES_TESTS === '1';

/** Actual PostgreSQL, with the production launch migrations in a disposable schema. */
export async function createPostgresShadowDatabase(t, { full = false } = {}) {
  if (!postgresShadowAvailable) throw new Error('PostgreSQL Shadow tests require explicit opt-in');
  const modulePath = process.env.POLYFORGE_TEST_POSTGRES_MODULE;
  const connection = process.env.POLYFORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!modulePath || !isAbsolute(modulePath) || !connection) {
    throw new Error('Set an absolute POLYFORGE_TEST_POSTGRES_MODULE and a test database URL');
  }
  const { default: postgres } = await import(pathToFileURL(modulePath).href);
  function connect() {
    const client = postgres(connection, { max: 5, idle_timeout: 5, connect_timeout: 10,
      onnotice: () => {} });
    // Match Paperclip's Drizzle postgres-js JSON binding.
    client.options.serializers['114'] = value => value;
    client.options.serializers['3802'] = value => value;
    return client;
  }
  const sql = connect();
  const namespace = `plugin_shadow_test_${randomUUID().replaceAll('-', '')}`;
  // All schema identifiers are generated here, never read from configuration.
  if (!/^plugin_shadow_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid test schema');
  let created = false;
  t.after(async () => {
    try { if (created) await sql.unsafe(`DROP SCHEMA ${namespace} CASCADE`); }
    finally { await sql.end({ timeout: 5 }); }
  });
  await sql.unsafe(`CREATE SCHEMA ${namespace}`);
  created = true;
  await sql.unsafe(`CREATE TABLE ${namespace}.companies (id uuid PRIMARY KEY)`);
  const companyId = randomUUID(), otherCompanyId = randomUUID();
  await sql.unsafe(`INSERT INTO ${namespace}.companies (id) VALUES ($1),($2)`,
    [companyId, otherCompanyId]);
  const migrations = new URL('../../migrations/', import.meta.url);
  if (full) {
    await sql.unsafe(`CREATE TABLE ${namespace}.issues (id uuid PRIMARY KEY); CREATE TABLE ${namespace}.agents (id uuid PRIMARY KEY)`);
  }
  const names = full ? (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()
    : ['007_shadow_launch.sql', '008_shadow_recovery.sql', '020_adlc_merge_discovery.sql', '021_github_merge_journal.sql', '022_github_merge_recovery.sql'];
  for (const name of names) {
    const source = await readFile(new URL(name, migrations), 'utf8');
    // Preserve the real FK while keeping fixture companies out of host data.
    const migration = source.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll(/REFERENCES public\.(companies|issues|agents)\(id\)/g, `REFERENCES ${namespace}.$1(id)`);
    await sql.unsafe(migration);
  }
  const database = client => ({
    namespace,
    async query(statement, parameters = []) {
      validatePluginRuntimeQuery(statement, namespace, graphCoreReadTables);
      const rows = await client.unsafe(statement, parameters);
      // The SDK serializes timestamps as JSON before they reach the worker.
      return JSON.parse(JSON.stringify([...rows]));
    },
    async execute(statement, parameters = []) {
      validatePluginRuntimeExecute(statement, namespace);
      const result = await client.unsafe(statement, parameters);
      return { rowCount: result.count };
    },
  });
  function independentDatabase() {
    const client = connect();
    t.after(() => client.end({ timeout: 5 }));
    return database(client);
  }
  return { db: database(sql), sql, namespace, companyId, otherCompanyId, independentDatabase };
}
