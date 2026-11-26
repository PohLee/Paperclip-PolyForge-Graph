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

