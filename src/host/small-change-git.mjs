import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fullSha = /^[a-f0-9]{40}$/;
const regularMode = /^(000000|100644)$/;
const maxSnapshotBytes = 256 * 1024 * 1024;
const maxSnapshotFiles = 50_000;

// Neither environment config nor producer metadata is an input to worker Git.
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
async function gitAt(cwd, ...args) {
  return (await exec('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + join(cwd, '.git', 'disabled-hooks'), '-c', 'core.attributesFile=', '-c', 'core.autocrlf=false',
    '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'submodule.recurse=false', '-C', cwd, ...args],
  { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout;
}

async function regularFile(path, budget, optional = false) {
  const before = await lstat(path).catch(error => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.nlink !== 1 || before.size > maxSnapshotBytes || await realpath(path) !== resolve(path)) throw new Error('Unsupported Git metadata file');
  // Never follow metadata symlinks; validate the opened identity as well as its directory entry.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Git metadata changed during inspection');
    }
    budget.bytes += opened.size;
    if (++budget.files > maxSnapshotFiles || budget.bytes > maxSnapshotBytes) throw new Error('Git snapshot exceeds inspection limits');
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    const after = await lstat(path);
    if (data.length !== opened.size || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeMs !== before.mtimeMs || await realpath(path) !== resolve(path)) throw new Error('Git metadata changed during inspection');
    return data;
  } finally { await handle.close(); }
}

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== resolve(path)) throw new Error('Unsupported linked Git metadata directory');
}

async function sourceMetadata(checkout, cwd, budget) {
  const entry = join(cwd, '.git');
  const info = await lstat(entry);
  let gitDirectory;
  if (info.isDirectory()) {
    await directory(entry);
    gitDirectory = entry;
  } else {
    const pointer = (await regularFile(entry, budget)).toString('utf8');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer);
    if (!match || !checkout.gitDirectory) throw new Error('External Git metadata requires operator-pinned directories');
    gitDirectory = resolve(cwd, match[1]);
    if (gitDirectory !== await realpath(checkout.gitDirectory)) throw new Error('Git directory does not match operator configuration');
    await directory(gitDirectory);
  }
  const commonPointer = await regularFile(join(gitDirectory, 'commondir'), budget, true);
  const commonDirectory = commonPointer ? resolve(gitDirectory, commonPointer.toString('utf8').trim()) : gitDirectory;
  if (commonDirectory !== gitDirectory && (!checkout.commonDirectory || commonDirectory !== await realpath(checkout.commonDirectory))) {
    throw new Error('Shared Git metadata requires an operator-pinned common directory');
  }
  await directory(commonDirectory);
  return { gitDirectory, commonDirectory };
}

async function sourceHead({ gitDirectory, commonDirectory }, budget) {
  const value = (await regularFile(join(gitDirectory, 'HEAD'), budget)).toString('utf8').trim();
  if (fullSha.test(value)) return value;
  const match = /^ref: (refs\/heads\/[^\r\n]+)$/.exec(value);
  if (!match || /[\\\x00-\x20\x7f:~^?*\[]/.test(match[1]) || match[1].includes('@{') ||
      match[1].split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Unsupported producer HEAD');
  }
  // Check each directory before opening a loose ref. Packed refs require no traversal.
  let refDirectory = commonDirectory;
  for (const part of match[1].split('/').slice(0, -1)) {
    refDirectory = join(refDirectory, part);
    const info = await lstat(refDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) break;
    await directory(refDirectory);
  }
  const loose = await regularFile(join(commonDirectory, match[1]), budget, true);
  if (loose && fullSha.test(loose.toString('utf8').trim())) return loose.toString('utf8').trim();
  if (loose) throw new Error('Unsupported producer ref');
  const packed = await regularFile(join(commonDirectory, 'packed-refs'), budget, true);
  const sha = packed?.toString('utf8').split('\n').find(line => line.endsWith(` ${match[1]}`))?.split(' ')[0];
  if (!fullSha.test(sha ?? '')) throw new Error('Checkout must have an identifiable commit');
  return sha;
}

async function copyObjects(source, target, budget) {
  await directory(source);
  for await (const { name: entry } of await opendir(source)) {
    if (entry === 'info') {
      await directory(join(source, entry));
      if (await regularFile(join(source, entry, 'alternates'), budget, true) ||
          await regularFile(join(source, entry, 'http-alternates'), budget, true)) {
        throw new Error('Alternate Git object stores are unsupported');
      }
      continue;
    }
    if (entry !== 'pack' && !/^[a-f0-9]{2}$/.test(entry)) throw new Error('Unsupported Git object directory');
    await directory(join(source, entry));
    await mkdir(join(target, entry), { recursive: true });
    for await (const { name: file } of await opendir(join(source, entry))) {
      const supported = entry === 'pack' ? /^pack-[a-f0-9]{40}\.(pack|idx)$/.test(file) : /^[a-f0-9]{38}$/.test(file);
      if (entry === 'pack' && (/^pack-[a-f0-9]{40}\.(rev|bitmap|keep)$/.test(file) || file === 'multi-pack-index')) {
        await regularFile(join(source, entry, file), budget);
        continue;
      }
      // Promisor stores and unknown extensions require standard implementation.
      if (!supported) throw new Error('Unsupported Git object metadata');
      await writeFile(join(target, entry, file), await regularFile(join(source, entry, file), budget));
    }
  }
}

async function cleanWorktree(git, cwd, head) {
  // Rebuild the index from the tree: producer skip-worktree, assume-unchanged and stat caches are not proof.
  await git('read-tree', '--empty');
  await git('read-tree', head);
  if (await git('-c', 'core.autocrlf=input', '--work-tree=' + cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all')) {
    throw new Error('Checkout must have a clean, identifiable commit');
  }
}

async function inspectSource(checkout, root, visit) {
  const cwd = await realpath(checkout.path);
  const budget = { bytes: 0, files: 0 };
  const metadata = await sourceMetadata(checkout, cwd, budget);
  const head = await sourceHead(metadata, budget);
  await mkdir(root);
  await gitAt(root, 'init', '--quiet', '--template=', '--object-format=sha1', '.');
  const git = (...args) => gitAt(root, ...args);
  await copyObjects(join(metadata.commonDirectory, 'objects'), join(root, '.git', 'objects'), budget);
  // Only bytes needed by Git's object/index parsers cross the boundary. Never config, hooks,
  // alternates, grafts, replacement refs, source metadata in a Git command, or upload-pack.
  await writeFile(join(root, '.git', 'HEAD'), head + '\n');
  // A producer object filename is not proof of its content-addressed identity.
  await git('fsck', '--strict', '--no-reflogs', '--no-dangling', '--no-progress', head);
  const index = await regularFile(join(metadata.gitDirectory, 'index'), budget);
  await writeFile(join(root, '.git', 'index'), index);
  if ((await git('rev-parse', '--verify', 'HEAD^{commit}')).trim() !== head ||
      await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--quiet', head, '--').catch(() => 'dirty')) {
    throw new Error('Checkout must have a clean, identifiable commit');
  }
  await cleanWorktree(git, cwd, head);
  const result = await visit({ cwd, git, head, root });
  if (await sourceHead(await sourceMetadata(checkout, cwd, budget), budget) !== head) {
    throw new Error('Checkout changed during candidate verification');
  }
  // Recheck staged changes using fresh producer index bytes, followed by a fresh trusted tree index.
  await writeFile(join(root, '.git', 'index'), await regularFile(join(metadata.gitDirectory, 'index'), budget));
  if (await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--quiet', head, '--').catch(() => 'dirty')) {
    throw new Error('Checkout changed during candidate verification');
  }
  await cleanWorktree(git, cwd, head);
  return result;
}

async function checkIsolated(checkout, snapshot, base, head, temporaryRoot) {
  const cwd = join(temporaryRoot, 'checkout');
  await mkdir(cwd);
  await gitAt(cwd, 'init', '--quiet', '--template=', '--object-format=sha1', '.');
  const git = (...args) => gitAt(cwd, ...args);
  // The only transport source is the worker-owned, validated metadata snapshot.
  // A depth-two fetch excludes unrelated objects even when the producer used packed storage.
  await git('-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--depth=2', '--', snapshot.root, head);
  await git('checkout', '--quiet', '--detach', head, '--');
  const originalHead = await readFile(join(cwd, '.git', 'HEAD'));
  let check;
  try { check = await checkout.check({ cwd, base, head, checkId: checkout.checkId }); } catch {}
  // Candidate execution may modify its .git directory. Never run worker Git there afterwards.
  // The operator check adapter must isolate candidate subprocesses from inspection metadata.
  await directory(join(cwd, '.git'));
  const verifiedHead = await regularFile(join(cwd, '.git', 'HEAD'), { bytes: 0, files: 0 });
  if (!originalHead.equals(verifiedHead)) throw new Error('Isolated checkout changed during candidate verification');
  const index = await regularFile(join(cwd, '.git', 'index'), { bytes: 0, files: 0 });
  await writeFile(join(snapshot.root, '.git', 'index'), index);
  if (await snapshot.git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--quiet', head, '--').catch(() => 'dirty')) {
    throw new Error('Isolated checkout changed during candidate verification');
  }
  try { await cleanWorktree(snapshot.git, cwd, head); } catch { throw new Error('Isolated checkout changed during candidate verification'); }
  return check;
}

function changedFiles(raw) {
  const rows = raw.split('\0');
  if (rows.pop() !== '' || rows.length % 2) throw new Error('Incomplete Git diff');
  const changes = [];
  for (let i = 0; i < rows.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([AMD])$/.exec(rows[i]);
    if (!match || !regularMode.test(match[1]) || !regularMode.test(match[2]) || !rows[i + 1]) {
      throw new Error('Diff includes an unsupported file or mode change');
    }
    changes.push({ path: rows[i + 1], status: match[3] });
  }
  return changes;
}

/** lookup returns the operator's scoped checkout and check adapter, never a request path or command. */
export function createSmallChangeGitInspector({ lookup }) {
  return async ({ phase, input, candidate }) => {
    const checkout = await lookup({ companyId: input.paperclipCompanyId, projectId: input.projectId, issueId: input.paperclipIssueId });
    if (!checkout?.path || !checkout.key || !Array.isArray(checkout.allowedPaths) ||
        typeof checkout.reviewDiff !== 'function' || typeof checkout.check !== 'function') {
      throw new Error('Scoped checkout or verification adapter unavailable');
    }
    if (checkout.requirementId !== input.versioned_requirement?.id ||
        checkout.requirementVersion !== input.versioned_requirement?.version ||
        checkout.approvalId !== input.pilot_scope?.approvalId) {
      throw new Error('The operator-approved requirement or decision does not match');
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'polyforge-small-change-check-'));
    try {
      return await inspectSource(checkout, join(temporaryRoot, 'inspection'), async snapshot => {
        const { head, git } = snapshot;
        if (phase === 'admission') return { key: checkout.key, head, allowedPaths: checkout.allowedPaths,
          checkId: checkout.checkId, reviewerId: checkout.reviewerId, reproductionRef: checkout.reproductionRef };
        const base = input.pilot_scope.baseSha;
        if (phase !== 'submission' || !fullSha.test(base) || !fullSha.test(candidate?.version ?? '') || candidate.version !== head) {
          throw new Error('Candidate must name the actual checkout commit');
        }
        const parents = (await git('rev-list', '--parents', '-n', '1', head)).trim().split(' ');
        if (parents.length !== 2 || parents[1] !== base) throw new Error('Expected one reversible commit directly on the admitted base');
        const diffArgs = ['--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--'];
        const diff = changedFiles(await git('diff', '--raw', '-z', ...diffArgs));
        if (!diff.length || diff.some(item => !['M', 'A'].includes(item.status) || !input.pilot_scope.paths.includes(item.path) ||
            !checkout.allowedPaths.includes(item.path))) return { key: checkout.key, base, head, diff };
        const patch = await git('diff', '--patch', '--no-color', ...diffArgs);
        const scope = await checkout.reviewDiff({ base, head, diff, patch });
        if (scope?.outcome !== 'within-scope' || scope.headSha !== head || !scope.evidenceRef) {
          return { key: checkout.key, base, head, diff, scope };
        }
        const check = await checkIsolated(checkout, snapshot, base, head, temporaryRoot);
        return { key: checkout.key, base, head, diff, scope, check };
      });
    } finally {
      // Remove only the invocation-owned directory, including failed setup and concurrent retries.
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}
