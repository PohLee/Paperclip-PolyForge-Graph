import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubAppAdapter } from '../../src/host/github-app.mjs';
import { createHostGitHubTransport, readGitHubBlob } from '../../src/plugin/github-http-transport.mjs';

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
});


test('rejects a followed redirect and a changed final URL from the host', async () => {
  for (const fields of [{ redirected: true }, { url: 'https://api.github.com/different' }]) {
    const transport = createHostGitHubTransport({ http: { async fetch() {
      return { status: 200, ...fields };
    } } });
    await assert.rejects(transport('https://api.github.com/probe'), { message: 'github-transport-redirect' });
  }
});

test('the verification adapter reads binary blobs and proves absence from a complete pinned tree', async () => {
  const head = 'b'.repeat(40), treeSha = 'c'.repeat(40);
  const knowledgeSha = 'd'.repeat(40), contractsSha = 'e'.repeat(40);
  const directory = (path, sha) => ({ path, sha, type: 'tree', mode: '040000' });
  const prefix = '/repositories/42';
  const paths = [];
  const tree = { sha: contractsSha, truncated: false,
    tree: [{ path: 'bytes.bin', type: 'blob', mode: '100644', sha: blobSha }] };
  const replies = new Map([
    [prefix + '/git/commits/' + head, { sha: head, tree: { sha: treeSha }, parents: [] }],
    [prefix + '/commits/heads/main', { sha: head }],
    [prefix + '/git/trees/' + treeSha, { sha: treeSha, truncated: false, tree: [directory('knowledge', knowledgeSha)] }],
    [prefix + '/git/trees/' + knowledgeSha, { sha: knowledgeSha, truncated: false, tree: [directory('contracts', contractsSha)] }],
    [prefix + '/git/trees/' + contractsSha + '?recursive=1', tree],
    [prefix + '/git/blobs/' + blobSha, blob],
  ]);
  const fetch = createHostGitHubTransport({ http: { async fetch(url) {
    const { pathname, search } = new URL(url);
    const path = pathname + search;
    paths.push(path);
    return replies.has(path) ? Response.json(replies.get(path)) : new Response(null, { status: 404 });
  } } });
  const makeAdapter = () => createGitHubAppAdapter({ fetch, githubRepositoryId: 42,
    installationTokenProvider: { withToken: (_scope, _method, send) => send('fixture') } });
  const adapter = makeAdapter();
  assert.equal(await adapter.mainSha(), head);
  assert.deepEqual(await adapter.readOptionalFile('knowledge/contracts/bytes.bin', head), bytes);
  assert.equal(await adapter.readOptionalFile('knowledge/contracts/missing.bin', head), null);
  assert.equal(paths.at(-1), prefix + '/git/blobs/' + blobSha);
  replies.delete(prefix + '/git/blobs/' + blobSha);
  await assert.rejects(adapter.readOptionalFile('knowledge/contracts/bytes.bin', head), { message: 'github-request-unavailable' });
  tree.tree[0].mode = '120000';
  await assert.rejects(makeAdapter().readOptionalFile('knowledge/contracts/bytes.bin', head), { code: 'contract-proposal-differs' });
  tree.truncated = true;
  await assert.rejects(makeAdapter().readOptionalFile('knowledge/contracts/missing.bin', head), { code: 'github-contract-tree-truncated' });
});
