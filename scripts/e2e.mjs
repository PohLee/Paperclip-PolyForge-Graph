import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDir = resolve(root, '.e2e');
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const authOrigin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const pluginId = 'pohlee.polyforge-graph';
const sleep = ms => new Promise(done => setTimeout(done, ms));

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean))
    .map(value => value.split(';')[0]).join('; ');
}

async function http(method, path, { body, cookie, optional = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: authOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 300) }; }
  if (!response.ok && !optional) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return { status: response.status, data, cookie: cookieFrom(response) };
}

function inviteToken(text) {
  const match = text.match(/(?:https?:\/\/[^\s]+)?\/api\/invites\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:https?:\/\/[^\s]+)?\/invites\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:https?:\/\/[^\s]+)?\/invite\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:invite|token)\s*[:=]\s*([A-Za-z0-9_-]{20,})/i);
  if (!match) throw new Error('Could not find a bootstrap invite token in .e2e/bootstrap.txt');
  return match[1];
}

async function ownerSession() {
  await mkdir(stateDir, { recursive: true });
  const authPath = resolve(stateDir, 'auth.json');
  try {
    const prior = JSON.parse(await readFile(authPath, 'utf8'));
    const session = await http('GET', '/api/auth/get-session', { cookie: prior.cookie, optional: true });
    if (session.status === 200 && session.data?.user?.id) return prior;
  } catch { /* create the synthetic owner from the one-use local bootstrap invite */ }
  const bootstrap = await readFile(resolve(stateDir, 'bootstrap.txt'), 'utf8');
  const token = inviteToken(bootstrap);
  const suffix = Date.now().toString(36);
  const email = `polyforge-e2e-${suffix}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const signup = await http('POST', '/api/auth/sign-up/email', { body: { name: 'PolyForge E2E Owner', email, password } });
  let cookie = signup.cookie;
  if (!cookie) throw new Error('Paperclip signup did not return a session cookie');
  const accepted = await http('POST', `/api/invites/${token}/accept`, { body: { requestType: 'human' }, cookie });
  if (accepted.cookie) cookie = `${cookie}; ${accepted.cookie}`;
  assert.equal(accepted.data?.bootstrapAccepted, true);
  const session = await http('GET', '/api/auth/get-session', { cookie });
  const userId = session.data?.user?.id;
  assert.ok(userId, 'bootstrap owner session has no user ID');
  const auth = { email, password, cookie, userId };
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
  return auth;
}

async function waitFor(predicate, label, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await predicate();
    if (last) return last;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

export async function runE2E({ restart = true } = {}) {
  await waitFor(async () => {
    try {
      const health = await http('GET', '/api/health', { optional: true });
      return health.status === 200 && health.data?.status === 'ok';
    } catch { return false; }
  }, 'Paperclip readiness', 120_000);
  const auth = await ownerSession();
  const request = (method, path, body, optional = false) => http(method, path, { body, cookie: auth.cookie, optional });

  const existing = await request('GET', `/api/plugins/${pluginId}`, undefined, true);
  if (existing.status === 404) {
    await request('POST', '/api/plugins/install', { packageName: '/opt/polyforge/plugin', isLocalPath: true });
  } else assert.equal(existing.status, 200);
  await waitFor(async () => (await request('GET', `/api/plugins/${pluginId}`, undefined, true)).status === 200, 'plugin installation');

  const company = (await request('POST', '/api/companies', { name: `PolyForge E2E ${Date.now()}`, description: 'Isolated deterministic Graph integration fixture' })).data;
  assert.ok(company.id);
  const issue = (await request('POST', `/api/companies/${company.id}/issues`, {
    title: 'PolyForge E2E root', description: 'Deterministic local integration exercise; no production artifacts.', status: 'todo', priority: 'medium'
  })).data;
  assert.ok(issue.id);
  console.log(`E2E fixture company ${company.id}, root issue ${issue.id}`);
  const graphPath = `/api/plugins/${pluginId}/api/issues/${issue.id}/graph`;
  const command = (operation, fields = {}) => request('POST', graphPath, { operation, ...fields,
    idempotencyKey: `e2e:${operation}:${fields.graphId ?? fields.runId ?? fields.feature ?? 'config'}:${fields.mode ?? ''}:${fields.input?.fixture ?? ''}:${fields.nodeId ?? ''}` });
  const read = runId => request('GET', `${graphPath}?runId=${encodeURIComponent(runId)}`).then(value => value.data);

  const provision = (await command('provision', { reason: 'Create isolated deterministic E2E roles and skills' })).data;
  assert.equal(Object.keys(provision.roleBindings ?? {}).length, 11);
  assert.equal(provision.skills?.length, 5);
  await command('configure', {
    roleBindings: provision.roleBindings,
    userRoles: { [auth.userId]: ['product-owner', 'cpo', 'cto-caio', 'principal-engineer'] },
    reason: 'Bind synthetic owner to manual E2E gates'
  });
  const feature = `polyforge-e2e-${Date.now()}`;
  const baseline = (await command('product-decision', {
    feature, status: 'approved', outcome: 'Keep baseline fixture behavior',
    reason: 'Synthetic E2E product memory baseline', evidence: [{ kind: 'fixture_requirement', id: 'REQ-E2E-1' }]
  })).data.result;
  assert.ok(baseline.id);

  const completed = {};
  let designHandoff = null;
  let implementationHandoff = null;
  for (const graphId of ['ui-ux-design', 'implementation', 'verification']) {
    const input = {
      fixture: 'deterministic-docker-e2e',
      feature,
      versioned_requirement: { id: 'REQ-E2E-1', version: 'v1' },
      product_decision_refs: [baseline.id],
      productDecisionRefs: [baseline.id],
      ...(designHandoff ? { final_design_identity: designHandoff } : {}),
      ...(implementationHandoff ? { implementation_candidate: implementationHandoff } : {})
    };
    const payload = { graphId, mode: 'autonomous', input, actor: { kind: 'agent', id: 'forged-agent' } };
    const started = (await command('start', payload)).data;
    const retried = (await command('start', payload)).data;
    assert.equal(retried.run.id, started.run.id, 'duplicate start callback created another run');
    assert.equal(started.run.startedBy.kind, 'human', 'request body spoofed trusted host actor');
    const runId = started.run.id;
    console.log(`Started ${graphId} ${runId}`);
    const dashboard = await waitFor(async () => {
      const value = await read(runId);
      if (value.run?.status === 'completed') return value;
      if (value.run?.status && !['running', 'paused'].includes(value.run.status)) throw new Error(`${graphId} ended ${value.run.status}`);
      return null;
    }, `${graphId} completion`);
    const run = dashboard.run;
    assert.equal(run.packVersion, '0.1.0');
    assert.equal(run.graph.version, '0.1.0');
    const agentAttempts = Object.values(run.nodeStates).flatMap(state => state.attempts).filter(item => item.actor?.kind === 'agent');
    assert.ok(agentAttempts.length > 0 && agentAttempts.every(item => item.actor.executionId), `${graphId} had no real agent runs`);
    assert.ok(dashboard.decisions.some(item => item.actor?.kind === 'agent'), `${graphId} lacked an agent decision`);
    const heartbeatIds = [...new Set([
      ...agentAttempts.map(item => item.actor.executionId),
      ...dashboard.decisions.filter(item => item.actor?.kind === 'agent').map(item => item.actor.executionId)
    ].filter(Boolean))];
    for (const heartbeatId of heartbeatIds) {
      const heartbeat = (await request('GET', `/api/heartbeat-runs/${heartbeatId}`)).data;
      assert.equal(heartbeat.status, 'succeeded', `${graphId} callback came from a failed Paperclip heartbeat ${heartbeatId}`);
      assert.equal(heartbeat.companyId, company.id);
    }
    if (graphId === 'ui-ux-design') {
      assert.equal(run.nodeStates['minor-design'].attempts.length, 1, 'duplicate callbacks repeated an attempt');
      const artifact = run.nodeStates['minor-design'].artifacts.at(-1);
      const decision = dashboard.decisions.find(item => item.nodeId === 'minor-gate' && item.outcome === 'accept');
      assert.ok(artifact?.id && artifact.version && decision?.id);
      designHandoff = { artifactId: artifact.id, version: artifact.version, decisionId: decision.id };
    }
    if (graphId === 'implementation') {
      assert.deepEqual(run.input.final_design_identity, designHandoff);
      assert.equal(run.nodeStates['implementation-plan'].attempts.length, 2, 'rework did not restart plan');
      const candidate = ['backend', 'frontend'].flatMap(id => run.nodeStates[id].artifacts.map(artifact => ({ lane: id, kind: artifact.kind, artifactId: artifact.id, version: artifact.version })));
      const decision = dashboard.decisions.findLast(item => item.nodeId === 'implementation-gate' && item.outcome === 'accept');
      assert.ok(decision?.id && decision.evidence.some(item => item.kind === 'test_reports'));
      implementationHandoff = { artifacts: candidate, decisionId: decision.id, testReportEvidence: decision.evidence.find(item => item.kind === 'test_reports') };
    }
    if (graphId === 'verification') assert.deepEqual(run.input.implementation_candidate, implementationHandoff);
    completed[graphId] = runId;
    console.log(`Completed ${graphId} with ${agentAttempts.length} authenticated agent actions and ${heartbeatIds.length} successful Paperclip heartbeats`);
  }

  const waitingInput = { fixture: 'human-wait', feature, versioned_requirement: { id: 'REQ-E2E-WAIT', version: 'v1' }, product_decision_refs: [baseline.id], productDecisionRefs: [baseline.id] };
  const manual = (await command('start', { graphId: 'ui-ux-design', mode: 'manual', input: waitingInput })).data.run;
  const manualState = await read(manual.id);
  assert.ok(manualState.ready.some(node => node.id === 'classify-design'));
  assert.equal(manualState.run.nodeStates['classify-design'].attempts.length, 0);

  const human = (await command('start', { graphId: 'ui-ux-design', mode: 'manual', input: { ...waitingInput, fixture: 'human-decision' } })).data.run;
  await command('decide', {
    runId: human.id, nodeId: 'classify-design', outcome: 'none',
    reason: 'Synthetic owner explicitly classified this E2E change as no visual impact.',
    evidence: [
      { kind: 'versioned_requirement', id: 'REQ-E2E-WAIT', version: 'v1' },
      { kind: 'design_impact_rationale', id: 'E2E-NO-VISUAL-IMPACT' }
    ]
  });
  const humanState = await waitFor(async () => {
    const value = await read(human.id);
    return value.run?.status === 'completed' ? value : null;
  }, 'human classified design completion');
  assert.equal(humanState.run.status, 'completed');
  const humanDecision = humanState.decisions.find(item => item.nodeId === 'classify-design' && item.outcome === 'none');
  assert.equal(humanDecision?.actor.kind, 'human');
  assert.equal(humanDecision?.actor.id, auth.userId);
  assert.match(humanDecision?.reason ?? '', /explicitly classified/);

  const assisted = (await command('start', { graphId: 'verification', mode: 'assisted', input: { ...waitingInput, implementation_candidate: implementationHandoff } })).data.run;
  const assistedAtGate = await waitFor(async () => {
    const value = await read(assisted.id);
    return value.ready.some(node => node.id === 'acceptance-gate') ? value : null;
  }, 'assisted human acceptance gate');
  const priorQaAttempt = assistedAtGate.run.nodeStates.qa.attempts.at(-1);
  assert.ok(priorQaAttempt?.artifacts?.some(item => item.kind === 'qa_report'));
  const retriedQa = (await command('retry-node', {
    runId: assisted.id, nodeId: 'qa',
    reason: 'Synthetic owner requires a fresh QA run against the pinned candidate.'
  })).data;
  assert.equal(retriedQa.result.nextAttempt, 2);
  assert.equal(retriedQa.result.decision.actor.kind, 'human');
  assert.equal(retriedQa.result.decision.actor.id, auth.userId);
  const assistedAfterRetry = await waitFor(async () => {
    const value = await read(assisted.id);
    return value.ready.some(node => node.id === 'acceptance-gate') && value.run.nodeStates.qa.attempts.length === 2 ? value : null;
  }, 'human retry of QA and renewed assisted gate');
  assert.equal(assistedAfterRetry.run.nodeStates.qa.attempts[0].artifacts[0].id, priorQaAttempt.artifacts[0].id);
  assert.notEqual(assistedAfterRetry.run.nodeStates.qa.attempts[1].artifacts[0].id, priorQaAttempt.artifacts[0].id);
  const retryHeartbeatId = assistedAfterRetry.run.nodeStates.qa.attempts[1].actor.executionId;
  assert.equal((await request('GET', `/api/heartbeat-runs/${retryHeartbeatId}`)).data.status, 'succeeded');

  if (restart) {
    execFileSync('docker', ['compose', '-f', 'compose.e2e.yml', '-p', 'polyforge-graph-e2e', 'restart', 'paperclip'], { cwd: root, stdio: 'ignore' });
    await waitFor(async () => {
      try {
        const health = await http('GET', '/api/health', { optional: true });
        return health.status === 200 && health.data?.status === 'ok';
      } catch { return false; }
    }, 'Paperclip restart health', 120_000);
    for (const [graphId, runId] of Object.entries(completed)) {
      const value = await read(runId);
      assert.equal(value.run.status, 'completed');
      assert.equal(value.run.packVersion, '0.1.0');
      assert.equal(value.run.graph.id, graphId);
    }
    assert.ok((await read(manual.id)).ready.some(node => node.id === 'classify-design'));
    const afterAssisted = await read(assisted.id);
    assert.ok(afterAssisted.ready.some(node => node.id === 'acceptance-gate'));
    assert.equal(afterAssisted.run.nodeStates.qa.attempts.length, 2);
    assert.equal(afterAssisted.decisions.find(item => item.id === retriedQa.result.decision.id)?.reason, retriedQa.result.decision.reason);
    const afterHuman = await read(human.id);
    assert.equal(afterHuman.run.status, 'completed');
    assert.equal(afterHuman.decisions.find(item => item.id === humanDecision.id)?.actor.id, auth.userId);
  }

  const result = { companyId: company.id, issueId: issue.id, completed, manualRunId: manual.id, humanRunId: human.id, assistedRunId: assisted.id, restarted: restart };
  await writeFile(resolve(stateDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runE2E({ restart: !process.argv.includes('--no-restart') })
    .then(result => console.log(`Docker E2E passed: ${Object.keys(result.completed).join(', ')}; state saved in .e2e/result.json`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
