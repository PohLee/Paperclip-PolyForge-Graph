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
      if (path === 'git/refs/heads/main') {
        if (options.method === 'PATCH') {
          assert.deepEqual(JSON.parse(options.body), { sha: mergeCommitSha, force: false });
          puts++;
        }
        return Response.json({ object: { sha: puts ? mergeCommitSha : baseSha } });
      }
      if (path === 'pulls/3') return Response.json({
        state: 'open', merged: puts > 0, merge_commit_sha: mergeCommitSha,
        base: { ref: 'main' }, head: { sha: headSha },
      });
      if (path === 'git/refs') {
        assert.equal(options.method, 'POST');
        assert.match(JSON.parse(options.body).ref, /^refs\/heads\/polyforge-merge-/);
        assert.equal(JSON.parse(options.body).sha, baseSha);
        return Response.json({});
      }
      if (path === 'merges') {
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).head, headSha);
        return Response.json({ sha: mergeCommitSha, parents: [{ sha: firstParent }, { sha: headSha }] });
      }
      assert.match(path, /^git\/refs\/heads\/polyforge-merge-/);
      assert.equal(options.method, 'DELETE');
      return new Response(null, { status: 204 });
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

test('refuses to advance main when the temporary merge parents differ', async () => {
  const { adapter, puts } = fixture('d'.repeat(40));
  await assert.rejects(adapter.merge(input), /parents differ/);
  assert.equal(await adapter.getMergeReceipt(input), undefined);
  assert.equal(puts(), 0);
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

test('dependency assessment bails out on Bun and Go lockfile changes', async () => {
  const adapter = createGitHubAppAdapter({ installedValidator: {},
    fetch: () => assert.fail('Lockfile bailouts must not read the repository') });
  for (const path of ['app/bun.lockb', 'go.sum']) {
    assert.equal(await adapter.getDependencyChanges({ ...input, changes: [{ path, status: 'modified' }] }), null);
  }
});

test('reads check runs and commit statuses for the approved head', async () => {
  const names = [];
  const adapter = createGitHubAppAdapter({ getInstallationToken: async () => 'test',
    fetch: async url => {
      const { pathname } = new URL(url);
      assert.ok(pathname.includes('/commits/' + headSha + '/'));
      const endpoint = pathname.split('/').at(-1);
      names.push(endpoint);
      if (endpoint === 'check-runs') return Response.json({ total_count: 1, check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
      ] });
      return Response.json({ total_count: 1, statuses: [{ context: 'deploy', state: 'pending' }] });
    },
  });
  assert.deepEqual(await adapter.getCheckStatus({ repository: input.repository, sha: headSha }), [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'deploy', status: 'in_progress', conclusion: null },
  ]);
  assert.deepEqual(names.sort(), ['check-runs', 'status']);
});
