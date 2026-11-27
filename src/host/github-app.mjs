import { contractPublicationError } from './contract-publication-causes.mjs';
import { readGitHubBlob } from '../plugin/github-http-transport.mjs';
import { validGitHubId } from '../plugin/github-app-config.mjs';

const sha = /^[a-f0-9]{40}$/;
export const contractStatusContext = 'polyforge/contract-g2';
const differs = () => contractPublicationError('contract-proposal-differs');

export function createGitHubAppAdapter({ fetch, installationTokenProvider, githubRepositoryId, repository }) {
  if (typeof fetch !== 'function' || !validGitHubId(githubRepositoryId)) throw new Error('github-invalid-binding');
  const origin = 'https://api.github.com/repositories/' + githubRepositoryId + '/';
  const commits = new Map();
  const trees = new Map();

  async function request(path, body, blobSha) {
    const method = body === undefined ? 'GET' : 'POST';
    const url = origin + path;
    const response = await installationTokenProvider.withToken({ repositoryId: githubRepositoryId }, method, async token => {
      const result = await fetch(url, {
        method, redirect: 'error',
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
      if (result.redirected || (result.url && result.url !== url) || (result.status >= 300 && result.status < 400)) {
        throw new Error('github-transport-redirect');
      }
      return result;
    });
    if (!response.ok) throw new Error('github-request-unavailable');
    return blobSha ? readGitHubBlob(response, blobSha) : response.json();
  }

  async function getPull(pullNumber) {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error('github-invalid-pull');
    const pr = await request('pulls/' + pullNumber);
    if (pr.base?.repo?.id !== githubRepositoryId ||
        (repository && pr.base.repo.full_name?.toLowerCase() !== repository.toLowerCase())) {
      throw new Error('github-repository-identity-mismatch');
    }
    if (!sha.test(pr.head?.sha) || typeof pr.head.ref !== 'string' || typeof pr.merged !== 'boolean'
        || !['open', 'closed'].includes(pr.state)) throw new Error('github-invalid-pull');
    return pr;
  }

  async function mainSha() {
    const commit = await request('commits/main');
    if (!sha.test(commit.sha)) throw new Error('github-invalid-commit');
    return commit.sha;
  }

  function getCommit(ref) {
    if (!sha.test(ref)) throw new Error('github-invalid-commit');
    if (!commits.has(ref)) commits.set(ref, request('git/commits/' + ref).then(commit => {
      if (commit.sha !== ref || !sha.test(commit.tree?.sha) || !Array.isArray(commit.parents)
          || commit.parents.some(parent => !sha.test(parent.sha))) throw new Error('github-invalid-commit');
      return commit;
    }));
    return commits.get(ref);
  }

  async function pinnedTree(ref) {
    const commit = await getCommit(ref);
    const treeSha = commit.tree.sha;
    if (!trees.has(treeSha)) trees.set(treeSha, request('git/trees/' + treeSha + '?recursive=1').then(tree => {
      if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('github-invalid-tree');
      const entries = new Map();
      for (const entry of tree.tree) {
        if (typeof entry.path !== 'string' || !entry.path || !sha.test(entry.sha) || entries.has(entry.path)) {
          throw new Error('github-invalid-tree');
        }
        entries.set(entry.path, entry);
      }
      return entries;
    }));
    return trees.get(treeSha);
  }

  async function readOptionalFile(path, ref) {
    const entry = (await pinnedTree(ref)).get(path);
    if (!entry) return null;
    if (entry.type !== 'blob' || entry.mode !== '100644') throw differs();
    try {
      return await request('git/blobs/' + entry.sha, undefined, entry.sha);
    } catch (error) {
      if (['github-blob-hash-mismatch', 'github-blob-size-mismatch'].includes(error.message)) throw differs();
      throw error;
    }
  }

  async function mergeBase(ancestor, descendant) {
    if (!sha.test(ancestor) || !sha.test(descendant)) throw new Error('github-invalid-commit');
    if (ancestor === descendant) return ancestor;
    const comparison = await request('compare/' + ancestor + '...' + descendant + '?per_page=1');
    if (!sha.test(comparison.merge_base_commit?.sha)) throw new Error('github-invalid-comparison');
    return comparison.merge_base_commit.sha;
  }

  async function writeStatus(headSha, state, description) {
    if (!sha.test(headSha) || !['success', 'failure'].includes(state)) throw new Error('github-invalid-status');
    const status = await request('statuses/' + headSha, { state, description, context: contractStatusContext });
    if (status.state !== state || status.context !== contractStatusContext || status.description !== description) {
      throw new Error('github-invalid-status');
    }
  }

  return { getPull, mainSha, getCommit, pinnedTree, readOptionalFile, mergeBase, contains: async (a, b) => await mergeBase(a, b) === a, writeStatus };
}
