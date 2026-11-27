import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubAppAdapter } from '../../src/host/github-app.mjs';
import { createHostGitHubTransport, githubHostTransportReadiness, readGitHubBlob } from '../../src/plugin/github-http-transport.mjs';

const bytes = Buffer.from([0, 255, 128, 13, 10]);
const blobSha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const blob = { sha: blobSha, encoding: 'base64', size: bytes.length, content: 'AP+A\r\nDQo=\n' };

test('validates binary JSON blobs by canonical base64, decoded length and Git hash', async () => {
  assert.deepEqual(await readGitHubBlob(Response.json(blob), blobSha), bytes);
  for (const [patch, code] of [
    [{ content: 'AP*ADQo=' }, 'invalid-base64'],
    [{ content: 'AP+ADQp=' }, 'invalid-base64'],
    [{ size: 6 }, 'size-mismatch'],
    [{ size: 3 * 2 ** 20 }, 'invalid-metadata'],
    [{ content: 'AP+ADQs=' }, 'hash-mismatch'],
    [{ sha: 'a'.repeat(40) }, 'invalid-metadata'],
    [{ encoding: 'utf-8' }, 'invalid-metadata'],
  ]) {
    await assert.rejects(readGitHubBlob(Response.json({ ...blob, ...patch }), blobSha), { message: 'github-blob-' + code });
  }
});

test('restricts the host call to GitHub HTTPS and never follows a redirect', async () => {
  const requests = [];
  const transport = createHostGitHubTransport({ http: { async fetch(url, init) {
    requests.push({ url, init });
    return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.invalid/steal' } });
  } } });
  for (const url of ['http://api.github.com/invalid', 'https://api.github.com.evil.invalid/',
    'https://username:password@api.github.com/', 'https://api.github.com:444/']) {
    await assert.rejects(transport(url), { message: 'github-transport-invalid-url' });
  }
  await assert.rejects(transport('https://api.github.com/probe', {
    headers: { authorization: 'Bearer synthetic', 'User-Agent': 'caller-supplied' },
  }),
    { message: 'github-transport-redirect' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].init.headers, {
    authorization: 'Bearer synthetic', 'user-agent': 'polyforge-graph',
  });
  assert.deepEqual(githubHostTransportReadiness({ trusted: true }),
    { ready: false, state: 'blocked-config', reason: 'transport-redirect-unsafe' });
});

test('accepts an empty 204 response or emits a fixed diagnostic for the paired SDK throw', async () => {
  const transport = createHostGitHubTransport({ http: { async fetch() {
    return new Response(null, { status: 204 });
  } } });
  assert.equal((await transport('https://api.github.com/probe', { method: 'DELETE' })).status, 204);
  const paired = createHostGitHubTransport({ http: { async fetch() {
    throw new TypeError('sdk error with secret bearer');
  } } });
  await assert.rejects(paired('https://api.github.com/probe', { method: 'DELETE' }),
    { message: 'github-transport-request-failed' });
});

test('the durable adapter requires an explicit transport before binding the writer or acquiring a token', t => {
  const platformFetch = t.mock.method(globalThis, 'fetch');
  const getInstallationToken = t.mock.fn();
  const durableWriter = t.mock.fn();
  assert.throws(() => createGitHubAppAdapter({ getInstallationToken, durableWriter }),
    { message: 'github-durable-transport-required' });
  assert.equal(platformFetch.mock.callCount(), 0);
  assert.equal(getInstallationToken.mock.callCount(), 0);
  assert.equal(durableWriter.mock.callCount(), 0);
});

test('the durable adapter preserves binary blobs and distinguishes missing and invalid pinned entries', async () => {
  const repository = 'octo/demo';
  const baseSha = 'a'.repeat(40), head = 'b'.repeat(40);
  const repo = { id: 42, full_name: repository, node_id: 'stable' };
  const paths = [];
  const replies = new Map([
    ['', repo],
    ['/pulls/1', { head: { sha: head }, base: { sha: baseSha, ref: 'main', repo },
      state: 'open', user: { login: 'fixture-author' }, changed_files: 1 }],
    ['/compare/' + baseSha + '...' + head, { merge_base_commit: { sha: baseSha },
      files: [{ filename: 'bytes.bin', status: 'added' }] }],
    ['/git/trees/' + head, { truncated: false, tree: [{ path: 'bytes.bin', type: 'blob', mode: '100644', sha: blobSha }] }],
    ['/git/blobs/' + blobSha, blob],
  ]);
  const fetch = createHostGitHubTransport({ http: { async fetch(url) {
    const path = new URL(url).pathname.slice(('/repos/' + repository).length);
    paths.push(path);
    assert.ok(replies.has(path));
    const response = Response.json(replies.get(path));
    response.arrayBuffer = () => assert.fail('SDK bytes must use JSON base64');
    return response;
  } } });
  const createAdapter = () => createGitHubAppAdapter({ fetch, githubRepositoryId: 42,
    getInstallationToken: async () => 'fixture', durableWriter: () => ({}),
    installedValidator: { recompute: ({ path }, { readFile }) => readFile(path) } });
  const adapter = createAdapter();
  const pr = await adapter.getPullSnapshot({ repository, pullNumber: 1, baseSha });
  assert.deepEqual(pr.changes[0].bytes, bytes);
  assert.equal(paths.at(-1), '/git/blobs/' + blobSha);
  replies.get('/git/trees/' + head).tree[0].mode = '120000';
  assert.deepEqual((await adapter.getPullSnapshot({ repository, pullNumber: 1, baseSha })).changes[0].bytes, bytes);
  assert.equal(paths.filter(path => path === '/git/trees/' + head).length, 1);
  const fresh = createAdapter();
  assert.equal((await fresh.getPullSnapshot({ repository, pullNumber: 1, baseSha })).changes[0].bytes, undefined);
  const validator = fresh.loadValidator({ repository, ref: head });
  await assert.rejects(validator.recompute({ repository, baseSha: head, path: 'missing.bin' }),
    { message: 'github-pinned-blob-unavailable', status: 404 });
  await assert.rejects(validator.recompute({ repository, baseSha: head, path: 'bytes.bin' }),
    error => error.message === 'github-pinned-blob-unavailable' && error.status === undefined);
  assert.equal(paths.filter(path => path.startsWith('/git/blobs/')).length, 2);
  replies.get('/git/trees/' + head).truncated = true;
  await assert.rejects(createAdapter().getPullSnapshot({ repository, pullNumber: 1, baseSha }), /truncated Git tree/);
});
