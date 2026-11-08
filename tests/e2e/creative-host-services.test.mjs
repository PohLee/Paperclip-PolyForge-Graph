import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreativeHostServices } from '../../src/plugin/creative-host-services.mjs';

async function fixtureServer(handler) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const output = await handler({ request, input });
    response.writeHead(output.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(output.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('operator Creative gateway is probed and scoped service RPCs enforce tenant and deterministic artifact roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-creative-host-'));
  const artifactRoot = join(root, 'paperclip-volume', 'creative-artifacts');
  await mkdir(artifactRoot, { recursive: true });
  let seenToken = false;
  const fixture = await fixtureServer(async ({ request, input }) => {
    seenToken ||= request.headers.authorization === 'Bearer fixture-secret';
    if (request.url === '/v1/creative/capabilities') return { body: { protocol: 'polyforge-creative-host-v1',
      result: { services: ['resolveDecisionEvidence', 'getArtifactProvenance', 'loadExternalArtifact', 'hasImageProvider', 'decodeImage'],
        imageProviderIds: ['fixture-image'], imageDecoder: true } } };
    if (request.url === '/v1/creative/evidence/resolve') return { body: { protocol: 'polyforge-creative-host-v1',
      companyId: input.companyId, result: [{ kind: 'creative_brief', payload: { id: 'brief-1', version: '1' },
        sourceRef: { id: 'brief-1', version: '1' } }] } };
    if (request.url === '/v1/creative/artifacts/provenance') return { body: { protocol: 'polyforge-creative-host-v1',
      companyId: input.companyId, result: [{ id: 'owner', kind: 'human', roles: ['human-owner'], executionId: null }] } };
    if (request.url === '/v1/creative/artifacts/load') return { body: { protocol: 'polyforge-creative-host-v1',
      companyId: input.companyId, result: { id: input.ref.id, version: input.ref.version, kind: input.kind,
        digest: 'a'.repeat(64), payload: { id: input.ref.id, version: input.ref.version },
        artifactRoot: 'C:\\untrusted\\root', provenance: { sourceRunId: 'source-run' } } } };
    if (request.url === '/v1/creative/image-provider/check') return { body: { protocol: 'polyforge-creative-host-v1',
      companyId: input.companyId, result: { providerId: input.providerId, authorized: false, callable: false } } };
    if (request.url === '/v1/creative/image/decode') return { body: { protocol: 'polyforge-creative-host-v1',
      companyId: input.companyId, result: { mimeType: 'image/jpeg', width: 12, height: 8 } } };
    return { status: 404, body: { protocol: 'polyforge-creative-host-v1', error: 'unknown endpoint' } };
  });
  t.after(async () => {
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'polyforge.runtime.json'), JSON.stringify({ creativeHost: {
    artifactRoot, gatewayUrl: fixture.url, gatewayTokenEnv: 'POLYFORGE_CREATIVE_GATEWAY_TOKEN', timeoutMs: 1000,
    allowedImageProviderIds: ['fixture-image'],
  } }));
  const host = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_GATEWAY_TOKEN: 'fixture-secret' } });
  assert.equal(host.available, true);
  assert.deepEqual(host.capabilities, ['resolveDecisionEvidence', 'getArtifactProvenance', 'loadExternalArtifact', 'hasImageProvider', 'decodeImage', 'artifactRootForRun']);
  const scoped = host.forRun({ companyId: 'company-a', run: { id: 'run-1' } });
  assert.deepEqual(await scoped.resolveDecisionEvidence({ run: { id: 'run-1', graph: { id: 'creative-intake' } },
    node: { id: 'route-work' }, outcome: 'brief-ready', requiredKinds: ['creative_brief'] }), [
    { kind: 'creative_brief', payload: { id: 'brief-1', version: '1' }, sourceRef: { id: 'brief-1', version: '1' } },
  ]);
  assert.equal(await scoped.artifactRootForRun({ id: 'run-1' }), join(artifactRoot, 'company-a', 'run-1'));
  assert.deepEqual(await scoped.getArtifactProvenance({ id: 'selection-1', version: '1' }), [
    { id: 'owner', kind: 'human', roles: ['human-owner'], executionId: null },
  ]);
  const external = await scoped.loadExternalArtifact({ run: { id: 'run-1', graph: { id: 'creative-intake' } },
    ref: { id: 'artifact-1', version: '2' }, kind: 'concept_set', input: {} });
  assert.equal(external.artifactRoot, join(artifactRoot, 'company-a', 'source-run'));
  assert.notEqual(external.artifactRoot, 'C:\\untrusted\\root');
  assert.equal(await scoped.hasImageProvider('fixture-image'), false, 'provider must be explicitly authorized and callable for this company');
  assert.deepEqual(await scoped.decodeImage(new Uint8Array([1, 2, 3]), 'image/jpeg'), { mimeType: 'image/jpeg', width: 12, height: 8 });
  await assert.rejects(scoped.decodeImage(new Uint8Array([1]), 'image/webp'), /MIME differs/);
  assert.equal(seenToken, true);
  const wrongTenant = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_GATEWAY_TOKEN: 'fixture-secret' },
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/v1/creative/evidence/resolve')) {
        const body = await response.json();
        body.companyId = 'company-b';
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return response;
    } });
  await assert.rejects(wrongTenant.forRun({ companyId: 'company-a', run: { id: 'run-1' } })
    .resolveDecisionEvidence({ run: { id: 'run-1' }, node: { id: 'route-work' }, requiredKinds: [] }), /mismatched company scope/);
  const wrongProtocol = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_GATEWAY_TOKEN: 'fixture-secret' },
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/v1/creative/evidence/resolve')) return new Response(JSON.stringify({ protocol: 'unexpected',
        companyId: 'company-a', result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return response;
    } });
  await assert.rejects(wrongProtocol.forRun({ companyId: 'company-a', run: { id: 'run-1' } })
    .resolveDecisionEvidence({ run: { id: 'run-1' }, node: { id: 'route-work' }, requiredKinds: [] }), /unsupported protocol/);
  let redirectDenied = false;
  const redirect = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_GATEWAY_TOKEN: 'fixture-secret' },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/creative/capabilities')) return fetch(url, options);
      redirectDenied = options.redirect === 'error';
      return new Response(null, { status: 302, headers: { location: fixture.url + '/redirected' } });
    } });
  await assert.rejects(redirect.forRun({ companyId: 'company-a', run: { id: 'run-1' } })
    .resolveDecisionEvidence({ run: { id: 'run-1' }, node: { id: 'route-work' }, requiredKinds: [] }));
  assert.equal(redirectDenied, true);
});

test('missing or malformed Creative operator config degrades to a safe unavailable state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-creative-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = await createCreativeHostServices({ root });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /config is missing/);
  await writeFile(join(root, 'polyforge.runtime.json'), '{not-json');
  const malformed = await createCreativeHostServices({ root });
  assert.equal(malformed.available, false);
  assert.match(malformed.reason, /could not be parsed/);
  await writeFile(join(root, 'polyforge.runtime.json'), 'null');
  const nullConfig = await createCreativeHostServices({ root });
  assert.equal(nullConfig.available, false);
  assert.match(nullConfig.reason, /top-level object/);
});
