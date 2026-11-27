import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { createInstallationTokenProvider, githubReadPermissions, githubWritePermissions } from '../../src/plugin/github-installation-token.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import plugin from '../../src/plugin/worker.mjs';
import { validatePluginRuntimeQuery } from '../helpers/paperclip-sql-validator.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const app = { appId: 123, installationId: 456,
  privateKeyRef: { type: 'secret_ref', secretId: 'bc892aaa-53ae-42e3-aba5-fc3fa8556dec' } };
const companyId = 'company';
const repositoryId = 789;
const sentinel = 'credential-must-never-be-logged';

function fixture() {
  let time = Date.parse('2026-11-01T00:00:00.000Z');
  const calls = [], resolves = [], logs = [];
  const h = { calls, resolves, logs, advance: ms => { time += ms; } };
  const host = {
    secrets: { async resolve(ref, context) { resolves.push({ ref, context }); return pem; } },
    http: { async fetch(url, options) {
      calls.push({ url, options });
      const scope = JSON.parse(options.body);
      const result = { token: sentinel + '-' + calls.length, expires_at: new Date(time + 120_000).toISOString(),
        permissions: { ...scope.permissions, metadata: 'read' }, repositories: [{ id: scope.repository_ids[0] }],
        ignored: pem };
      return h.respond ? h.respond(result) : Response.json(result);
    } },
    logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  };
  h.provider = createInstallationTokenProvider({ host, companyId, app, now: () => time });
  return h;
}

test('signs a scoped App JWT and deduplicates concurrent mints by sorted permission and repository', async () => {
  const h = fixture();
  const [a, b] = await Promise.all([
    h.provider.getToken({ repositoryId }),
    h.provider.getToken({ repositoryId, permissions: { statuses: 'read', checks: 'read', pull_requests: 'read', contents: 'write' } }),
  ]);
  assert.equal(a, b);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.resolves, [{ ref: app.privateKeyRef, context: { companyId, configPath: 'githubApp.privateKeyRef' } }]);
  const [{ url, options }] = h.calls;
  assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { repository_ids: [repositoryId], permissions: githubWritePermissions });
  const [header, payload, signature] = options.headers.authorization.split(' ')[1].split('.');
  const decode = value => JSON.parse(Buffer.from(value, 'base64url'));
  const seconds = Date.parse('2026-11-01T00:00:00Z') / 1000;
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(payload), { iat: seconds - 60, exp: seconds + 480, iss: '123' });
  assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')));
  assert.notEqual(await h.provider.getToken({ repositoryId: 788 }), a);
  assert.notEqual(await h.provider.getToken({ repositoryId, permissions: githubReadPermissions }), a);
  h.advance(60_001);
  assert.notEqual(await h.provider.getToken({ repositoryId }), a);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.logs, []);
});

test('evicts on 401, retries an explicit read once, and sends each write only once', async () => {
  const h = fixture();
  const tokens = [];
  const unauthorized = token => { tokens.push(token); return new Response(sentinel, { status: 401 }); };
  assert.equal((await h.provider.withToken({ repositoryId }, 'GET', unauthorized)).status, 401);
  assert.equal((await h.provider.withToken({ repositoryId }, 'PATCH', unauthorized)).status, 401);
  assert.equal(tokens.length, 3);
  assert.equal(new Set(tokens).size, 3);
  let writes = 0;
  await assert.rejects(h.provider.withToken({ repositoryId }, 'POST', async () => {
    writes++;
    throw new Error(pem + sentinel);
  }), { message: 'github-token-transport-failed' });
  assert.equal(writes, 1);
  assert.deepEqual(h.logs, []);
});

test('rejects broad tokens and discards a mint that completes after the scope changes', async () => {
  const h = fixture();
  h.respond = body => Response.json({ ...body, repository_selection: 'all' });
  await assert.rejects(h.provider.getToken({ repositoryId }), { message: 'github-token-invalid-response' });
  h.respond = body => Response.json({ ...body, permissions: { ...body.permissions, issues: 'write' } });
  await assert.rejects(h.provider.getToken({ repositoryId }), { message: 'github-token-invalid-response' });
  h.respond = () => new Response(sentinel + pem, { status: 403 });
  await assert.rejects(h.provider.getToken({ repositoryId }), { message: 'github-token-mint-rejected' });

  let finish;
  const responsePending = new Promise(resolve => { finish = resolve; });
  let started;
  const mintStarted = new Promise(resolve => { started = resolve; });
  h.respond = async body => { started(); await responsePending; return Response.json(body); };
  const stale = h.provider.getToken({ repositoryId });
  const rejected = assert.rejects(stale, { message: 'github-token-invalidated' });
  await mintStarted;
  h.provider.updateApp({ ...app, privateKeyRef: { ...app.privateKeyRef, version: 2 } });
  finish();
  await rejected;
  h.respond = undefined;
  await h.provider.getToken({ repositoryId });
  assert.equal(h.resolves.at(-1).ref.version, 2);
  h.provider.invalidate({ repositoryId });
  await h.provider.getToken({ repositoryId });
  assert.equal(h.calls.length, 6);
  assert.deepEqual(h.logs, []);
});

test('config validation defaults gates off and rejects unsafe bindings without exposing secret refs', async () => {
  const { instanceConfigSchema, jobs } = manifest;
  const { githubApp, adlcProjects } = instanceConfigSchema.properties;
  assert.equal(githubApp.properties.privateKeyRef.format, 'secret-ref');
  for (const gate of ['g2', 'g4', 'g3']) {
    assert.equal(adlcProjects.additionalProperties.properties.contractPublication.properties[gate].default, false);
  }
  assert.ok(!jobs.some(job => job.jobKey === 'adlc-contract-publish'));
  assert.deepEqual(await plugin.definition.onValidateConfig({}), { ok: true });
  const config = { githubApp: { ...app, privateKeyRef: { ...app.privateKeyRef, value: pem } },
    adlcProjects: { project: { repository: 'owner/repo', contractPublication: { g2: true } } } };
  const result = await plugin.definition.onValidateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('github-publication-binding-incomplete'));
  assert.ok(!JSON.stringify(result).includes(app.privateKeyRef.secretId));
});

test('worker config validation uses the registered repository binding after setup', async t => {
  const namespace = 'plugin_polyforge_graph_ff7d84e8bb';
  const config = { githubApp: app, adlcProjects: { project: { repository: 'owner/repo', githubRepositoryId: repositoryId,
    contractPublication: { g2: true, validatorId: 'fixture', contractIdPrefix: 'PRD-' } } } };
  const binding = { app_id: BigInt(app.appId), installation_id: BigInt(app.installationId) };
  let queryResult = binding;
  const db = { namespace, query: t.mock.fn(async (sql, params) => {
    validatePluginRuntimeQuery(sql, namespace);
    assert.match(sql, /\.github_merge_journal WHERE repository_id=\$1$/);
    assert.deepEqual(params, [String(repositoryId)]);
    if (queryResult instanceof Error) throw queryResult;
    return [queryResult];
  }) };
  const get = t.mock.fn(() => { throw new Error('Company scope required'); });
  await plugin.definition.setup({ manifest, db, config: { get },
    logger: { warn() {} }, actions: { register() {} }, tools: { register() {} },
    events: { on() {} }, jobs: { register() {} } });

  await t.test('accepts the same app and installation', async () => {
    assert.deepEqual(await plugin.definition.onValidateConfig(config), { ok: true });
  });
  await t.test('rejects a different app or installation', async () => {
    for (const diff of [{ app_id: 99n }, { installation_id: 99n }]) {
      queryResult = { ...binding, ...diff };
      assert.deepEqual(await plugin.definition.onValidateConfig(config),
        { ok: false, errors: ['github-publication-binding-conflict'] });
    }
  });
  await t.test('reports an unavailable binding check when the DB fails', async () => {
    queryResult = new Error(sentinel);
    assert.deepEqual(await plugin.definition.onValidateConfig(config),
      { ok: false, errors: ['github-publication-binding-check-unavailable'] });
  });
  await t.test('rejects null and non-object config', async () => {
    for (const invalid of [null, 42, 'invalid', [], undefined]) {
      assert.deepEqual(await plugin.definition.onValidateConfig(invalid),
        { ok: false, errors: ['github-config-invalid'] });
    }
  });
  assert.equal(db.query.mock.callCount(), 4);
  assert.equal(get.mock.callCount(), 0);
});
