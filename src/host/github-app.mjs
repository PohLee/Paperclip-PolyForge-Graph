import { isDeepStrictEqual } from 'node:util';

const sha = /^[a-f0-9]{40}$/;
const repoName = /^[\w.-]+\/[\w.-]+$/;
const locks = new Map();
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

export function createGitHubAppAdapter({
  fetch: fetchImpl = globalThis.fetch, getInstallationToken, installedValidator, receipts, mergeActorLogin,
}) {
  async function request(repository, path, { method = 'GET', body, raw } = {}) {
    if (!repoName.test(repository)) throw new Error('Invalid GitHub repository');
    const token = await getInstallationToken(repository);
    const response = await fetchImpl('https://api.github.com/repos/' + repository + '/' + path, {
      method, redirect: 'error',
      headers: {
        authorization: 'Bearer ' + token,
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error('GitHub ' + method + ' failed with HTTP ' + response.status);
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  async function getRef({ repository, ref }) {
    const result = await request(repository, 'git/' + encodePath(ref));
    return result.object.sha;
  }

  async function readFile(repository, path, ref) {
    return request(repository, 'contents/' + encodePath(path) + '?ref=' + ref, { raw: true });
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
    const tree = await request(repository, 'git/trees/' + headSha + '?recursive=1');
    if (tree.truncated) throw new Error('Cannot verify file modes in truncated Git tree');
    const entries = new Map(tree.tree.map(entry => [entry.path, entry]));
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
      if ([path, previousPath].some(name => name && /(?:^|\/)(?:[^/]+\.lock(?:\.yaml)?|[^/]+-lock\.ya?ml|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|Cargo\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/i.test(name))) {
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

  function loadValidator({ repository, ref }) {
    if (!sha.test(ref)) throw new Error('Validator data must be pinned to main');
    return {
      recompute(input) {
        if (input.repository !== repository || input.baseSha !== ref) throw new Error('Validator pin changed');
        return installedValidator.recompute(input, { readFile: path => readFile(repository, path, ref) });
      },
      judgeVerificationManifest: installedValidator.judgeVerificationManifest,
    };
  }

  function receiptKey({ repository, pullNumber }) {
    return JSON.stringify([repository.toLowerCase(), pullNumber]);
  }

  async function reconcile(input, saved) {
    if (saved.failure) throw new Error(saved.failure);
    if (saved.mergeCommitSha) return saved;
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

  return {
    getRef, getPullSnapshot, loadValidator, getDependencyChanges,
    getMergeReceipt(input) {
      return serialized(input.repository, async () => {
        const saved = await receipts.get(receiptKey(input));
        if (!saved) return undefined;
        checkRequest(input, saved);
        return reconcile(input, saved);
      });
    },
    merge(input, authorize) {
      return serialized(input.repository, async () => {
        const { repository, pullNumber, baseSha, headSha } = input;
        if (!sha.test(baseSha) || !sha.test(headSha) || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
          throw new Error('Invalid GitHub merge request');
        }
        const key = receiptKey(input);
        const saved = await receipts.get(key);
        if (saved) {
          checkRequest(input, saved);
          return (await reconcile(input, saved)).mergeCommitSha;
        }
        const pr = await request(repository, 'pulls/' + pullNumber);
        if (pr.merged || pr.state !== 'open' || pr.draft || pr.base.ref !== 'main' || pr.head.sha !== headSha) {
          throw new Error('Pull request changed before merge');
        }
        await authorize?.();
        await receipts.set(key, input);
        try {
          if (await getRef({ repository, ref: 'refs/heads/main' }) !== baseSha) {
            throw new Error('Main changed before merge');
          }
        } catch (error) {
          await receipts.delete(key);
          throw error;
        }
        const result = await request(repository, 'pulls/' + pullNumber + '/merge', {
          method: 'PUT', body: { sha: headSha, merge_method: 'merge' },
        });
        if (!result.merged) {
          await receipts.delete(key);
          throw new Error('GitHub did not confirm the merge');
        }
        if (!sha.test(result.sha)) throw new Error('Invalid GitHub merge response SHA');
        const acknowledged = { ...input, observedMergeSha: result.sha };
        await receipts.set(key, acknowledged);
        return (await reconcile(input, acknowledged)).mergeCommitSha;
      });
    },
  };
}
