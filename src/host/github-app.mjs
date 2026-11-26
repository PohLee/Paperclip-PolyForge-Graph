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
  fetch: fetchImpl = globalThis.fetch, getInstallationToken, installedValidator, receipts,
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
    if (Object.entries(input).some(([key, value]) => saved[key] !== value)) {
      throw new Error('GitHub merge request changed');
    }
  }

  return {
    getRef, getPullSnapshot, loadValidator,
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
        if (await getRef({ repository, ref: 'refs/heads/main' }) !== baseSha) {
          await receipts.delete(key);
          throw new Error('Main changed before merge');
        }
        const result = await request(repository, 'pulls/' + pullNumber + '/merge', {
          method: 'PUT', body: { sha: headSha, merge_method: 'merge' },
        });
        if (!result.merged) throw new Error('GitHub did not confirm the merge');
        return (await reconcile(input, input)).mergeCommitSha;
      });
    },
  };
}

