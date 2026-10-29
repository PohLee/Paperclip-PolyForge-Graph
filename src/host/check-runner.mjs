import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const statuses = ['pass', 'retry', 'stop'];
const terminating = new WeakSet();
function terminateProcessTree(child) {
  if (!child?.pid || terminating.has(child)) return;
  terminating.add(child);
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)],
      { windowsHide: true, stdio: 'ignore' });
    const fallback = setTimeout(() => child.kill('SIGKILL'), 500);
    fallback.unref();
    killer.on('error', () => { clearTimeout(fallback); child.kill('SIGKILL'); });
    killer.on('exit', code => { clearTimeout(fallback); if (code !== 0) child.kill('SIGKILL'); });
    killer.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}
function validateStep(step) {
  if (!step || !/^[a-zA-Z0-9_-]+$/.test(step.id)) throw new Error('Step needs a safe unique id');
  if (!['command', 'agent'].includes(step.type)) throw new Error('Step type must be command or agent');
  if (step.type === 'command' && (typeof step.executable !== 'string' || !step.executable ||
      !Array.isArray(step.args) || step.args.some(arg => typeof arg !== 'string'))) throw new Error('Command needs executable and string args');
  if (step.retryExitCodes !== undefined && (!Array.isArray(step.retryExitCodes) ||
      step.retryExitCodes.some(code => !Number.isInteger(code) || code < 1 || code > 255))) throw new Error('Invalid retry exit codes');
}
function agentResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['status', 'summary'].includes(key)) ||
      !statuses.includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('Agent must return only status (pass/retry/stop) and nonempty summary');
  }
  return value;
}

// Configuration comes from the host. Graph input and checker feedback never select executables.
export async function runChecks(config, { runAgent, signal, onStarted } = {}) {
  if (!config || !Array.isArray(config.checks) || !config.checks.length ||
      (config.setup !== undefined && !Array.isArray(config.setup))) throw new Error('At least one check and an optional setup array are required');
  const steps = [...(config.setup ?? []), ...(config.worker ? [config.worker] : []), ...config.checks];
  steps.forEach(validateStep);
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Step IDs must be unique');
  if (steps.some(step => step.type === 'agent') && typeof runAgent !== 'function') throw new Error('Host agent adapter is unavailable');
  const maxAttempts = config.maxAttempts ?? 3, timeoutMs = config.timeoutMs ?? 60000, maxOutputBytes = config.maxOutputBytes ?? 1048576;
  for (const [name, value, limit] of [['maxAttempts', maxAttempts, 20], ['timeoutMs', timeoutMs, 3600000], ['maxOutputBytes', maxOutputBytes, 16777216]]) {
    if (!Number.isInteger(value) || value < 1 || value > limit) throw new Error(`Invalid ${name}`);
  }
  if (typeof config.cwd !== 'string' || typeof config.logDir !== 'string') throw new Error('cwd and logDir are required');
  const cwd = await realpath(config.cwd);
  await mkdir(resolve(config.logDir), { recursive: true });
  const directory = await mkdtemp(join(resolve(config.logDir), 'check-run-'));
  const manifestPath = join(directory, 'manifest.json');
  const manifest = { schemaVersion: 1, cwd, runnerPid: process.pid,
    startedAt: new Date().toISOString(), status: 'running',
    unreadCompletion: false, maxAttempts, timeoutMs, maxOutputBytes, setup: [], attempts: [] };
  const save = async () => {
    await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    await rename(`${manifestPath}.tmp`, manifestPath);
  };
  await save();
  if (onStarted) await onStarted(manifestPath);
  const finish = async (status, summary) => {
    Object.assign(manifest, { status, summary, finishedAt: new Date().toISOString(), unreadCompletion: true, activeStep: null });
    await save();
    return { ...manifest, manifestPath };
  };
  async function execute(step, attempt, feedback) {
    const prefix = `${attempt}-${step.id}`, logPath = join(directory, `${prefix}.log`);
    const feedbackPath = join(directory, `${prefix}-feedback.json`);
    await writeFile(feedbackPath, JSON.stringify({ attempt, feedback }, null, 2));
    const record = { id: step.id, type: step.type, attempt, logPath, feedbackPath, startedAt: new Date().toISOString() };
    manifest.activeStep = { id: step.id, attempt, logPath, feedbackPath, startedAt: record.startedAt,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString() };
    await save();
    if (step.type === 'command') {
      Object.assign(record, { executable: step.executable, args: [...step.args], retryExitCodes: step.retryExitCodes ?? [1] });
      const result = await new Promise(resolveResult => {
        let child, timer, settleTimer, closed = false, size = 0, output = '', failure = null;
        const cancel = () => {
          if (closed) return;
          failure = 'Check cancelled';
          clearTimeout(timer);
          terminateProcessTree(child);
          child?.stdout?.destroy(); child?.stderr?.destroy();
          settleTimer = setTimeout(() => done(null, 'cancelled'), 2000);
        };
        const done = (code, endSignal) => {
          if (closed) return; closed = true; clearTimeout(timer); clearTimeout(settleTimer);
          signal?.removeEventListener?.('abort', cancel);
          resolveResult({ code, signal: endSignal, output, failure });
        };
        try {
          if (signal?.aborted) { failure = 'Check cancelled'; done(null, 'cancelled'); return; }
          child = spawn(step.executable, step.args, { cwd, shell: false, windowsHide: true,
            detached: process.platform !== 'win32',
            env: { ...process.env, POLYFORGE_CHECK_FEEDBACK: feedbackPath, POLYFORGE_CHECK_ATTEMPT: String(attempt) }, stdio: ['ignore', 'pipe', 'pipe'] });
          const append = chunk => {
            size += chunk.length;
            if (size <= maxOutputBytes) output += chunk.toString();
            else if (!failure) {
              failure = 'Output limit exceeded'; terminateProcessTree(child);
              settleTimer = setTimeout(() => done(null, 'output-limit'), 2000);
            }
          };
          child.stdout.on('data', append); child.stderr.on('data', append);
          child.on('error', error => { failure = error.message; done(null, null); });
          // Drain streams normally; the timeout also bounds inherited pipes.
          child.on('close', done);
          signal?.addEventListener?.('abort', cancel, { once: true });
          timer = setTimeout(() => {
            failure = 'Command timeout'; terminateProcessTree(child);
            child.stdout.destroy(); child.stderr.destroy();
            settleTimer = setTimeout(() => done(null, 'timeout'), 2000);
          }, timeoutMs);
        } catch (error) { failure = error.message; done(null, null); }
      });
      await writeFile(logPath, result.output + (result.failure ? `\n${result.failure}\n` : ''));
      Object.assign(record, { exitCode: result.code, signal: result.signal,
        status: result.failure || result.signal ? 'stop' : result.code === 0 ? 'pass' : record.retryExitCodes.includes(result.code) ? 'retry' : 'stop',
        summary: result.failure ?? `Command exited ${result.code}${result.signal ? ` (${result.signal})` : ''}` });
    } else {
      const controller = new AbortController();
      let timer;
      let rejectCancellation;
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
      const cancel = () => { controller.abort(); rejectCancellation(new Error('Check cancelled')); };
      signal?.addEventListener?.('abort', cancel, { once: true });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            if (signal?.aborted) throw new Error('Check cancelled');
            return runAgent({ id: step.id, attempt, feedback, cwd, signal: controller.signal });
          }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Agent timeout')); }, timeoutMs); }),
          cancellation,
        ]);
        Object.assign(record, agentResult(result));
        if (Buffer.byteLength(record.summary) > maxOutputBytes) throw new Error('Agent output limit exceeded');
      } catch (error) { Object.assign(record, { status: 'stop', summary: error.message }); }
      finally { clearTimeout(timer); signal?.removeEventListener?.('abort', cancel); }
      await writeFile(logPath, JSON.stringify({ status: record.status, summary: record.summary }, null, 2));
    }
    record.finishedAt = new Date().toISOString();
    manifest.activeStep = null;
    return record;
  }
  for (const step of config.setup ?? []) {
    if (signal?.aborted) return finish('stop', 'Check cancelled');
    const result = await execute(step, 0, []); manifest.setup.push(result); await save();
    if (result.status !== 'pass') return finish('stop', `Setup ${step.id} failed; no worker/check retries`);
  }
  let feedback = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return finish('stop', 'Check cancelled');
    const row = { attempt, worker: null, checks: [] }; manifest.attempts.push(row);
    if (config.worker) {
      row.worker = await execute(config.worker, attempt, feedback); await save();
      if (row.worker.status !== 'pass') return finish('stop', 'Worker did not complete successfully');
    }
    for (const check of config.checks) {
      if (signal?.aborted) return finish('stop', 'Check cancelled');
      const result = await execute(check, attempt, feedback); row.checks.push(result); await save();
      if (result.status === 'stop') return finish('stop', `Check ${check.id} stopped execution`);
    }
    if (row.checks.every(check => check.status === 'pass')) return finish('pass', 'All configured checks passed');
    feedback = row.checks.filter(check => check.status !== 'pass').map(({ id, status, summary, logPath }) => ({ id, status, summary, logPath }));
    if (!config.worker) return finish('retry', 'Checks failed; no worker configured');
  }
  return finish('retry', 'Attempt limit reached with failing checks');
}

// The same in-process execution can be awaited immediately or observed later.
// The manifest remains readable after the caller's session ends.
export async function startChecks(config, options = {}) {
  let started, failed;
  const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener?.('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const completion = runChecks(config, { ...options, signal: controller.signal,
    onStarted: path => { started(path); } }).catch(error => { failed(error); throw error; });
  completion.catch(() => {});
  completion.then(() => options.signal?.removeEventListener?.('abort', externalAbort),
    () => options.signal?.removeEventListener?.('abort', externalAbort));
  return { manifestPath: await ready, completion, cancel: () => controller.abort() };
}

export async function readCheckResult(manifestPath, { acknowledge = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (acknowledge && manifest.status !== 'running' && manifest.unreadCompletion) {
    manifest.unreadCompletion = false;
    manifest.acknowledgedAt = new Date().toISOString();
    await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    await rename(`${manifestPath}.tmp`, manifestPath);
  }
  return { ...manifest, manifestPath, requiresHostReconciliation: manifest.status === 'running' };
}
