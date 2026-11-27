import assert from 'node:assert/strict';
import { createGitHubAppAdapter } from '../../src/host/github-app.mjs';
import { createGitHubJournalMerge } from '../../src/host/github-journal-merge.mjs';

export const base = 'a'.repeat(40);
export const head = 'b'.repeat(40);
export const commit = 'c'.repeat(40);
export const descendant = 'd'.repeat(40);
export const secret = 'Bearer fixture-secret-never-store';
export const repository = 'octo/demo';
export const nodeId = 'R_fixture';
export const repoId = 101;

export function request(overrides = {}) {
  return { repository, runId: 'run', pullNumber: 42, section: 'product', decisionId: 'decision',
    manifestId: 'manifest', revisionId: 'rev', manifestDigest: '9'.repeat(64), baseSha: base, headSha: head,
    contractId: 'PRD-1', supersedes: null, mode: 'manual', ...overrides };
}

export function scope(companyId, overrides = {}) {
  return { repository, repositoryId: repoId, appId: 10, installationId: 20, companyId, projectId: 'project',
    runId: 'run', nodeId: 'publisher', attemptIndex: 1, kind: 'contract_publication_request',
    fingerprint: '8'.repeat(64), ...overrides };
}

export function signal() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release };
}

export function fakeGitHub() {
  const calls = [];
  const refs = new Map();
  const github = { main: base, calls, refs, before: undefined, after: undefined, patchStatus: undefined };
  github.fetch = async (url, { method, headers, body }) => {
    assert.equal(headers.authorization, 'Bearer ' + secret);
    const tail = new URL(url).pathname.slice(('/repos/' + repository).length);
    calls.push({ method, tail });
    await github.before?.(method, tail);
    const data = body && JSON.parse(body);
    let result;
    if (!tail) result = { id: repoId, node_id: nodeId, full_name: repository, ignored: secret };
    else if (tail.startsWith('/pulls/')) result = { state: 'open', head: { sha: head },
      base: { ref: 'main', sha: github.main, repo: { id: repoId, full_name: repository } } };
    else if (tail === '/git/refs/heads/main') {
      if (method === 'GET') result = { object: { sha: github.main } };
      else {
        assert.deepEqual(data, { sha: commit, force: false });
        if (github.patchStatus) return new Response(secret, { status: github.patchStatus });
        github.main = commit;
        result = { object: { sha: commit }, ignored: secret };
      }
    } else if (tail === '/git/refs') {
      assert.match(data.ref, /^refs\/heads\/polyforge-merge-/);
      assert.equal(data.sha, github.main);
      refs.set(data.ref, data.sha);
      result = { object: { sha: data.sha } };
    } else if (tail === '/merges') {
      const ref = 'refs/heads/' + data.base;
      assert.equal(refs.get(ref), github.main);
      assert.equal(data.head, head);
      refs.set(ref, commit);
      result = { sha: commit, parents: [{ sha: github.main }, { sha: head }], ignored: secret };
    } else if (tail.startsWith('/git/refs/heads/polyforge-merge-')) {
      const ref = tail.slice('/git/'.length);
      if (method === 'DELETE') {
        refs.delete(ref);
        await github.after?.(method, tail);
        return new Response(null, { status: 204 });
      }
      if (!refs.has(ref)) return new Response(secret, { status: 404 });
      result = { object: { sha: refs.get(ref) } };
    } else if (tail.startsWith('/compare/')) {
      assert.equal(tail, '/compare/' + commit + '...' + github.main);
      result = { merge_base_commit: { sha: github.main === descendant ? commit : base } };
    } else assert.fail('Unexpected GitHub path ' + tail);
    await github.after?.(method, tail);
    return Response.json(result);
  };
  return github;
}

export const mutations = github => github.calls.filter(call => call.method !== 'GET').map(call => call.method);

export function writer(journal, github, binding) {
  return createGitHubAppAdapter({ fetch: github.fetch, getInstallationToken: async () => secret,
    githubRepositoryId: binding.repositoryId, durableWriter: createGitHubJournalMerge({ journal, scope: binding }),
  });
}
