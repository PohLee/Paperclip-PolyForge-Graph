import { contractPublicationError } from './contract-publication-causes.mjs';
import { readGitHubBlob } from '../plugin/github-http-transport.mjs';
import { validGitHubId } from '../plugin/github-app-config.mjs';

const sha = /^[a-f0-9]{40}$/;
export const contractStatusContext = 'polyforge/contract-g2';
const differs = () => contractPublicationError('contract-proposal-differs');

export async function readContractsTree(treeRef, root, readTree) {
  for (const segment of root.split('/')) {
    const entry = (await readTree(treeRef, false)).get(segment);
    if (!entry) return new Map();
    if (entry.type !== 'tree') throw differs();
    treeRef = entry.sha;
  }
  return new Map(Array.from(await readTree(treeRef, true), ([path, entry]) => [root + '/' + path, entry]));
}

export function parseGitTree(tree) {
  if (tree.truncated === true) throw contractPublicationError('github-contract-tree-truncated');
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw contractPublicationError('github-invalid-tree');
  const entries = new Map();
  for (const entry of tree.tree) {
    if (typeof entry.path !== 'string' || !entry.path || !sha.test(entry.sha) || entries.has(entry.path)) {
      throw contractPublicationError('github-invalid-tree');
    }
    entries.set(entry.path, entry);
  }
  return entries;
}

export function createGitHubAppAdapter({ fetch, installationTokenProvider, githubRepositoryId, repository, contractsRoot = 'knowledge/contracts' }) {
  if (typeof fetch !== 'function' || !validGitHubId(githubRepositoryId)) throw contractPublicationError('github-invalid-binding');
  const origin = 'https://api.github.com/repositories/' + githubRepositoryId + '/';
  const commits = new Map();
  const trees = new Map();
  const contractTrees = new Map();

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
        throw contractPublicationError('github-transport-redirect');
      }
      return result;
    });
    if (!response.ok) {
      throw Object.assign(contractPublicationError('github-request-unavailable'), { status: response.status });
    }
    return blobSha ? readGitHubBlob(response, blobSha) : response.json();
  }

  async function getPull(pullNumber) {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw contractPublicationError('github-invalid-pull');
    const pr = await request('pulls/' + pullNumber);
    if (pr.base?.repo?.id !== githubRepositoryId ||
        (repository && pr.base.repo.full_name?.toLowerCase() !== repository.toLowerCase())) {
      throw contractPublicationError('github-repository-identity-mismatch');
    }
    if (!sha.test(pr.head?.sha) || typeof pr.head.ref !== 'string' || typeof pr.merged !== 'boolean'
        || !['open', 'closed'].includes(pr.state)) throw contractPublicationError('github-invalid-pull');
    return pr;
  }

  async function mainSha() {
    const commit = await request('commits/heads/main');
    if (!sha.test(commit.sha)) throw contractPublicationError('github-invalid-commit');
    return commit.sha;
  }

  function getCommit(ref) {
    if (!sha.test(ref)) throw contractPublicationError('github-invalid-commit');
    if (!commits.has(ref)) commits.set(ref, request('git/commits/' + ref).then(commit => {
      if (commit.sha !== ref || !sha.test(commit.tree?.sha) || !Array.isArray(commit.parents)
          || commit.parents.some(parent => !sha.test(parent.sha))) throw contractPublicationError('github-invalid-commit');
      return commit;
    }));
    return commits.get(ref);
  }

  function readTree(ref, recursive) {
    const path = 'git/trees/' + ref + (recursive ? '?recursive=1' : '');
    if (!trees.has(path)) trees.set(path, request(path).then(tree => {
      if (tree.sha !== ref) throw contractPublicationError('github-invalid-tree');
      return parseGitTree(tree);
    }));
    return trees.get(path);
  }

  function pinnedTree(ref) {
    if (!contractTrees.has(ref)) contractTrees.set(ref, getCommit(ref).then(commit =>
      readContractsTree(commit.tree.sha, contractsRoot, readTree)));
    return contractTrees.get(ref);
  }

  async function readOptionalFile(path, ref) {
    const entry = (await pinnedTree(ref)).get(path);
    return readEntry(entry);
  }

  async function readEntry(entry) {
    if (!entry) return null;
    if (entry.type !== 'blob' || entry.mode !== '100644') throw differs();
    try {
      return await request('git/blobs/' + entry.sha, undefined, entry.sha);
    } catch (error) {
      if (['github-blob-hash-mismatch', 'github-blob-size-mismatch'].includes(error.code)) throw differs();
      throw error;
    }
  }

  async function mergeBase(ancestor, descendant) {
    if (!sha.test(ancestor) || !sha.test(descendant)) throw contractPublicationError('github-invalid-commit');
    if (ancestor === descendant) return ancestor;
    const comparison = await request('compare/' + ancestor + '...' + descendant + '?per_page=1');
    if (!sha.test(comparison.merge_base_commit?.sha)) throw contractPublicationError('github-invalid-comparison');
    return comparison.merge_base_commit.sha;
  }

  async function pullChanges(mergeBaseSha, headSha) {
    if (mergeBaseSha === headSha) return [];
    const { files } = await request('compare/' + mergeBaseSha + '...' + headSha + '?per_page=1');
    if (!Array.isArray(files) || files.length >= 300 || files.some(file => typeof file?.filename !== 'string')) throw differs();
    return files.flatMap(file => file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]);
  }

  async function writeStatus(headSha, state, description) {
    if (!sha.test(headSha) || !['success', 'failure'].includes(state)) throw contractPublicationError('github-invalid-status');
    const status = await request('statuses/' + headSha, { state, description, context: contractStatusContext });
    if (status.state !== state || status.context !== contractStatusContext || status.description !== description) {
      throw contractPublicationError('github-invalid-status');
    }
  }

  return { getPull, mainSha, pinnedTree, readOptionalFile, readEntry, mergeBase, pullChanges, contains: async (a, b) => await mergeBase(a, b) === a, writeStatus };
}
