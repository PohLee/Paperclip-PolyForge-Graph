import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

export function signerEnvironment(base = process.env, generate = () => randomBytes(32).toString('hex')) {
  const secret = generate();
  if (typeof secret !== 'string' || !secret.trim()) throw new Error('Test JWT signer secret must be nonempty');
  return { ...base, PAPERCLIP_AGENT_JWT_SECRET: secret };
}
export function assertSignerArgv(args, env) {
  const secret = env.PAPERCLIP_AGENT_JWT_SECRET;
  if (typeof secret !== 'string' || !secret.trim() || !args.some((arg, i) => arg === '-e' && args[i + 1] === 'PAPERCLIP_AGENT_JWT_SECRET') || args.some(arg => arg.includes(secret))) {
    throw new Error('Test JWT signer must be passed by environment name only');
  }
}
export function assertCandidateIdentity(identity) {
  if (!identity || !/^[0-9a-f]{64}$/.test(identity.sha256 ?? '') || !/^\d+\.\d+\.\d+$/.test(identity.version ?? ''))
    throw new Error('Valid candidate SHA-256 and version are required');
  return identity;
}
export function buildStartInvocation({ candidate, fixture, driver, helper, image, name, identity, baseEnv, generate }) {
  assertCandidateIdentity(identity);
  const env = signerEnvironment(baseEnv, generate);
  const args = ['run', '--pull', 'never', '-d', '--rm', '--name', name, '--network', 'none', '--memory', '2g', '--cpus', '2',
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
    '--tmpfs', '/paperclip:rw,uid=1000,gid=1000,mode=0700,size=536870912', '--tmpfs', '/tmp:rw,mode=1777,size=134217728',
    '--mount', `type=bind,source=${candidate},target=/opt/polyforge/plugin,readonly`,
    '--mount', `type=bind,source=${fixture},target=/opt/v1/fixture.mjs,readonly`,
    '--mount', `type=bind,source=${driver},target=/opt/v1/driver.mjs,readonly`,
    '--mount', `type=bind,source=${helper},target=/opt/v1/e2e-minimal-helpers.mjs,readonly`,
    '-e', 'HOST=127.0.0.1', '-e', 'PAPERCLIP_BIND=loopback', '-e', 'PAPERCLIP_DEPLOYMENT_MODE=local_trusted',
    '-e', 'SERVE_UI=false', '-e', 'PAPERCLIP_TELEMETRY_DISABLED=1',
    '-e', 'POLYFORGE_FIXTURE_AGENT_SCRIPT=/opt/v1/fixture.mjs', '-e', 'PAPERCLIP_AGENT_JWT_SECRET',
    '-e', `POLYFORGE_V1_CANDIDATE_SHA256=${identity.sha256}`, '-e', `POLYFORGE_V1_CANDIDATE_VERSION=${identity.version}`, image];
  assertSignerArgv(args, env);
  return { args, env };
}

export function assertNegativeResult(rejected, before, after) {
  assert.ok([400, 403, 409].includes(rejected.status), `Unexpected negative HTTP ${rejected.status}`);
  const reason = typeof rejected.data?.error === 'string' ? rejected.data.error : '';
  assert.match(reason, /agent.{0,40}run|run.{0,40}agent|checkout|not bound|dispatch|identity/i,
    'Rejection must identify agent/run/checkout binding, not an unrelated HTTP error');
  assert.deepEqual(after.run, before.run, 'wrong identity changed Graph run or node results');
  assert.deepEqual(after.decisions, before.decisions, 'wrong identity changed decisions');
  return reason;
}

export function assertActiveDispatch({ issue, checkedOut, graphRunId, nodeId, attempt, agentId, hostRunId, dashboard }) {
  assert.equal(issue.originKind, 'plugin:pohlee.polyforge-graph:node');
  assert.equal(issue.originId, `${graphRunId}:${nodeId}:${attempt}:work`);
  assert.equal(checkedOut.assigneeAgentId, agentId);
  assert.equal(checkedOut.checkoutRunId, hostRunId);
  assert.equal(dashboard.run.id, graphRunId);
  assert.equal(dashboard.run.status, 'running');
  assert.equal(dashboard.run.nodeStates[nodeId].status, 'pending');
  assert.equal(dashboard.run.nodeStates[nodeId].attempts.length + 1, Number(attempt));
  return { issueId: issue.id, originId: issue.originId, agentId, runId: hostRunId, attempt: Number(attempt) };
}

export function assertDispatches(issues, runId, hostRuns, bindings) {
  const prefix = `${runId}:`;
  const rows = issues.filter(issue => issue.originKind === 'plugin:pohlee.polyforge-graph:node' && issue.originId?.startsWith(prefix));
  const phases = [
    { nodeId: 'assess-request', phase: 'work', role: 'adlc:product-owner' },
    { nodeId: 'assess-request', phase: 'supervisor', role: 'adlc:cpo' },
    { nodeId: 'triage-disposition', phase: 'work', role: 'adlc:product-owner' },
  ];
  assert.equal(rows.length, 3, 'Graph must have exactly three dispatch issues');
  assert.equal(hostRuns.length, 3, 'Graph must have exactly three distinct Host runs');
  assert.equal(new Set(hostRuns.map(run => run.id)).size, 3);
  assert.equal(new Set(rows.map(issue => issue.id)).size, 3);
  return phases.map(({ nodeId, phase, role }) => {
    const origin = `${runId}:${nodeId}:1:${phase}`;
    const matches = rows.filter(issue => issue.originId === origin);
    assert.equal(matches.length, 1, `Expected one dispatch for ${origin}`);
    const issue = matches[0];
    assert.equal(issue.assigneeAgentId, bindings[role]);
    const matchingRuns = hostRuns.filter(run => run.issueId === issue.id);
    assert.equal(matchingRuns.length, 1, `Expected one Host run for ${origin}`);
    assert.equal(matchingRuns[0].agentId, bindings[role]);
    return { nodeId, phase, issueId: issue.id, agentId: issue.assigneeAgentId, hostRunId: matchingRuns[0].id };
  });
}

// All observer I/O shares one deadline. Invalidations coalesce while reading.
export async function observeGraph({ socket, start, read, timeoutMs = 120000 }) {
  const controller = new AbortController(), finished = new Set();
  let settled = false, runId = null, dirty = false, reading = false;
  let resolveCompletion, rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  completion.catch(() => {});
  const settle = (error, value) => {
    if (settled) return;
    settled = true; controller.abort(); clearTimeout(timer);
    if (error) rejectCompletion(error); else resolveCompletion(value);
  };
  const timer = setTimeout(() => settle(new Error('V1 Graph event deadline exceeded')), timeoutMs);
  const inspect = async () => {
    if (settled || reading || !runId || !dirty) return;
    reading = true; dirty = false;
    try {
      const latest = await read(runId, controller.signal);
      if (settled) return;
      if (!['running', 'paused', 'completed'].includes(latest.run.status)) throw new Error(`Graph ended ${latest.run.status}`);
      const ids = [...new Set([
        ...Object.values(latest.run.nodeStates).flatMap(state => state.attempts.filter(x => x.actor?.kind === 'agent').map(x => x.actor.executionId)),
        ...latest.decisions.filter(x => x.actor?.kind === 'agent').map(x => x.actor.executionId),
      ].filter(Boolean))];
      if (latest.run.status === 'completed' && ids.length && ids.every(id => finished.has(id))) settle(null, { latest, ids });
    } catch (error) { if (!settled) settle(error); }
    finally { reading = false; if (!settled && dirty) void inspect(); }
  };
  const onMessage = event => {
    if (settled) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'heartbeat.run.status' && message.payload?.status === 'succeeded' && typeof message.payload.runId === 'string') finished.add(message.payload.runId);
      if (['heartbeat.run.status', 'issue.updated'].includes(message.type)) { dirty = true; void inspect(); }
    } catch (error) { settle(error); }
  };
  const onError = () => settle(new Error('Company event WebSocket error'));
  const onClose = () => settle(new Error('Company event WebSocket closed before completion'));
  socket.addEventListener('message', onMessage); socket.addEventListener('error', onError); socket.addEventListener('close', onClose);
  let onOpen;
  try {
    const opened = new Promise(resolve => { onOpen = resolve; socket.addEventListener('open', onOpen, { once: true }); });
    await Promise.race([opened, completion]);
    const started = await Promise.race([start(controller.signal), completion]);
    if (settled) return await completion;
    runId = started.run.id;
    if (!runId) throw new Error('Start returned no Graph run ID');
    if (dirty) void inspect();
    return await completion;
  } catch (error) { settle(error); return await completion; }
  finally {
    if (!settled) settle(new Error('Observer closed before completion'));
    socket.removeEventListener('message', onMessage); socket.removeEventListener('error', onError); socket.removeEventListener('close', onClose);
    socket.removeEventListener('open', onOpen);
    socket.close();
  }
}
