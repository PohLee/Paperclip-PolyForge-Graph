import { contractPublicationError } from './contract-publication-causes.mjs';
import { parseGitTree, readContractsTree } from './github-app.mjs';
import { readApprovedContract } from './contract-publication.mjs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

const sha = /^[a-f0-9]{40}$/;
const repoName = /^[\w.-]+\/[\w.-]+$/;
const locks = new Map();
const tempBranch = /^refs\/heads\/(polyforge-merge-[0-9a-f-]{36})$/;
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

async function serialized(repository, operation) {
  const key = repository.toLowerCase();
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function createImplementationGitHubAdapter({ fetch, getInstallationToken, installedValidator, receipts, mergeActorLogin }) {
  const fetchImpl = fetch === undefined ? globalThis.fetch : fetch;

  async function request(repository, path, { method = 'GET', body, raw } = {}) {
    if (!repoName.test(repository)) throw new Error('Invalid GitHub repository');
    const send = token => fetchImpl('https://api.github.com/repos/' + repository + (path ? '/' + path : ''), {
      method, redirect: 'error',
      headers: {
        authorization: 'Bearer ' + token,
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const response = await send(await getInstallationToken(repository));
    if (!response.ok) {
      const error = new Error('GitHub ' + method + ' failed with HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return;
    if (raw) return Buffer.from(await response.arrayBuffer());
    return response.json();
  }

  async function getRef({ repository, ref }) {
    const result = await request(repository, 'git/' + encodePath(ref));
    const commit = result?.object?.sha;
    return commit;
  }

  async function pinnedTree(repository, ref) {
    if (!sha.test(ref)) throw new Error('GitHub file reads must be pinned');
    const tree = await request(repository, 'git/trees/' + ref + '?recursive=1');
    if (tree.truncated) {
      throw new Error('Cannot verify file modes in truncated Git tree');
    }
    return new Map(tree.tree.map(entry => [entry.path, entry]));
  }

  async function readFile(repository, path, ref) {
    return request(repository, 'contents/' + encodePath(path) + '?ref=' + ref, { raw: true });
  }

  function contractReader(repository, root) {
    const snapshots = new Map();
    return async (path, ref) => {
      if (!sha.test(ref)) throw new Error('GitHub file reads must be pinned');
      if (!snapshots.has(ref)) snapshots.set(ref, readContractsTree(ref, root, async (treeRef, recursive) =>
        parseGitTree(await request(repository, 'git/trees/' + treeRef + (recursive ? '?recursive=1' : '')))));
      let entries;
      try { entries = await snapshots.get(ref); }
      catch (error) {
        if (error.publicationCause === 'contract-proposal-differs') throw contractPublicationError('contract-drift');
        throw error;
      }
      const entry = entries.get(path);
      if (!entry) return null;
      if (entry.type !== 'blob' || entry.mode !== '100644') throw contractPublicationError('contract-drift');
      return readFile(repository, path, ref);
    };
  }

  async function getPullSnapshot({ repository, pullNumber, baseSha }) {
    if (!sha.test(baseSha) || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
      throw new Error('Invalid pull snapshot request');
    }
    const pr = await request(repository, 'pulls/' + pullNumber);
    const headSha = pr.head.sha;
    if (!sha.test(headSha) || pr.merged || pr.state !== 'open' || pr.draft ||
      pr.base.ref !== 'main' || pr.base.sha !== baseSha ||
      pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase()) {
      throw new Error('Pull request must be open and current against main');
    }
    const comparison = await request(repository, 'compare/' + baseSha + '...' + headSha);
    if (comparison.merge_base_commit.sha !== baseSha || !Array.isArray(comparison.files)
      || comparison.files.length >= 300 || comparison.files.length !== pr.changed_files) {
      throw new Error('Cannot verify complete pull request changes against main');
    }
    const entries = await pinnedTree(repository, headSha);
    const changes = [];
    for (const file of comparison.files) {
      const entry = entries.get(file.filename);
      if (!entry && file.status !== 'removed') throw new Error('Changed path is missing from head tree');
      changes.push({
        path: file.filename, previousPath: file.previous_filename, status: file.status, mode: entry?.mode,
        bytes: entry?.type === 'blob' && entry.mode !== '120000'
          ? await readFile(repository, file.filename, headSha) : undefined,
      });
    }
    return { headSha, baseSha, baseRef: pr.base.ref, author: pr.user.login, changes };
  }

  async function getDependencyChanges({ repository, baseSha, headSha, changes }) {
    if (![baseSha, headSha].every(ref => sha.test(ref))) throw new Error('Dependency reads must be pinned');
    if (installedValidator.getDependencyChanges) {
      return installedValidator.getDependencyChanges({ repository, baseSha, headSha, changes }, {
        readFile: (path, ref) => {
          if (ref !== baseSha && ref !== headSha) throw new Error('Dependency read pin changed');
          return readFile(repository, path, ref);
        },
      });
    }
    const result = [];
    for (const { path, previousPath, status } of changes) {
      const filename = path.split('/').at(-1);
      if ([path, previousPath].some(name => name && /(?:^|\/)(?:[^/]+\.lock(?:b|\.yaml)?|[^/]+-lock\.ya?ml|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|Cargo\.toml|go\.(?:mod|sum)|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/i.test(name))) {
        return null;
      }
      const npmFile = /(?:^|\/)(?:package(-lock)?|npm-shrinkwrap)\.json$/;
      if (!npmFile.test(path) && !npmFile.test(previousPath ?? '')) continue;
      if (previousPath || !['added', 'removed', 'modified'].includes(status)) return null;
      async function versions(ref, absent) {
        if (absent) return {};
        const data = JSON.parse(await readFile(repository, path, ref));
        if (filename === 'package.json') {
          return Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
            .flatMap(group => Object.entries(data[group] ?? {}).map(([name, version]) => [group + ':' + name, version])));
        }
        if (!data.packages) throw new Error('Unsupported npm lockfile');
        return Object.fromEntries(Object.entries(data.packages).filter(([key]) => key.includes('node_modules/'))
          .map(([key, entry]) => [key, entry.version ?? entry.resolved]));
      }
      const before = await versions(baseSha, status === 'added');
      const after = await versions(headSha, status === 'removed');
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[key] === after[key]) continue;
        const name = key.includes('node_modules/') ? key.split('node_modules/').at(-1) : key.split(':').at(-1);
        result.push({ name, from: before[key] ?? null, to: after[key] ?? null });
      }
    }
    return result;
  }

  async function getCheckStatus({ repository, sha: commit }) {
    if (!sha.test(commit)) throw new Error('Check status requires a pinned commit');
    const [checks, statuses] = await Promise.all([
      request(repository, 'commits/' + commit + '/check-runs?filter=latest&per_page=100'),
      request(repository, 'commits/' + commit + '/status?per_page=100'),
    ]);
    if (checks.total_count > checks.check_runs.length || statuses.total_count > statuses.statuses.length) {
      throw new Error('Cannot verify complete GitHub check status');
    }
    return [
      ...checks.check_runs.map(({ name, status, conclusion }) => ({ name, status, conclusion })),
      ...statuses.statuses.map(({ context, state }) => ({
        name: context, status: state === 'pending' ? 'in_progress' : 'completed',
        conclusion: state === 'pending' ? null : state,
      })),
    ];
  }

  function loadValidator({ repository, ref }) {
    if (!sha.test(ref)) throw new Error('Validator data must be pinned to main');
    return {
      judgeVerificationManifest: installedValidator.judgeVerificationManifest,
      async readVerificationCriteria(input) {
        const read = contractReader(repository, input.contractsRoot);
        const files = await readApprovedContract(input, (path, pinned = ref) => read(path, pinned));
        return installedValidator.readVerificationCriteria(input, { readFile: path => files.get(path) });
      },
    };
  }

  function receiptKey({ repository, pullNumber }) {
    return JSON.stringify([repository.toLowerCase(), pullNumber]);
  }

  async function mainContains(repository, commit) {
    const main = await getRef({ repository, ref: 'refs/heads/main' });
    if (main === commit) return true;
    const comparison = await request(repository, 'compare/' + commit + '...' + main);
    return comparison.merge_base_commit?.sha === commit;
  }

  async function assertOpenPull({ repository, pullNumber, headSha }) {
    const pr = await request(repository, 'pulls/' + pullNumber);
    if (pr.merged || pr.state !== 'open' || pr.draft || pr.base.ref !== 'main' || pr.head.sha !== headSha) {
      throw new Error('Pull request changed before merge');
    }
  }

  async function createTempRef(repository, ref, baseSha) {
    if (!tempBranch.test(ref) || !sha.test(baseSha)) throw new Error('Invalid GitHub temporary ref');
    return request(repository, 'git/refs', { method: 'POST', body: { ref, sha: baseSha } });
  }

  async function mergeTempRef(repository, ref, baseSha, headSha) {
    const branch = tempBranch.exec(ref)?.[1];
    if (!branch || !sha.test(baseSha) || !sha.test(headSha)) throw new Error('Invalid GitHub merge request');
    const result = await request(repository, 'merges', { method: 'POST', body: { base: branch, head: headSha } });
    if (!sha.test(result?.sha)) throw new Error('Invalid GitHub merge response SHA');
    if (result.parents?.length !== 2 || result.parents[0]?.sha !== baseSha || result.parents[1]?.sha !== headSha) {
      throw new Error('Merged commit parents differ from the authorized base and head');
    }
    return result.sha;
  }

  async function patchMain(repository, commit) {
    if (!sha.test(commit)) throw new Error('Invalid GitHub merge response SHA');
    await request(repository, 'git/refs/heads/main', {
      method: 'PATCH', body: { sha: commit, force: false },
    });
  }

  async function deleteTempRef(repository, ref) {
    if (!tempBranch.test(ref)) throw new Error('Invalid GitHub temporary ref');
    return request(repository, 'git/' + encodePath(ref), { method: 'DELETE' });
  }

  async function reconcile(input, saved) {
    if (saved.failure) throw new Error(saved.failure);
    if (saved.mergeCommitSha) return saved;
    if (saved.pinnedMergeSha) {
      if (!await mainContains(input.repository, saved.pinnedMergeSha)) {
        if (saved.patchRejected) {
          await receipts.delete(receiptKey(input));
          return undefined;
        }
        throw new Error('GitHub merge outcome is still unknown');
      }
      const receipt = { ...saved, mergeCommitSha: saved.pinnedMergeSha };
      await receipts.set(receiptKey(input), receipt);
      return receipt;
    }
    const pr = await request(input.repository, 'pulls/' + input.pullNumber);
    if (!pr.merged) throw new Error('GitHub merge outcome is still unknown');
    const mergeCommitSha = pr.merge_commit_sha;
    if (!sha.test(mergeCommitSha)) throw new Error('Invalid GitHub merge commit SHA');
    const acknowledged = saved.observedMergeSha === mergeCommitSha;
    const mergedByApp = !saved.observedMergeSha && mergeActorLogin
      && pr.merged_by?.login?.toLowerCase() === mergeActorLogin.toLowerCase();
    if (!acknowledged && !mergedByApp) {
      const failure = 'GitHub merge cannot be attributed to the authorized App operation';
      await receipts.set(receiptKey(input), { ...saved, failure });
      throw new Error(failure);
    }
    const commit = await request(input.repository, 'git/commits/' + mergeCommitSha);
    const validParents = commit.parents.length === 2 && commit.parents[0].sha === saved.baseSha
      && commit.parents[1].sha === saved.headSha;
    const failure = validParents ? undefined : 'Merged commit parents differ from the authorized base and head';
    const receipt = { ...saved, mergeCommitSha, ...(failure ? { failure } : {}) };
    await receipts.set(receiptKey(input), receipt);
    if (failure) throw new Error(failure);
    return receipt;
  }

  function checkRequest(input, saved) {
    if (Object.entries(input).some(([key, value]) => !isDeepStrictEqual(saved[key], value))) {
      throw new Error('GitHub merge request changed');
    }
  }

  async function reconcileRequest(input, saved) {
    if (!saved) return undefined;
    if (saved.patchRejected) {
      const reconciled = await reconcile(input, saved);
      if (reconciled) checkRequest(input, reconciled);
      return reconciled;
    }
    checkRequest(input, saved);
    return reconcile(input, saved);
  }

  const reads = { getRef, getPullSnapshot, loadValidator, getCheckStatus, getDependencyChanges };
  return {
    ...reads,
    getMergeReceipt(input) {
      return serialized(input.repository, async () => {
        const saved = await receipts.get(receiptKey(input));
        return reconcileRequest(input, saved);
      });
    },
    async merge(input, authorize) {
      if (input.section !== undefined) throw new Error('Implementation adapter cannot merge a contract publication');
      return serialized(input.repository, async () => {
        const { repository, pullNumber, baseSha, headSha } = input;
        if (!sha.test(baseSha) || !sha.test(headSha) || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
          throw new Error('Invalid GitHub merge request');
        }
        const key = receiptKey(input);
        const saved = await receipts.get(key);
        const reconciled = await reconcileRequest(input, saved);
        if (reconciled) return reconciled.mergeCommitSha;
        await assertOpenPull(input);
        const tempRef = 'refs/heads/polyforge-merge-' + randomUUID();
        try {
          await createTempRef(repository, tempRef, baseSha);
          const mergeSha = await mergeTempRef(repository, tempRef, baseSha, headSha);
          if (await getRef({ repository, ref: 'refs/heads/main' }) !== baseSha) {
            throw new Error('Main changed before merge');
          }
          await authorize?.();
          const pending = { ...input, pinnedMergeSha: mergeSha };
          await receipts.set(key, pending);
          await assertOpenPull(input).catch(async error => {
            await receipts.delete(key);
            throw error;
          });
          try {
            await patchMain(repository, mergeSha);
          } catch (error) {
            if (error.status === 422) {
              const rejected = { ...pending, patchRejected: true };
              await receipts.set(key, rejected);
              await reconcile(input, rejected);
            }
            throw error;
          }
          await receipts.set(key, { ...pending, mergeCommitSha: mergeSha });
          return mergeSha;
        } finally {
          // A failed cleanup must preserve the merge outcome and its durable receipt.
          await deleteTempRef(repository, tempRef).catch(() => {});
        }
      });
    },
  };
}
