import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/^postgres(?:ql)?:\/\//.test(dbUrl)) throw new Error('External PostgreSQL DATABASE_URL is required');
const home = process.env.PAPERCLIP_HOME || '/paperclip';
const instance = process.env.PAPERCLIP_INSTANCE_ID || 'default';
const path = join(home, 'instances', instance, 'config.json');
// The pinned Host's schema default is relative to HOME/.paperclip, whereas
// its no-config startup creates the key directly under PAPERCLIP_HOME.
const keyFilePath = join(home, 'instances', instance, 'secrets', 'master.key');
const config = {
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: 'configure' },
  database: { mode: 'postgres', connectionString: dbUrl },
  logging: { mode: 'file', logDir: join(home, 'instances', instance, 'logs') },
  server: { deploymentMode: 'authenticated', exposure: 'private', bind: 'lan', host: '0.0.0.0', port: 3100, serveUi: true },
  auth: { baseUrlMode: 'explicit', publicBaseUrl: process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || 'http://localhost:3310', disableSignUp: false },
  secrets: { localEncrypted: { keyFilePath } },
};
let previous;
try { previous = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  if (previous.database?.mode !== 'postgres' || previous.database?.connectionString !== dbUrl ||
      previous.server?.deploymentMode !== 'authenticated') throw new Error('Existing Paperclip config does not match isolated external database and authenticated mode');
  const secrets = previous.secrets;
  if ((secrets?.provider === undefined || secrets.provider === 'local_encrypted') &&
      secrets?.localEncrypted?.keyFilePath === undefined) {
    previous.secrets = { ...secrets, localEncrypted: { ...secrets?.localEncrypted, keyFilePath } };
    await writeFile(path, JSON.stringify(previous, null, 2) + '\n', { mode: 0o600 });
    console.log('Existing external PostgreSQL Paperclip config now pins its local secrets key path.');
  } else console.log('Existing external PostgreSQL Paperclip config retained.');
} else {
  await mkdir(join(home, 'instances', instance), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Created authenticated external PostgreSQL Paperclip config at ${path}.`);
}
