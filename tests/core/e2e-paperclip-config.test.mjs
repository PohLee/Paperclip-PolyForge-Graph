import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../scripts/write-e2e-paperclip-config.mjs', import.meta.url));
const database = { mode: 'postgres', connectionString: 'postgres://fixture:synthetic@localhost/fixture' };

test('Docker config pins the no-config local key location and preserves operator choices', async t => {
  const home = await mkdtemp(join(tmpdir(), 'polyforge-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const instance = 'isolated-fixture';
  const directory = join(home, 'instances', instance);
  const configPath = join(directory, 'config.json');
  const keyFilePath = join(directory, 'secrets', 'master.key');
  const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: database.connectionString, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: instance } });
  const load = async () => JSON.parse(await readFile(configPath, 'utf8'));
  run();
  assert.equal((await load()).secrets.localEncrypted.keyFilePath, keyFilePath);
  await assert.rejects(readFile(keyFilePath), { code: 'ENOENT' }, 'helper must not create or read key material');
  const legacy = { database, server: { deploymentMode: 'authenticated', port: 9999 },
    auth: { publicBaseUrl: 'http://operator.example.invalid' }, extension: { retain: true } };
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, JSON.stringify(legacy));
  run();
  assert.deepEqual(await load(), { ...legacy, secrets: { localEncrypted: { keyFilePath } } });
  const upgraded = await readFile(configPath, 'utf8');
  run();
  assert.equal(await readFile(configPath, 'utf8'), upgraded, 'repeat invocation must preserve the config');

  await writeFile(configPath, JSON.stringify({ ...legacy, secrets: { provider: 'local_encrypted', strictMode: false } }));
  run();
  assert.deepEqual((await load()).secrets, { provider: 'local_encrypted', strictMode: false, localEncrypted: { keyFilePath } });

  for (const secrets of [
    { localEncrypted: { keyFilePath: '/operator/secrets/key' }, strictMode: false },
    { provider: 'operator-provider', providerOptions: { retain: true } },
  ]) {
    const explicit = { ...legacy, secrets };
    const bytes = JSON.stringify(explicit);
    await writeFile(configPath, bytes);
    run();
    assert.equal(await readFile(configPath, 'utf8'), bytes, 'explicit provider/path must remain untouched');
  }
});
