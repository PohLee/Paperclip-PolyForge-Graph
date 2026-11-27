import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImplementationGitHubAdapter } from '../../src/host/implementation-github.mjs';

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeCommitSha = 'c'.repeat(40);
const input = { repository: 'org/repo', pullNumber: 3, runId: 'run', baseSha, headSha };

function fixture(firstParent = baseSha, patchFailure, failAncestry = false) {
  const receipts = new Map();
  let puts = 0;
  let prHead = headSha;
  let main = baseSha;
  let requestBase = baseSha;
  let prepared = mergeCommitSha;
  const adapter = createImplementationGitHubAdapter({
    receipts, getInstallationToken: async () => 'test',
    fetch: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer test');
      const path = new URL(url).pathname.split('/').slice(4).join('/');
      if (path === 'git/refs/heads/main') {
        if (options.method === 'PATCH') {
          assert.deepEqual(JSON.parse(options.body), { sha: prepared, force: false });
          if (patchFailure === 422) {
            main = 'd'.repeat(40);
            return Response.json({}, { status: 422 });
          }
          puts++;
          main = patchFailure === 503 ? 'e'.repeat(40) : prepared;
          if (patchFailure === 503) return Response.json({}, { status: 503 });
        }
        return Response.json({ object: { sha: main } });
      }
      if (path === 'pulls/3') return Response.json({
        state: 'open', merged: puts > 0, merge_commit_sha: prepared,
        base: { ref: 'main' }, head: { sha: prHead },
      });
      if (path.startsWith('compare/') && failAncestry) {
        failAncestry = false;

        return Response.json({}, { status: 503 });
      }
      if (path.startsWith('compare/')) return Response.json({
        merge_base_commit: { sha: patchFailure === 503 ? mergeCommitSha : baseSha },
      });
      if (path === 'git/refs') {
        assert.equal(options.method, 'POST');
        assert.match(JSON.parse(options.body).ref, /^refs\/heads\/polyforge-merge-/);
        assert.equal(JSON.parse(options.body).sha, requestBase);
        return Response.json({});
      }
      if (path === 'merges') {
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).head, prHead);
        return Response.json({ sha: prepared, parents: [{ sha: firstParent }, { sha: prHead }] });
      }
      assert.match(path, /^git\/refs\/heads\/polyforge-merge-/);
      assert.equal(options.method, 'DELETE');
      return new Response(null, { status: 204 });
    },
  });
  return { adapter, puts: () => puts, changeHead: () => { prHead = baseSha; }, freshRequest: () => {
    firstParent = requestBase = main;
    prHead = 'f'.repeat(40);
    prepared = '1'.repeat(40);
    patchFailure = undefined;
    return { ...input, baseSha: main, headSha: prHead, decisionId: 'fresh-decision' };
  } };
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


test('reads complete compare data and exact head bytes for implementation PRs', async () => {
  const requests = [];
  const repository = 'org/repo';
  const adapter = createImplementationGitHubAdapter({
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
  assert.ok(requests.includes('contents/new%20path.md?ref=' + headSha));
});

test('dependency assessment bails out on Bun and Go lockfile changes', async () => {
  const adapter = createImplementationGitHubAdapter({ installedValidator: {},
    fetch: () => assert.fail('Lockfile bailouts must not read the repository') });
  for (const path of ['app/bun.lockb', 'go.sum']) {
    assert.equal(await adapter.getDependencyChanges({ ...input, changes: [{ path, status: 'modified' }] }), null);
  }
});

test('reads check runs and commit statuses for the approved head', async () => {
  const names = [];
  const adapter = createImplementationGitHubAdapter({ getInstallationToken: async () => 'test',
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

test('re-reads the pull request after authorization', async () => {
  const { adapter, changeHead, puts } = fixture();
  await assert.rejects(adapter.merge(input, changeHead), /Pull request changed before merge/);
  assert.equal(puts(), 0);
  assert.equal(await adapter.getMergeReceipt(input), undefined);
});

test('discards a rejected fast-forward receipt when main excludes the prepared merge', async () => {
  const { adapter } = fixture(baseSha, 422);
  await assert.rejects(adapter.merge(input), /HTTP 422/);
  assert.equal(await adapter.getMergeReceipt(input), undefined);
});

test('reconciles an ambiguous patch when main descended from the prepared merge', async () => {
  const { adapter } = fixture(baseSha, 503);
  await assert.rejects(adapter.merge(input), /HTTP 503/);
  assert.equal((await adapter.getMergeReceipt(input)).mergeCommitSha, mergeCommitSha);
});

for (const readReceipt of [false, true]) {
  test(`a fresh decision recovers a rejected PATCH via ${readReceipt ? 'receipt read' : 'merge'}`, async () => {
    const { adapter, freshRequest } = fixture(baseSha, 422, true);
    await assert.rejects(adapter.merge({ ...input, decisionId: 'old-decision' }), /HTTP 503/);
    const fresh = freshRequest();
    if (readReceipt) assert.equal(await adapter.getMergeReceipt(fresh), undefined);
    assert.equal(await adapter.merge(fresh), '1'.repeat(40));
  });
}
