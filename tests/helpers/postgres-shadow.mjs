import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const postgresShadowAvailable = process.env.POLYFORGE_RUN_POSTGRES_TESTS === '1';

/** Actual PostgreSQL, with the production launch migrations in a disposable schema. */
export async function createPostgresShadowDatabase(t) {
  if (!postgresShadowAvailable) throw new Error('PostgreSQL Shadow tests require explicit opt-in');
  const modulePath = process.env.POLYFORGE_TEST_POSTGRES_MODULE;
  const connection = process.env.POLYFORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!modulePath || !isAbsolute(modulePath) || !connection) {
    throw new Error('Set an absolute POLYFORGE_TEST_POSTGRES_MODULE and a test database URL');
  }
  const { default: postgres } = await import(pathToFileURL(modulePath).href);
  const sql = postgres(connection, { max: 5, idle_timeout: 5, connect_timeout: 10,
    onnotice: () => {} });
  // Paperclip's Drizzle postgres-js adapter passes serialized JSON through.
  // Match that binding: default postgres-js would stringify these strings again.
  sql.options.serializers['114'] = (value) => value;
  sql.options.serializers['3802'] = (value) => value;
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
  for (const name of ['007_shadow_launch.sql', '008_shadow_recovery.sql']) {
    const source = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    // Preserve the real FK while keeping fixture companies out of host data.
    const migration = source.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll('REFERENCES public.companies(id)', `REFERENCES ${namespace}.companies(id)`);
    await sql.unsafe(migration);
  }
  const db = {
    namespace,
    async query(statement, parameters = []) {
      const rows = await sql.unsafe(statement, parameters);
      // The SDK serializes timestamps as JSON before they reach the worker.
      return JSON.parse(JSON.stringify([...rows]));
    },
    async execute(statement, parameters = []) {
      const result = await sql.unsafe(statement, parameters);
      return { rowCount: result.count };
    },
  };
  return { db, sql, namespace, companyId, otherCompanyId };
}
