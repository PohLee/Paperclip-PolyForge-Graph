import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createSmallChangeGitInspector } from '../../src/host/small-change-git.mjs';

async function fixture(t, check) {
  const repo = await mkdtemp(join(tmpdir(), 'polyforge-inspector-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Inspector test');
  git('config', 'user.email', 'inspector@example.invalid');
  await writeFile(join(repo, '.gitignore'), 'stale-output.txt\n');
  await writeFile(join(repo, 'README.md'), 'before\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('commit', '--quiet', '--allow-empty', '-m', 'admitted base with older history');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'after\n');
  git('commit', '--quiet', '-am', 'candidate');
  const head = git('rev-parse', 'HEAD');
  const checkout = {
    key: 'fixture', path: repo, allowedPaths: ['README.md'], checkId: 'build',
    requirementId: 'R', requirementVersion: '1', approvalId: 'A',
    reviewDiff: async () => ({ outcome: 'within-scope', headSha: head, evidenceRef: 'fixture://scope' }),
    check,
  };
  const inspect = createSmallChangeGitInspector({ lookup: async () => checkout });
  const request = { phase: 'submission', candidate: { version: head }, input: {
    versioned_requirement: { id: 'R', version: '1' }, pilot_scope: { baseSha: base, approvalId: 'A', paths: ['README.md'] },
  } };
  return { repo, git, head, inspect, request, checkout };
}

async function assertCleaned(cwd, source) {
  assert.notEqual(cwd, source);
  await assert.rejects(access(cwd), { code: 'ENOENT' });
  await assert.rejects(access(dirname(cwd)), { code: 'ENOENT' });
}

for (const detached of [false, true]) test(`verification excludes ignored outputs with ${detached ? 'detached' : 'branch'} producer HEAD`, async t => {
  let checkedCwd;
  let observedHead, observedBase, observedBranch, observedDepth, observedRefs;
  const f = await fixture(t, async ({ cwd, head, base, checkId }) => {
    checkedCwd = cwd;
    observedHead = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    observedBase = execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', `${base}^{commit}`], { encoding: 'utf8', windowsHide: true }).trim();
    observedBranch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    observedDepth = execFileSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    observedRefs = execFileSync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8', windowsHide: true }).trim();
    const stale = await readFile(join(cwd, 'stale-output.txt'), 'utf8').catch(() => null);
    return { id: checkId, headSha: head, result: stale ? 'pass' : 'fail', evidenceRef: 'fixture://check' };
  });
  if (detached) f.git('checkout', '--quiet', '--detach', f.head);
  // This branch must not be copied into the isolated repository.
  f.git('branch', 'unrelated-history', f.request.input.pilot_scope.baseSha);
  await writeFile(join(f.repo, 'stale-output.txt'), 'producer-only passing build\n');
  const result = await f.inspect(f.request);
  assert.equal(result.check?.result, 'fail');
  assert.equal(observedHead, f.head);
  assert.equal(observedBase, f.request.input.pilot_scope.baseSha);
  assert.equal(observedBranch, 'HEAD');
  assert.equal(observedDepth, '2');
  assert.equal(observedRefs, '');
  assert.equal(await readFile(join(f.repo, 'stale-output.txt'), 'utf8'), 'producer-only passing build\n');
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.git('status', '--porcelain'), '');
  await assertCleaned(checkedCwd, f.repo);
});

test('concurrent checks use distinct disposable directories and clean up a throwing check', async t => {
  const directories = [];
  let entered;
  const bothEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async ({ cwd, head, checkId }) => {
    const index = directories.push(cwd);
    if (index === 2) entered();
    await bothEntered;
    if (index === 1) throw new Error('verification failed');
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  const results = await Promise.all([f.inspect(f.request), f.inspect(f.request)]);
  assert.equal(new Set(directories).size, 2);
  assert.equal(results.filter(result => result.check?.result === 'pass').length, 1);
  assert.equal(results.filter(result => result.check === undefined).length, 1);
  for (const cwd of directories) await assertCleaned(cwd, f.repo);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a passing check cannot modify the committed verification files', async t => {
  let checkedCwd;
  const f = await fixture(t, async ({ cwd, head, checkId }) => {
    checkedCwd = cwd;
    await writeFile(join(cwd, 'README.md'), 'modified by check\n');
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  await assert.rejects(f.inspect(f.request), /changed during candidate verification/);
  assert.equal(await readFile(join(f.repo, 'README.md'), 'utf8'), 'after\n');
  await assertCleaned(checkedCwd, f.repo);
});

// Inert subprocess guard: reject forbidden source-side commands before any process is started.
async function guardedInspector(t, source) {
  const child = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = child.default.execFile;
  const commands = [];
  child.default.execFile = (command, args, options, callback) => {
    commands.push(args);
    assert.notEqual(options.cwd, source);
    for (let i = 0; i < args.length; i++) {
      assert.ok(!['clone', 'upload-pack'].includes(args[i]), 'source-side Git transport is forbidden');
      if (args[i] === 'fetch') {
        const snapshot = args.at(-2);
        assert.equal(snapshot.split(/[\\/]/).pop(), 'inspection');
        assert.match(dirname(snapshot).split(/[\\/]/).pop(), /^polyforge-small-change-check-/);
        assert.notEqual(snapshot, source);
      }
      if (args[i] === '-C' || args[i] === '--git-dir') assert.notEqual(args[i + 1], source);
    }
    return original(command, args, options, callback);
  };
  const guardedExec = child.default.execFile;
  const { promisify } = await import('node:util');
  guardedExec[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    guardedExec(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  syncBuiltinESMExports();
  let createInspector;
  try {
    ({ createSmallChangeGitInspector: createInspector } = await import(`../../src/host/small-change-git.mjs?guard=${Date.now()}`));
  } finally {
    child.default.execFile = original;
    syncBuiltinESMExports();
  }
  return { createInspector, commands };
}

test('admission and submission never load producer config or use source-side Git transport', async t => {
  const f = await fixture(t, async ({ head, checkId }) => ({ id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' }));
  const guard = await guardedInspector(t, f.repo);
  const inspect = guard.createInspector({ lookup: async () => ({ ...f.checkout }) });
  // Invalid inert syntax makes any accidental producer-config read fail, without executable content.
  await writeFile(join(f.repo, '.git', 'config'), '[invalid inert marker\n');
  const admission = await inspect({ ...f.request, phase: 'admission' });
  assert.equal(admission.head, f.head);
  const submission = await inspect(f.request);
  assert.equal(submission.check.result, 'pass');
  assert.ok(guard.commands.length > 0);
  assert.equal(await readFile(join(f.repo, '.git', 'config'), 'utf8'), '[invalid inert marker\n');
});

test('verification does not read config modified by the check', async t => {
  const f = await fixture(t, async ({ cwd, head, checkId }) => {
    await writeFile(join(cwd, '.git', 'config'), '[invalid inert marker\n');
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  assert.equal((await f.inspect(f.request)).check.result, 'pass');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`producer ${flag} cannot hide dirty tracked files`, async t => {
  let checked = false;
  const f = await fixture(t, async () => { checked = true; });
  f.git('update-index', flag, '--', 'README.md');
  await writeFile(join(f.repo, 'README.md'), 'uncommitted producer change\n');
  await assert.rejects(f.inspect(f.request), /clean/);
  assert.equal(checked, false);
});

test('staged changes cannot be concealed by a clean producer worktree', async t => {
  const f = await fixture(t, async () => assert.fail('dirty candidate cannot run'));
  await writeFile(join(f.repo, 'README.md'), 'staged change\n');
  f.git('add', '--', 'README.md');
  await writeFile(join(f.repo, 'README.md'), 'after\n');
  await assert.rejects(f.inspect(f.request), /clean/);
});

test('alternate object stores are rejected without invoking source Git', async t => {
  const f = await fixture(t, async () => assert.fail('unsupported storage cannot run'));
  await writeFile(join(f.repo, '.git', 'objects', 'info', 'alternates'), '../inert-untrusted-marker\n');
  const guard = await guardedInspector(t, f.repo);
  const inspect = guard.createInspector({ lookup: async () => f.checkout });
  await assert.rejects(inspect(f.request), /Alternate Git object stores/);
});

test('packed refs and objects are inspected without source-side transport', async t => {
  const f = await fixture(t, async ({ head, checkId }) => ({ id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' }));
  f.git('gc', '--prune=now');
  const guard = await guardedInspector(t, f.repo);
  const inspect = guard.createInspector({ lookup: async () => f.checkout });
  assert.equal((await inspect(f.request)).check.result, 'pass');
});

test('linked worktrees require operator-pinned metadata and then support an ordinary candidate', async t => {
  const f = await fixture(t, async ({ head, checkId }) => ({ id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' }));
  const linked = join(dirname(f.repo), `${f.repo.split(/[\\/]/).pop()}-linked`);
  t.after(() => rm(linked, { recursive: true, force: true }));
  f.git('worktree', 'add', '--quiet', '--detach', linked, f.head);
  const checkout = { ...f.checkout, path: linked };
  const inspect = createSmallChangeGitInspector({ lookup: async () => checkout });
  await assert.rejects(inspect(f.request), /operator-pinned/);
  checkout.gitDirectory = f.git('-C', linked, 'rev-parse', '--absolute-git-dir');
  checkout.commonDirectory = join(f.repo, '.git');
  assert.equal((await inspect(f.request)).check.result, 'pass');
  checkout.gitDirectory = join(f.repo, '.git');
  await assert.rejects(inspect(f.request), /operator configuration/);
});



test('symlinked object directories are rejected before their marker files are read', async t => {
  const { mkdir, symlink } = await import('node:fs/promises');
  const f = await fixture(t, async () => assert.fail('linked metadata cannot run'));
  const marker = join(f.repo, 'inert-marker');
  await mkdir(marker);
  await writeFile(join(marker, 'marker.txt'), 'ordinary inert fixture\n');
  let prefix;
  for (let i = 0; i < 256; i++) {
    const candidate = i.toString(16).padStart(2, '0');
    if (!(await access(join(f.repo, '.git', 'objects', candidate)).then(() => true, () => false))) { prefix = candidate; break; }
  }
  await symlink(marker, join(f.repo, '.git', 'objects', prefix), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.inspect(f.request), /Unsupported linked Git metadata directory/);
  assert.equal(await readFile(join(marker, 'marker.txt'), 'utf8'), 'ordinary inert fixture\n');
});

test('a packed producer store does not expose unrelated commits or blobs to verification', async t => {
  let unrelatedCommit, unrelatedBlob, olderCommit;
  const f = await fixture(t, async ({ cwd, head, base, checkId }) => {
    const verifyObject = sha => execFileSync('git', ['-C', cwd, 'cat-file', '-e', sha],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    verifyObject(head);
    verifyObject(base);
    for (const sha of [unrelatedCommit, unrelatedBlob, olderCommit]) assert.throws(() => verifyObject(sha));
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  olderCommit = f.git('rev-parse', `${f.request.input.pilot_scope.baseSha}^`);
  f.git('checkout', '--quiet', '-b', 'unrelated-history', f.request.input.pilot_scope.baseSha);
  await writeFile(join(f.repo, 'unrelated.txt'), 'ordinary unrelated branch fixture\n');
  f.git('add', '--', 'unrelated.txt');
  f.git('commit', '--quiet', '-m', 'Unrelated ordinary fixture');
  unrelatedCommit = f.git('rev-parse', 'HEAD');
  unrelatedBlob = f.git('rev-parse', 'HEAD:unrelated.txt');
  f.git('checkout', '--quiet', '--detach', f.head);
  f.git('gc', '--prune=now');
  const guard = await guardedInspector(t, f.repo);
  const inspect = guard.createInspector({ lookup: async () => f.checkout });
  assert.equal((await inspect(f.request)).check.result, 'pass');
});

test('a passing check cannot stage changes and restore only its worktree', async t => {
  const f = await fixture(t, async ({ cwd, head, checkId }) => {
    await writeFile(join(cwd, 'README.md'), 'staged verification change\n');
    execFileSync('git', ['-C', cwd, 'add', '--', 'README.md'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await writeFile(join(cwd, 'README.md'), 'after\n');
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  await assert.rejects(f.inspect(f.request), /changed during candidate verification/);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('verification accepts a new regular file on an admitted path', async t => {
  const f = await fixture(t, async ({ cwd, head, checkId }) => {
    assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'new\n');
    return { id: checkId, headSha: head, result: 'pass', evidenceRef: 'fixture://check' };
  });
  await writeFile(join(f.repo, 'new.txt'), 'new\n');
  f.git('add', 'new.txt');
  f.git('commit', '--quiet', '--amend', '--no-edit');
  const head = f.git('rev-parse', 'HEAD');
  f.request.candidate.version = head;
  f.checkout.reviewDiff = async () => ({ outcome: 'within-scope', headSha: head, evidenceRef: 'fixture://scope' });
  f.checkout.allowedPaths.push('new.txt');
  f.request.input.pilot_scope.paths.push('new.txt');
  assert.equal((await f.inspect(f.request)).check?.result, 'pass');
});
