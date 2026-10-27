import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/^postgres(?:ql)?:\/\//.test(dbUrl)) throw new Error('External PostgreSQL DATABASE_URL is required');
const home = process.env.PAPERCLIP_HOME || '/paperclip';
const instance = process.env.PAPERCLIP_INSTANCE_ID || 'default';
const path = join(home, 'instances', instance, 'config.json');
const config = {
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: 'configure' },
  database: { mode: 'postgres', connectionString: dbUrl },
  logging: { mode: 'file', logDir: join(home, 'instances', instance, 'logs') },
  server: { deploymentMode: 'authenticated', exposure: 'private', bind: 'lan', host: '0.0.0.0', port: 3100, serveUi: true },
  auth: { baseUrlMode: 'explicit', publicBaseUrl: 'http://localhost:3310', disableSignUp: false },
};
let previous;
try { previous = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  if (previous.database?.mode !== 'postgres' || previous.database?.connectionString !== dbUrl ||
      previous.server?.deploymentMode !== 'authenticated') throw new Error('Existing Paperclip config does not match isolated external database and authenticated mode');
  console.log('Existing external PostgreSQL Paperclip config retained.');
} else {
  await mkdir(join(home, 'instances', instance), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Created authenticated external PostgreSQL Paperclip config at ${path}.`);
}
