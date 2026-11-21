import assert from 'node:assert/strict';
import { fixtureContractInputs } from './fixture-contract-inputs.mjs';
import { manualReviewReady, assistedAcceptanceReady } from './e2e-gate-state.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localPack = (await import(pathToFileURL(resolve(root, '..', 'Paperclip-PolyForge-Graph-Packs', 'packs', 'adlc', 'index.mjs')).href)).pack;
const stateDir = resolve(root, process.env.POLYFORGE_E2E_STATE_DIR || '.e2e');
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const authOrigin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const pluginId = 'pohlee.polyforge-graph';
const sleep = ms => new Promise(done => setTimeout(done, ms));

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean))
    .map(value => value.split(';')[0]).join('; ');
}

async function http(method, path, { body, cookie, optional = false } = {}) {
  const retryable = method === 'GET' || Boolean(body?.idempotencyKey &&
    path.startsWith(`/api/plugins/${pluginId}/api/`) &&
    ['enable-pack', 'provision-pack', 'configure-organization', 'configure-shadow-policy',
      'configure', 'product-decision', 'start', 'decide', 'retry-node', 'dispatch'].includes(body.operation));
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (retryable && [502, 503].includes(response.status) && attempt < 2) {
      await sleep(250 * (attempt + 1));
      continue;
    }
    if (!response.ok && !optional) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
    return { status: response.status, data, cookie: cookieFrom(response) };
  }
}

function inviteToken(text) {
  const match = text.match(/(?:https?:\/\/[^\s]+)?\/api\/invites\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:https?:\/\/[^\s]+)?\/invites\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:https?:\/\/[^\s]+)?\/invite\/([A-Za-z0-9_-]+)/)
    ?? text.match(/(?:invite|token)\s*[:=]\s*([A-Za-z0-9_-]{20,})/i);
  if (!match) throw new Error(`Could not find a bootstrap invite token in ${resolve(stateDir, 'bootstrap.txt')}`);
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
  const project = (await request('POST', `/api/companies/${company.id}/projects`, {
    name: 'Deterministic Graph fixture', description: 'Isolated native project for bounded candidate review'
  })).data;
  assert.ok(project.id);
  const issue = (await request('POST', `/api/companies/${company.id}/issues`, {
    projectId: project.id, title: 'PolyForge E2E root', description: 'Deterministic local integration exercise; no production artifacts.', status: 'todo', priority: 'medium'
  })).data;
  assert.ok(issue.id);
  console.log(`E2E fixture company ${company.id}, root issue ${issue.id}`);
  const graphPath = `/api/plugins/${pluginId}/api/issues/${issue.id}/graph`;
  const command = (operation, fields = {}) => request('POST', graphPath, { operation, ...fields,
    idempotencyKey: `e2e:${operation}:${fields.graphId ?? fields.runId ?? fields.feature ?? 'config'}:${fields.mode ?? ''}:${fields.input?.fixture ?? ''}:${fields.nodeId ?? ''}` });
  const shadowRecoveryAt = new Map();
  const read = async runId => {
    const path = `${graphPath}?runId=${encodeURIComponent(runId)}`;
    let value = (await request('GET', path)).data;
    const run = value.run;
    if (run?.status === 'running' && run.mode !== 'manual' &&
        value.ready.some(node => node.shadow?.required && run.nodeStates[node.id]?.status === 'pending') &&
        Date.now() - (shadowRecoveryAt.get(runId) ?? 0) >= 5000) {
      shadowRecoveryAt.set(runId, Date.now());
      await command('dispatch', { runId,
        reason: 'Synthetic owner resumes required native Shadow review and its pending Graph assignment' });
      value = (await request('GET', path)).data;
    }
    return value;
  };
  const companyPath = `/api/plugins/${pluginId}/api/company`;
  const companyCommand = (operation, fields = {}) => request('POST', companyPath, {
    companyId: company.id, operation, ...fields,
    reason: `Configure isolated Docker fixture: ${operation}`,
    idempotencyKey: `e2e:${operation}:${company.id}:${localPack.id}:${localPack.version}`
  });
  const successfulHeartbeat = (heartbeatId, label) => waitFor(async () => {
    const heartbeat = (await request('GET', `/api/heartbeat-runs/${heartbeatId}`)).data;
    assert.equal(heartbeat.companyId, company.id);
    if (['queued', 'running'].includes(heartbeat.status)) return null;
    assert.equal(heartbeat.status, 'succeeded', `${label} callback came from a failed Paperclip heartbeat ${heartbeatId}`);
    return heartbeat;
  }, `${label} Paperclip heartbeat ${heartbeatId} success`);
  const completedGraph = async (runId, graphId) => {
    const startedAt = Date.now();
    // Implementation exercises a full rework, including fresh native execution
    // and independent review for each branch on both passes.
    const overallMs = graphId === 'implementation' ? 600_000 : 300_000;
    const idleMs = 120_000;
    let lastProgressAt = startedAt, lastProgress = null;
    while (true) {
      const value = await read(runId), run = value.run;
      const detail = { runId, status: run?.status, ready: value.ready?.map(node => node.id),
        nodes: Object.fromEntries(Object.entries(run?.nodeStates ?? {}).map(([id, state]) => [id, {
          status: state.status, attempts: state.attempts.length, artifacts: state.artifacts?.length ?? 0,
          selfReviews: state.attempts.reduce((count, attempt) => count + (attempt.selfReviews?.length ?? 0), 0)
        }])), decisions: value.decisions?.length ?? 0 };
      if (run?.status === 'completed') return value;
      if (run?.status && !['running', 'paused'].includes(run.status)) throw new Error(`${graphId} ended: ${JSON.stringify(detail)}`);
      const progress = JSON.stringify(detail);
      if (progress !== lastProgress) { lastProgressAt = Date.now(); lastProgress = progress; }
      const now = Date.now();
      if (now - startedAt >= overallMs || now - lastProgressAt >= idleMs) {
        throw new Error(`${graphId} ${now - lastProgressAt >= idleMs ? 'made no progress for 120 seconds' : 'exceeded overall completion deadline'}: ${progress}`);
      }
      await sleep(1500);
    }
  };

  await companyCommand('enable-pack', { packId: localPack.id, version: localPack.version });
  const provision = (await companyCommand('provision-pack', { packId: localPack.id, version: localPack.version })).data;
  assert.deepEqual(Object.keys(provision.roleBindings ?? {}).filter(key => key !== 'ceo').sort(),
    Object.keys(localPack.roles).map(roleId => `${localPack.id}:${roleId}`).sort(),
    'managed role bindings must match the current Pack declarations exactly');
  assert.ok(provision.ceo?.agentId, 'company provisioning must return its managed CEO');
  assert.equal(provision.roleBindings.ceo, provision.ceo.agentId);
  assert.equal(provision.skills?.length, Object.keys(localPack.skills).length);
  await command('configure', {
    roleBindings: provision.roleBindings,
    userRoles: { [auth.userId]: [`${localPack.id}:cpo`] },
    reason: 'Bind synthetic owner to manual E2E gates'
  });
  await companyCommand('configure-organization', { derive: true });
  await companyCommand('configure-shadow-policy', { policy: { enabled: true, allowSameAgent: true,
    allowAgentTrigger: false, allowGraphTrigger: true, maxDurationSeconds: 120, allowedAdapterTypes: ['process'] } });
  const feature = `polyforge-e2e-${Date.now()}`;
  const baseline = (await command('product-decision', {
    feature, status: 'approved', outcome: 'Keep baseline fixture behavior',
    reason: 'Synthetic E2E product memory baseline', evidence: [{ kind: 'fixture_requirement', id: 'REQ-E2E-1' }]
  })).data.result;
  assert.ok(baseline.id);

  const completed = {};
  // The current Pack has retired visual design. This local fixture explicitly
  // supplies its no-visual-impact identity; it is not an accepted design Graph.
  const designHandoff = { artifactId: 'E2E-NO-VISUAL-IMPACT', version: 'v1', fixture: true };
  let implementationHandoff = null;
  for (const graphId of ['request-triage', 'implementation', 'verification']) {
    const input = {
      ...fixtureContractInputs(graphId, 'REQ-E2E-1'),
      fixture: 'deterministic-docker-e2e',
      feature,
      versioned_requirement: { id: 'REQ-E2E-1', version: 'v1' },
      product_decision_refs: [baseline.id],
      productDecisionRefs: [baseline.id],
      ...(graphId === 'request-triage' ? { source_request: { id: issue.id, version: 'v1' } } : {}),
      final_design_identity: designHandoff,
      ...(implementationHandoff ? { implementation_candidate: implementationHandoff } : {})
    };
    const payload = { graphId, mode: 'autonomous', input, actor: { kind: 'agent', id: 'forged-agent' } };
    const started = (await command('start', payload)).data;
    const retried = (await command('start', payload)).data;
    assert.equal(retried.run.id, started.run.id, 'duplicate start callback created another run');
    assert.equal(started.run.startedBy.kind, 'human', 'request body spoofed trusted host actor');
    const runId = started.run.id;
    console.log(`Started ${graphId} ${runId}`);
    const dashboard = await completedGraph(runId, graphId);
    const run = dashboard.run;
    assert.equal(run.packVersion, localPack.version);
    assert.equal(run.graph.version, localPack.graphs.find(graph => graph.id === graphId).version);
    const agentAttempts = Object.values(run.nodeStates).flatMap(state => state.attempts).filter(item => item.actor?.kind === 'agent');
    assert.ok(agentAttempts.length > 0 && agentAttempts.every(item => item.actor.executionId), `${graphId} had no real agent runs`);
    assert.ok(dashboard.decisions.some(item => item.actor?.kind === 'agent'), `${graphId} lacked an agent decision`);
    const heartbeatIds = [...new Set([
      ...agentAttempts.map(item => item.actor.executionId),
      ...dashboard.decisions.filter(item => item.actor?.kind === 'agent').map(item => item.actor.executionId)
    ].filter(Boolean))];
    for (const heartbeatId of heartbeatIds) {
      await successfulHeartbeat(heartbeatId, graphId);
    }
    if (graphId === 'request-triage') {
      assert.equal(run.nodeStates['assess-request'].attempts.length, 1, 'duplicate callbacks repeated an attempt');
      assert.ok(run.nodeStates['assess-request'].artifacts.some(item => item.kind === 'request_brief'));
      assert.ok(dashboard.decisions.some(item => item.nodeId === 'triage-disposition' && item.outcome === 'needs-info'));
    }
    if (graphId === 'implementation') {
      assert.deepEqual(run.input.final_design_identity, designHandoff);
      assert.equal(run.nodeStates['implementation-plan'].attempts.length, 2, 'rework did not restart plan');
      const candidate = run.nodeStates['integrate-candidate'].artifacts.filter(item => item.kind === 'implementation_candidate')
        .map(artifact => ({ kind: artifact.kind, artifactId: artifact.id, version: artifact.version }));
      const decision = dashboard.decisions.findLast(item => item.nodeId === 'implementation-gate' && item.outcome === 'accept');
      assert.ok(decision?.id && decision.evidence.some(item => item.kind === 'test_reports'));
      implementationHandoff = { artifacts: candidate, decisionId: decision.id, testReportEvidence: decision.evidence.find(item => item.kind === 'test_reports') };
    }
    if (graphId === 'verification') {
      assert.deepEqual(run.input.implementation_candidate, implementationHandoff);
      const companyState = (await request('GET', `${companyPath}?companyId=${company.id}`)).data;
      const shadow = companyState.control.shadows.find(item => item.parentRunId === runId && item.parentTaskId === 'qa' &&
        item.requestedBy?.kind === 'system' && item.requestedBy.roles?.includes('shadow-orchestrator'));
      assert.equal(shadow?.status, 'closed', 'QA requires a completed native Shadow review');
      assert.equal(shadow.outcome, 'completed');
      assert.equal(shadow.reviewResult?.verdict, 'accept');
      assert.ok(shadow.reviewResult.candidateRefs.length > 0);
      const candidates = Object.values(run.nodeStates).flatMap(state => state.artifacts ?? []);
      for (const ref of shadow.reviewResult.candidateRefs) {
        assert.match(ref.digest, /^sha256:[a-f0-9]{64}$/);
        assert.ok(candidates.some(item => item.id === ref.id && item.version === ref.version && item.digest === ref.digest));
      }
      const qaExecutionId = run.nodeStates.qa.attempts[0].actor.executionId;
      assert.notEqual(shadow.executionId, qaExecutionId, 'Shadow must run in a distinct native execution');
      const shadowHeartbeat = await successfulHeartbeat(shadow.executionId, 'independent Shadow');
      assert.equal(shadowHeartbeat.agentId, provision.roleBindings['adlc:qa-engineer']);
      const qaHeartbeat = await successfulHeartbeat(qaExecutionId, 'QA after independent Shadow');
      assert.ok(Date.parse(shadow.closedAt) <= Date.parse(qaHeartbeat.startedAt), 'Shadow must close before QA starts');
    }
    completed[graphId] = runId;
    console.log(`Completed ${graphId} with ${agentAttempts.length} authenticated agent actions and ${heartbeatIds.length} successful Paperclip heartbeats`);
  }

  // These runs share the root issue's Delivery, so retain its pinned goal and
  // acceptance boundary while testing the human control modes.
  const waitingInput = { fixture: 'human-wait', feature, versioned_requirement: { id: 'REQ-E2E-1', version: 'v1' }, product_decision_refs: [baseline.id], productDecisionRefs: [baseline.id] };
  const manual = (await command('start', { graphId: 'request-triage', mode: 'manual', input: {
    ...waitingInput, source_request: { id: issue.id, version: 'v1' }
  } })).data.run;
  const assertManualReview = value => {
    assert.equal(value.run.status, 'running');
    assert.equal(value.run.mode, 'manual');
    const assessment = value.run.nodeStates['assess-request'];
    assert.equal(assessment.status, 'awaiting_supervisor_review');
    assert.equal(assessment.attempts.length, 1);
    assert.ok(assessment.artifacts.length > 0);
    assert.equal(assessment.attempts[0].supervisorReview, null);
    assert.ok(value.work.some(item => item.nodeId === 'assess-request' && item.phase === 'supervisor' &&
      item.kind === 'human' && item.operation === 'review'));
    assert.equal(value.run.nodeStates['triage-disposition'].attempts.length, 0);
  };
  // Manual mode still dispatches task work. Its first stable human boundary is
  // the required independent assessment review, before the routing decision.
  const manualState = await waitFor(async () => {
    const value = await read(manual.id);
    return manualReviewReady(value) ? value : null;
  }, 'manual human assessment review');
  await successfulHeartbeat(manualState.run.nodeStates['assess-request'].attempts[0].actor.executionId, 'manual assessment');
  assertManualReview(manualState);

  const human = (await command('start', { graphId: 'verification', mode: 'assisted', input: {
    ...waitingInput, fixture: 'human-decision', ...fixtureContractInputs('verification', 'REQ-E2E-1'),
    implementation_candidate: implementationHandoff
  } })).data.run;
  const humanAtGate = await waitFor(async () => {
    const value = await read(human.id);
    return assistedAcceptanceReady(value) ? value : null;
  }, 'authenticated human acceptance gate');
  assert.equal(assistedAcceptanceReady(humanAtGate), true);
  const humanGate = humanAtGate.run.graph.nodes.find(node => node.id === 'acceptance-gate');
  const humanSubjects = humanGate.candidateNodes.flatMap(nodeId => humanAtGate.run.nodeStates[nodeId].artifacts)
    .filter(item => humanGate.candidateKinds.includes(item.kind))
    .map(item => ({ artifactId: item.id, version: item.version }));
  const humanRule = humanAtGate.run.pack.decisionRules.find(rule => rule.type === humanGate.decisionType && rule.mode === 'assisted');
  await command('decide', {
    runId: human.id, nodeId: 'acceptance-gate', outcome: 'accept',
    reason: 'Synthetic owner explicitly accepted the pinned E2E candidate and its observed fixture checks.',
    evidence: humanRule.requiredEvidence.map(kind => ({ kind, subjectRefs: humanSubjects }))
  });
  const humanState = await completedGraph(human.id, 'verification');
  assert.equal(humanState.run.status, 'completed');
  const humanDecision = humanState.decisions.find(item => item.nodeId === 'acceptance-gate' && item.outcome === 'accept');
  assert.equal(humanDecision?.actor.kind, 'human');
  assert.equal(humanDecision?.actor.id, auth.userId);
  assert.match(humanDecision?.reason ?? '', /explicitly accepted/);

  const assisted = (await command('start', { graphId: 'verification', mode: 'assisted', input: { ...waitingInput, ...fixtureContractInputs('verification', 'REQ-E2E-1'), implementation_candidate: implementationHandoff } })).data.run;
  const assertAssistedGate = value => {
    assert.equal(value.run.status, 'running');
    assert.equal(value.run.mode, 'assisted');
    assert.equal(value.run.nodeStates['acceptance-gate'].status, 'pending');
    assert.equal(value.run.nodeStates.qa.status, 'completed');
    assert.ok(value.ready.some(node => node.id === 'acceptance-gate'));
    assert.ok(value.work.some(item => item.nodeId === 'acceptance-gate' && item.kind === 'human' && item.operation === 'decide'));
    assert.equal(value.run.nodeStates['acceptance-gate'].attempts.length, 0);
  };
  const assistedAtGate = await waitFor(async () => {
    const value = await read(assisted.id);
    return assistedAcceptanceReady(value) ? value : null;
  }, 'assisted human acceptance gate');
  assertAssistedGate(assistedAtGate);
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
    return assistedAcceptanceReady(value) && value.run.nodeStates.qa.attempts.length === 2 ? value : null;
  }, 'human retry of QA and renewed assisted gate');
  assertAssistedGate(assistedAfterRetry);
  assert.equal(assistedAfterRetry.run.nodeStates.qa.attempts[0].artifacts[0].id, priorQaAttempt.artifacts[0].id);
  assert.notEqual(assistedAfterRetry.run.nodeStates.qa.attempts[1].artifacts[0].id, priorQaAttempt.artifacts[0].id);
  const retryHeartbeatId = assistedAfterRetry.run.nodeStates.qa.attempts[1].actor.executionId;
  await successfulHeartbeat(retryHeartbeatId, 'retried QA');

  if (restart) {
    execFileSync('docker', ['compose', ...(process.env.COMPOSE_FILE ? [] : ['-f', 'compose.e2e.yml']),
      '-p', process.env.COMPOSE_PROJECT_NAME || 'polyforge-graph-e2e', 'restart', 'paperclip'], { cwd: root, stdio: 'ignore' });
    await waitFor(async () => {
      try {
        const health = await http('GET', '/api/health', { optional: true });
        return health.status === 200 && health.data?.status === 'ok';
      } catch { return false; }
    }, 'Paperclip restart health', 120_000);
    for (const [graphId, runId] of Object.entries(completed)) {
      const value = await read(runId);
      assert.equal(value.run.status, 'completed');
      assert.equal(value.run.packVersion, localPack.version);
      assert.equal(value.run.graph.id, graphId);
    }
    const afterManual = await waitFor(async () => {
      const value = await read(manual.id);
      return manualReviewReady(value) ? value : null;
    }, 'restored manual human assessment review');
    assertManualReview(afterManual);
    assert.deepEqual(afterManual.run.nodeStates['assess-request'], manualState.run.nodeStates['assess-request'],
      'restart changed the pending manual review or its pinned assessment');
    const afterAssisted = await waitFor(async () => {
      const value = await read(assisted.id);
      return assistedAcceptanceReady(value) && value.run.nodeStates.qa.attempts.length === 2 ? value : null;
    }, 'restored assisted human acceptance gate');
    assertAssistedGate(afterAssisted);
    assert.equal(afterAssisted.run.nodeStates.qa.attempts.length, 2);
    assert.deepEqual(afterAssisted.run.nodeStates.qa.attempts, assistedAfterRetry.run.nodeStates.qa.attempts,
      'restart changed the completed QA retry history');
    assert.equal(afterAssisted.decisions.find(item => item.id === retriedQa.result.decision.id)?.reason, retriedQa.result.decision.reason);
    const afterHuman = await read(human.id);
    assert.equal(afterHuman.run.status, 'completed');
    assert.equal(afterHuman.decisions.find(item => item.id === humanDecision.id)?.actor.id, auth.userId);
  }

  const result = { companyId: company.id, projectId: project.id, issueId: issue.id, completed, manualRunId: manual.id, humanRunId: human.id, assistedRunId: assisted.id, restarted: restart };
  await writeFile(resolve(stateDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runE2E({ restart: !process.argv.includes('--no-restart') })
    .then(result => console.log(`Docker E2E passed: ${Object.keys(result.completed).join(', ')}; state saved in ${resolve(stateDir, 'result.json')}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
