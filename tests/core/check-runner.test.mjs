import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks, startChecks, readCheckResult, writeJsonAtomically } from '../../src/host/check-runner.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { cwd: dir, logDir: dir, timeoutMs: 2000, maxAttempts: 3 };
}
const command = (id, source, extra = {}) => ({ id, type: 'command', executable: process.execPath, args: ['-e', source], ...extra });

test('setup runs once, command retry feedback reaches worker and evidence persists', async t => {
  const config = await fixture(t), seen = [];
  config.setup = [command('setup', "require('node:fs').writeFileSync('setup.txt','once')")];
  config.worker = { id: 'worker', type: 'agent' };
  config.checks = [command('test', "console.log('assertion output'); process.exit(Number(process.env.POLYFORGE_CHECK_ATTEMPT) === 1 ? 1 : 0)")];
  const result = await runChecks(config, { runAgent: async ({ feedback }) => { seen.push(feedback); return { status: 'pass', summary: 'Work completed' }; } });
  assert.equal(result.status, 'pass'); assert.equal(result.attempts.length, 2); assert.equal(result.setup.length, 1);
  assert.equal(seen[0].length, 0); assert.equal(seen[1][0].id, 'test');
  assert.match(await readFile(seen[1][0].logPath, 'utf8'), /assertion output/);
  assert.equal(JSON.parse(await readFile(result.manifestPath, 'utf8')).status, 'pass');
});

test('bounded retries never turn a failed check into pass', async t => {
  const config = await fixture(t);
  const result = await runChecks({ ...config, maxAttempts: 2, worker: command('work', ''), checks: [command('test', 'process.exit(1)')] });
  assert.equal(result.status, 'retry'); assert.equal(result.attempts.length, 2);
});

test('setup failure, missing executable and infrastructure exit stop without retries', async t => {
  const config = await fixture(t);
  const failed = await runChecks({ ...config, setup: [command('setup', 'process.exit(1)')], checks: [command('test', '')] });
  assert.equal(failed.status, 'stop'); assert.equal(failed.attempts.length, 0);
  for (const check of [{ id: 'missing', type: 'command', executable: join(config.cwd, 'not-installed'), args: [] }, command('permission', 'process.exit(13)')]) {
    const result = await runChecks({ ...config, worker: command('work', ''), checks: [check] });
    assert.equal(result.status, 'stop'); assert.equal(result.attempts.length, 1);
  }
});

test('command timeout and output bound stop the run and retain failure logs', async t => {
  const config = await fixture(t);
  const timeout = await runChecks({ ...config, timeoutMs: 300, checks: [command('hang', 'setInterval(()=>{},1000)')] });
  assert.equal(timeout.status, 'stop'); assert.match(timeout.attempts[0].checks[0].summary, /timeout/);
  const overflow = await runChecks({ ...config, maxOutputBytes: 100, checks: [command('large', "console.log('x'.repeat(10000))")] });
  assert.equal(overflow.status, 'stop'); assert.match(overflow.attempts[0].checks[0].summary, /Output limit/);
});

test('agent checks require strict results and a timeout-aware host adapter', async t => {
  const config = { ...await fixture(t), checks: [{ id: 'review', type: 'agent' }] };
  await assert.rejects(runChecks(config), /adapter is unavailable/);
  for (const value of ['PASS', { status: 'pass', summary: 'Looks good', extra: 'ignored?' }, { status: 'unknown', summary: 'No data' }]) {
    assert.equal((await runChecks(config, { runAgent: async () => value })).status, 'stop');
  }
  assert.equal((await runChecks(config, { runAgent: async () => ({ status: 'retry', summary: 'Missing edge case' }) })).status, 'retry');
  let aborted = false;
  const result = await runChecks({ ...config, timeoutMs: 20 }, { runAgent: ({ signal }) => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })) });
  assert.equal(result.status, 'stop'); assert.equal(aborted, true);
});

test('commands receive literal arguments without shell interpolation', async t => {
  const config = await fixture(t), literal = '$(no-command) & echo injected';
  const result = await runChecks({ ...config, checks: [{ id: 'literal', type: 'command', executable: process.execPath, args: ['-e', 'console.log(process.argv[1])', literal] }] });
  assert.equal(result.status, 'pass'); assert.equal((await readFile(result.attempts[0].checks[0].logPath, 'utf8')).trim(), literal);
});

test('background handle keeps one execution, cancellation persists an unread result', async t => {
  const config = await fixture(t);
  config.checks = [command('slow', 'setInterval(()=>{},1000)')];
  const handle = await startChecks(config);
  const running = await readCheckResult(handle.manifestPath);
  assert.equal(running.status, 'running');
  assert.equal(running.requiresHostReconciliation, true);
  assert.equal(running.runnerPid, process.pid);
  handle.cancel();
  const finished = await handle.completion;
  assert.equal(finished.status, 'stop');
  assert.match(finished.attempts[0].checks[0].summary, /cancelled/);
  assert.equal((await readCheckResult(handle.manifestPath)).unreadCompletion, true);
  assert.equal((await readCheckResult(handle.manifestPath, { acknowledge: true })).unreadCompletion, false);
});

test('background start rejects invalid configuration without leaving a pending handle', async t => {
  const config = await fixture(t);
  await assert.rejects(startChecks({ ...config, checks: [] }), /At least one check/);
});

test('atomic replacement retries only bounded Windows sharing failures and preserves complete old JSON', async t => {
  const { cwd: dir } = await fixture(t), path = join(dir, 'manifest.json');
  await writeFile(path, '{"status":"old"}');
  await writeFile(`${path}.other.tmp`, 'other writer');
  let attempts = 0;
  const waits = [], paths = [];
  await writeJsonAtomically(path, { status: 'new' }, {
    platform: 'win32', wait: async ms => waits.push(ms),
    renameFile: async (source, destination) => {
      paths.push(source);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'old' });
      if (++attempts < 3) throw Object.assign(new Error('sharing conflict'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
      await rename(source, destination);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(new Set(paths).size, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'new' });
  assert.deepEqual((await readdir(dir)).sort(), ['manifest.json', 'manifest.json.other.tmp']);

  const errors = [['win32', 'EPERM', 6], ['linux', 'EPERM', 1], ['win32', 'ENOENT', 1]];
  for (const [platform, code, count] of errors) {
    attempts = 0; waits.length = 0;
    const failure = Object.assign(new Error('rename failed'), { code });
    await assert.rejects(writeJsonAtomically(path, { status: 'never-committed' }, {
      platform, wait: async ms => waits.push(ms), renameFile: async () => { attempts++; throw failure; },
    }), error => error === failure);
    assert.equal(attempts, count);
    assert.deepEqual(waits, count === 6 ? [10, 20, 40, 80, 160] : []);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'new' });
    assert.deepEqual((await readdir(dir)).sort(), ['manifest.json', 'manifest.json.other.tmp']);
  }
  assert.equal(await readFile(`${path}.other.tmp`, 'utf8'), 'other writer');
});

test('save and acknowledge persist complete JSON and clean their own temporary files', async t => {
  const config = await fixture(t);
  const result = await runChecks({ ...config, checks: [{ id: 'review', type: 'agent' }] },
    { runAgent: async () => ({ status: 'pass', summary: 'done' }) });
  const dir = join(result.manifestPath, '..');
  assert.equal(JSON.parse(await readFile(result.manifestPath, 'utf8')).unreadCompletion, true);
  await readCheckResult(result.manifestPath, { acknowledge: true });
  const acknowledged = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(acknowledged.status, 'pass');
  assert.equal(acknowledged.unreadCompletion, false);
  assert.ok(acknowledged.acknowledgedAt);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});

test('cleanup failure does not mask the original write failure or successful rename', async t => {
  const { cwd: dir } = await fixture(t), path = join(dir, 'manifest.json');
  await writeFile(path, '{"status":"old"}');
  await assert.rejects(writeJsonAtomically(path, { status: 'partial' }, {
    writeTemp: async temp => { await writeFile(temp, '{partial'); throw new Error('primary write failure'); },
    removeTemp: async () => { throw new Error('secondary cleanup failure'); },
  }), /primary write failure/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'old' });
  await writeJsonAtomically(path, { status: 'committed' }, {
    removeTemp: async () => { throw new Error('cleanup failed after rename'); },
  });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'committed' });
});
