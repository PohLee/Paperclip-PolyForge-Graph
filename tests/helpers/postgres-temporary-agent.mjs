import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const postgresTemporaryAgentAvailable = process.env.POLYFORGE_RUN_POSTGRES_TESTS === '1';

export async function createPostgresTemporaryAgentDatabase(t) {
  if (!postgresTemporaryAgentAvailable) throw new Error('PostgreSQL tests require explicit opt-in');
  const modulePath = process.env.POLYFORGE_TEST_POSTGRES_MODULE;
  const connection = process.env.POLYFORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!modulePath || !isAbsolute(modulePath) || !connection) {
    throw new Error('Set an absolute POLYFORGE_TEST_POSTGRES_MODULE and test database URL');
  }
  const { default: postgres } = await import(pathToFileURL(modulePath).href);
  const sql = postgres(connection, { max: 5, idle_timeout: 5, connect_timeout: 10,
    onnotice: () => {} });
  sql.options.serializers['114'] = (value) => value;
  sql.options.serializers['3802'] = (value) => value;
  const namespace = `plugin_temporary_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^plugin_temporary_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid test schema');
  let created = false;
  t.after(async () => {
    try { if (created) await sql.unsafe(`DROP SCHEMA ${namespace} CASCADE`); }
    finally { await sql.end({ timeout: 5 }); }
  });
  await sql.unsafe(`CREATE SCHEMA ${namespace}`);
  created = true;
  const migration = (await readFile(new URL('../../migrations/009_temporary_agent_launch.sql',
    import.meta.url), 'utf8')).replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace);
  await sql.unsafe(migration);
  const db = {
    namespace,
    async query(statement, parameters = []) {
      const rows = await sql.unsafe(statement, parameters);
      return JSON.parse(JSON.stringify([...rows]));
    },
    async execute(statement, parameters = []) {
      const result = await sql.unsafe(statement, parameters);
      return { rowCount: result.count };
    },
  };
  return { db, sql, namespace, companyId: randomUUID(), otherCompanyId: randomUUID() };
}
