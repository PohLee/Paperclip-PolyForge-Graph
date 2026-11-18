import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreativeHostServices } from '../../src/plugin/creative-host-services.mjs';

test('Creative gateway uses an operator secret file without inherited Host environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-secret-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = join(root, 'gateway-token');
  await writeFile(secret, 'synthetic-private-token\n', { mode: 0o600 });
  await writeFile(join(root, 'polyforge.runtime.json'), JSON.stringify({ creativeHost: {
    artifactRoot: join(root, 'artifacts'), gatewayUrl: 'http://127.0.0.1:3218', gatewayTokenFile: secret,
  } }));
  let calls = 0;
  const services = await createCreativeHostServices({ root, env: {}, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.headers.authorization, 'Bearer synthetic-private-token');
    return new Response(JSON.stringify({ protocol: 'polyforge-creative-host-v1', result: {
      services: ['resolveDecisionEvidence'], imageProviderIds: [], imageDecoder: false,
    } }));
  } });
  assert.equal(calls, 1);
  assert.ok(services.capabilities.includes('resolveDecisionEvidence'));
  assert.equal(JSON.stringify(services).includes('synthetic-private-token'), false);
});

test('Creative secret file configuration fails closed without contacting the gateway', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-secret-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = join(root, 'gateway-token');
  await writeFile(secret, 'synthetic-private-token');
  for (const config of [
    { gatewayTokenFile: 'relative-secret' },
    { gatewayTokenFile: join(root, 'missing') },
    { gatewayTokenFile: secret, gatewayTokenEnv: 'POLYFORGE_CREATIVE_TOKEN' },
  ]) {
    await writeFile(join(root, 'polyforge.runtime.json'), JSON.stringify({ creativeHost: {
      artifactRoot: join(root, 'artifacts'), gatewayUrl: 'http://127.0.0.1:3218', ...config,
    } }));
    const result = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_TOKEN: 'other-token' },
      fetchImpl: () => { throw new Error('Must not contact gateway'); } });
    assert.equal(result.available, false);
    assert.deepEqual(result.capabilities, []);
  }
});
