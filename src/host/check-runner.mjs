import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const statuses = ['pass', 'retry', 'stop'];
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
export async function runChecks(config, { runAgent } = {}) {
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
  const manifest = { schemaVersion: 1, cwd, startedAt: new Date().toISOString(), status: 'stop',
    maxAttempts, timeoutMs, maxOutputBytes, setup: [], attempts: [] };
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await save();
  const finish = async (status, summary) => {
    Object.assign(manifest, { status, summary, finishedAt: new Date().toISOString() });
    await save();
    return { ...manifest, manifestPath };
  };
  async function execute(step, attempt, feedback) {
    const prefix = `${attempt}-${step.id}`, logPath = join(directory, `${prefix}.log`);
    const feedbackPath = join(directory, `${prefix}-feedback.json`);
    await writeFile(feedbackPath, JSON.stringify({ attempt, feedback }, null, 2));
    const record = { id: step.id, type: step.type, attempt, logPath, feedbackPath, startedAt: new Date().toISOString() };
    if (step.type === 'command') {
      Object.assign(record, { executable: step.executable, args: [...step.args], retryExitCodes: step.retryExitCodes ?? [1] });
      const result = await new Promise(resolveResult => {
        let child, timer, closed = false, size = 0, output = '', failure = null;
        const done = (code, signal) => {
          if (closed) return; closed = true; clearTimeout(timer);
          resolveResult({ code, signal, output, failure });
        };
        try {
          child = spawn(step.executable, step.args, { cwd, shell: false, windowsHide: true,
            env: { ...process.env, POLYFORGE_CHECK_FEEDBACK: feedbackPath, POLYFORGE_CHECK_ATTEMPT: String(attempt) }, stdio: ['ignore', 'pipe', 'pipe'] });
          const append = chunk => {
            size += chunk.length;
            if (size <= maxOutputBytes) output += chunk.toString();
            else { failure = 'Output limit exceeded'; child.kill('SIGKILL'); }
          };
          child.stdout.on('data', append); child.stderr.on('data', append);
          child.on('error', error => { failure = error.message; done(null, null); });
          // Drain streams normally; the timeout also bounds inherited pipes.
          child.on('close', done);
          timer = setTimeout(() => { failure = 'Command timeout'; child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); done(null, 'timeout'); }, timeoutMs);
        } catch (error) { failure = error.message; done(null, null); }
      });
      await writeFile(logPath, result.output + (result.failure ? `\n${result.failure}\n` : ''));
      Object.assign(record, { exitCode: result.code, signal: result.signal,
        status: result.failure || result.signal ? 'stop' : result.code === 0 ? 'pass' : record.retryExitCodes.includes(result.code) ? 'retry' : 'stop',
        summary: result.failure ?? `Command exited ${result.code}${result.signal ? ` (${result.signal})` : ''}` });
    } else {
      const controller = new AbortController();
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => runAgent({ id: step.id, attempt, feedback, cwd, signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Agent timeout')); }, timeoutMs); })
        ]);
        Object.assign(record, agentResult(result));
        if (Buffer.byteLength(record.summary) > maxOutputBytes) throw new Error('Agent output limit exceeded');
      } catch (error) { Object.assign(record, { status: 'stop', summary: error.message }); }
      finally { clearTimeout(timer); }
      await writeFile(logPath, JSON.stringify({ status: record.status, summary: record.summary }, null, 2));
    }
    record.finishedAt = new Date().toISOString();
    return record;
  }
  for (const step of config.setup ?? []) {
    const result = await execute(step, 0, []); manifest.setup.push(result); await save();
    if (result.status !== 'pass') return finish('stop', `Setup ${step.id} failed; no worker/check retries`);
  }
  let feedback = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const row = { attempt, worker: null, checks: [] }; manifest.attempts.push(row);
    if (config.worker) {
      row.worker = await execute(config.worker, attempt, feedback); await save();
      if (row.worker.status !== 'pass') return finish('stop', 'Worker did not complete successfully');
    }
    for (const check of config.checks) {
      const result = await execute(check, attempt, feedback); row.checks.push(result); await save();
      if (result.status === 'stop') return finish('stop', `Check ${check.id} stopped execution`);
    }
    if (row.checks.every(check => check.status === 'pass')) return finish('pass', 'All configured checks passed');
    feedback = row.checks.filter(check => check.status !== 'pass').map(({ id, status, summary, logPath }) => ({ id, status, summary, logPath }));
    if (!config.worker) return finish('retry', 'Checks failed; no worker configured');
  }
  return finish('retry', 'Attempt limit reached with failing checks');
}
