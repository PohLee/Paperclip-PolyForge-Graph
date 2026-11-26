import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAppAdapter } from '../../src/host/github-app.mjs';

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeCommitSha = 'c'.repeat(40);
const input = { repository: 'org/repo', pullNumber: 3, runId: 'run', baseSha, headSha };

function fixture(firstParent = baseSha) {
  const receipts = new Map();
  let puts = 0;
  const adapter = createGitHubAppAdapter({
    receipts, getInstallationToken: async () => 'test',
    fetch: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer test');
      const path = new URL(url).pathname.split('/').slice(4).join('/');
      if (path === 'git/refs/heads/main') return Response.json({ object: { sha: baseSha } });
      if (path === 'pulls/3') return Response.json({
        state: 'open', merged: puts > 0, merge_commit_sha: mergeCommitSha,
        base: { ref: 'main' }, head: { sha: headSha },
      });
      if (path === 'pulls/3/merge') {
        assert.equal(options.method, 'PUT');
        assert.deepEqual(JSON.parse(options.body), { sha: headSha, merge_method: 'merge' });
        puts++;
        return Response.json({ merged: true, sha: mergeCommitSha });
      }
      assert.equal(path, 'git/commits/' + mergeCommitSha);
      return Response.json({ parents: [{ sha: firstParent }, { sha: headSha }] });
    },
  });
  return { adapter, puts: () => puts };
}

test('serializes identical merge requests and recovers the verified receipt', async () => {
  const { adapter, puts } = fixture();
  assert.deepEqual(await Promise.all([adapter.merge(input), adapter.merge(input)]), [mergeCommitSha, mergeCommitSha]);
  assert.equal((await adapter.getMergeReceipt(input)).mergeCommitSha, mergeCommitSha);
  assert.equal(puts(), 1);
});

test('journals a changed base and refuses to recover it as a successful merge', async () => {
  const { adapter, puts } = fixture('d'.repeat(40));
  await assert.rejects(adapter.merge(input), /parents differ/);
  await assert.rejects(adapter.getMergeReceipt(input), /parents differ/);
  assert.equal(puts(), 1);
});


test('reads complete compare data and exact head bytes while the installed validator reads pinned main data', async () => {
  const requests = [];
  const repository = 'org/repo';
  const adapter = createGitHubAppAdapter({
    receipts: new Map(),
    getInstallationToken: async () => 'test',
    installedValidator: { recompute: async (_input, data) => (await data.readFile('project.json')).toString() },
    fetch: async url => {
      const parsed = new URL(url);
      const path = parsed.pathname.split('/').slice(4).join('/');
      requests.push(path + parsed.search);
      if (path === 'pulls/3') return Response.json({
        state: 'open', base: { sha: baseSha, ref: 'main', repo: { full_name: repository } },
        head: { sha: headSha }, changed_files: 1, user: { login: 'author' },
      });
      if (path === 'compare/' + baseSha + '...' + headSha) {
        return Response.json({ merge_base_commit: { sha: baseSha }, files: [{ filename: 'new path.md', status: 'added' }] });
      }
      if (path === 'git/trees/' + headSha) return Response.json({
        tree: [{ path: 'new path.md', type: 'blob', mode: '100644' }],
      });
      if (path === 'contents/new%20path.md') return new Response('head bytes');
      assert.equal(path, 'contents/project.json');
      return new Response('main config');
    },
  });
  const snapshot = await adapter.getPullSnapshot({ repository, pullNumber: 3, baseSha });
  assert.equal(snapshot.changes[0].mode, '100644');
  assert.equal(snapshot.changes[0].bytes.toString(), 'head bytes');
  const validator = adapter.loadValidator({ repository, ref: baseSha });
  assert.equal(await validator.recompute({ repository, baseSha }), 'main config');
  assert.ok(requests.includes('contents/new%20path.md?ref=' + headSha));
  assert.ok(requests.includes('contents/project.json?ref=' + baseSha));
});
