import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { alignOrganization } from '../src/plugin/alignment.mjs';

const base = 'http://localhost:3311';
const pluginId = 'pohlee.polyforge-graph';
const auth = JSON.parse(await readFile(new URL('../.e2e/real-auth.json', import.meta.url), 'utf8'));
const stateFile = new URL('../.e2e/real-graph.json', import.meta.url);
const briefFile = new URL('../examples/decision-register/BRIEF.md', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { state = {}; }

async function request(method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { Origin: base, Cookie: auth.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw.slice(0, 400) }; }
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status}: ${String(data?.error ?? data?.message ?? 'unknown').slice(0, 500)}`);
  return data;
}
async function save() { await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); }
const rootPath = () => `/api/plugins/${pluginId}/api/issues/${state.rootIssueId}/graph`;
const graph = (operation, body = {}) => request('POST', rootPath(), {
  operation, ...body, idempotencyKey: body.idempotencyKey ?? `real:${operation}:${randomUUID()}`,
});
const dashboard = (runId) => request('GET', `${rootPath()}?runId=${encodeURIComponent(runId)}`);

async function upgrade() {
  const result = await request('POST', `/api/plugins/${pluginId}/upgrade`, {});
  assert.equal(result.version, '0.6.0');
  console.log(JSON.stringify({ stage: 'upgraded', pluginVersion: result.version, status: result.status }));
}

async function setup() {
  assert.equal((await request('GET', '/api/health')).status, 'ok');
  const plugin = await request('GET', `/api/plugins/${pluginId}`);
  assert.equal(plugin.status, 'ready', 'The installed plugin must be ready');
  if (!state.companyId) {
    const company = await request('POST', '/api/companies', {
      name: 'Decision Register real ADLC',
      description: 'Isolated, bounded real Codex Sol/High Design → Implementation → Verification acceptance',
    });
    state.companyId = company.id;
    await save();
  }
  if (!state.projectId) {
    const project = await request('POST', `/api/companies/${state.companyId}/projects`, {
      name: 'Decision Register', description: 'Real local product decision register app',
    });
    state.projectId = project.id;
    await save();
  }
  if (!state.rootIssueId) {
    const issue = await request('POST', `/api/companies/${state.companyId}/issues`, {
      projectId: state.projectId,
      title: 'Build and verify Decision Register',
      description: [
        'Build the real local app specified in /workspace/decision-register/BRIEF.md.',
        'Follow your assigned PolyForge Graph node contract. Work only inside /workspace/decision-register.',
        'Design work must produce inspectable files under design/. Implementation must produce runnable src/ and test/. Verification must run the candidate tests and write reports/.',
        'Use the registered PolyForge Graph command tool with this issue ID and your pinned run/node IDs; read your child issue description and the scoped Graph GET first.',
        'Every artifact must reference a real file path and SHA-256 or equivalent immutable version. Do not claim unrun tests or fictitious sources. Keep the scope small and finish the assigned node.',
      ].join('\n\n'),
      status: 'todo', priority: 'medium',
    });
    state.rootIssueId = issue.id;
    await save();
  }
  if (!state.roleBindings) {
    const provision = await graph('provision', {
      reason: 'Authenticated owner provisions real ADLC roles and skills for the isolated Decision Register project',
    });
    assert.equal(Object.keys(provision.roleBindings ?? {}).length, 11);
    assert.ok(provision.skills?.length >= 11, 'Expected the mounted Pack skills to be provisioned');
    state.roleBindings = provision.roleBindings;
    await save();
  }
  if (!state.organizationAligned) {
    const { confirmation } = await alignOrganization({
      companyId: state.companyId, issueId: state.rootIssueId,
      command: (body) => request('POST', rootPath(), body),
      readAgent: (id) => request('GET', `/api/agents/${id}`),
      patchAgent: (id, reportsTo) => request('PATCH', `/api/agents/${id}`, { reportsTo }),
    });
    assert.equal(confirmation.aligned, true);
    state.organizationAligned = true;
    await save();
  }
  for (const [roleId, agentId] of Object.entries(state.roleBindings)) {
    if (state.configuredAgents?.[roleId]) continue;
    const current = await request('GET', `/api/agents/${agentId}`);
    assert.equal(current.companyId, state.companyId);
    const updated = await request('PATCH', `/api/agents/${agentId}`, {
      adapterType: 'codex_local',
      adapterConfig: {
        engine: 'cli', cwd: '/workspace/decision-register', model: 'gpt-6-sol',
        modelReasoningEffort: 'high', timeoutSec: 900,
        dangerouslyBypassApprovalsAndSandbox: true,
        extraArgs: ['--skip-git-repo-check'],
      },
      budgetMonthlyCents: 3000, status: 'idle',
    });
    assert.equal(updated.adapterType, 'codex_local');
    let active;
    for (let poll = 0; poll < 20; poll++) {
      active = await request('GET', `/api/agents/${agentId}`);
      if (active.status === 'idle') break;
      await sleep(250);
    }
    assert.equal(active.status, 'idle', `Managed ${roleId} did not resume after its profile update`);
    state.configuredAgents ??= {};
    state.configuredAgents[roleId] = agentId;
    await save();
  }
  if (!state.configured) {
    const config = await graph('configure', {
      roleBindings: state.roleBindings,
      userRoles: { [auth.userId]: ['human-owner', 'product-owner', 'cpo', 'cto-caio', 'principal-engineer'] },
      defaultMode: 'autonomous',
      reason: 'Bind isolated real model agents and authenticated owner for three-Graph acceptance',
    });
    assert.equal(config.defaultMode, 'autonomous');
    state.configured = true;
    await save();
  }
  if (!state.productDecisionId) {
    const decision = await graph('product-decision', {
      feature: 'decision-register', status: 'approved',
      outcome: 'Implement the versioned Decision Register brief; retain the reason requirement until an approved change request alters it',
      reason: 'The protected behavior and local acceptance checks are defined in BRIEF.md v1.',
      evidence: [{ kind: 'approved_requirement', id: 'REQ-DECISION-REGISTER-1', version: 'v1' }],
    });
    state.productDecisionId = decision.result.id;
    await save();
  }
  const brief = await readFile(briefFile);
  state.briefSha256 = sha256(brief);
  await save();
  console.log(JSON.stringify({ stage: 'setup', companyId: state.companyId, projectId: state.projectId,
    rootIssueId: state.rootIssueId, agents: Object.keys(state.roleBindings).length,
    productDecisionId: state.productDecisionId, briefSha256: state.briefSha256 }));
}

async function start(graphId) {
  assert.ok(state.companyId && state.rootIssueId && state.productDecisionId, 'Run setup first');
  const key = { 'ui-ux-design': 'designRunId', implementation: 'implementationRunId', verification: 'verificationRunId' }[graphId];
  assert.ok(key, 'Unknown graph');
  if (state[key]) { console.log(JSON.stringify({ graphId, runId: state[key], existing: true })); return; }
  if (graphId === 'implementation' || graphId === 'verification') {
    const { validateRealRun } = await import('./validate-real-run.mjs');
    const design = await validateRealRun('design', state.designRunId);
    if (state.designHandoff) assert.deepEqual(state.designHandoff, design.handoff);
    state.designHandoff = design.handoff;
    if (graphId === 'verification') {
      const implementation = await validateRealRun('implementation', state.implementationRunId);
      if (state.implementationHandoff) assert.deepEqual(state.implementationHandoff, implementation.handoff);
      state.implementationHandoff = implementation.handoff;
    }
    await save();
  }
  const architectureArg = process.argv.indexOf('--architecture-context');
  if (architectureArg !== -1) {
    assert.ok(process.argv[architectureArg + 1], '--architecture-context needs a JSON file path');
    state.architectureContext = JSON.parse(await readFile(process.argv[architectureArg + 1], 'utf8'));
    await save();
  }
  if (graphId === 'implementation') assert.ok(state.architectureContext,
    'Supply --architecture-context <JSON file> with an accepted baseline reference or a reviewed non-applicability rationale');
  const briefText = await readFile(briefFile, 'utf8');
  const acceptanceCriteria = (briefText.split('## Acceptance checks')[1]?.split('## Delivery boundaries')[0] ?? '')
    .split(/\r?\n/).filter(line => /^\d+\. /.test(line)).map((line, index) => ({
      id: `AC-${index + 1}`, description: line.replace(/^\d+\. /, ''), requirementIds: ['REQ-DECISION-REGISTER-1'] }));
  assert.equal(acceptanceCriteria.length, 6, 'Expected six checks in the reviewed brief');
  const input = {
    feature: 'decision-register',
    versioned_requirement: { id: 'REQ-DECISION-REGISTER-1', version: 'v1',
      path: 'BRIEF.md', sha256: state.briefSha256 },
    product_decision_refs: [state.productDecisionId], productDecisionRefs: [state.productDecisionId],
    workdir: '/workspace/decision-register',
    projectBrief: 'Read BRIEF.md and produce real, inspectable local artifacts. This is a new app, so design classification should reflect major work. Follow the pinned Graph contract and use the Paperclip Graph command tool.',
    ...(graphId === 'implementation' ? { final_design_identity: state.designHandoff, architecture_context: state.architectureContext } : {}),
    ...(graphId === 'verification' ? { final_design_identity: state.designHandoff,
      implementation_candidate: state.implementationHandoff, acceptance_criteria: acceptanceCriteria } : {}),
  };
  if (graphId !== 'ui-ux-design') assert.ok(state.designHandoff, 'Completed design handoff is required');
  if (graphId === 'verification') assert.ok(state.implementationHandoff, 'Completed implementation handoff is required');
  const result = await graph('start', { graphId, mode: graphId === 'verification' ? 'assisted' : 'autonomous',
    input, idempotencyKey: `real:start:${graphId}:v1` });
  const expectedVersion = graphId === 'implementation' ? '0.1.4' : graphId === 'verification' ? '0.1.3' : '0.1.2';
  assert.equal(result.run.packVersion, '0.1.9', 'New real Graph runs must use the final mounted Pack');
  assert.equal(result.run.graph.version, expectedVersion, 'New real Graph run has an unexpected definition');
  state[key] = result.run.id;
  state.runVersions ??= {};
  state.runVersions[{ 'ui-ux-design': 'design', implementation: 'implementation',
    verification: 'verification' }[graphId]] = {
    packVersion: result.run.packVersion, graphVersion: result.run.graph.version,
  };
  await save();
  console.log(JSON.stringify({ stage: 'started', graphId, runId: state[key], status: result.run.status,
    dispatch: result.dispatch }));
}

async function status() {
  if (process.argv.includes('--agents')) {
    for (const [roleId, agentId] of Object.entries(state.roleBindings ?? {})) {
      const agent = await request('GET', `/api/agents/${agentId}`);
      console.log(JSON.stringify({ roleId, agentId, status: agent.status,
        adapterType: agent.adapterType, budgetMonthlyCents: agent.budgetMonthlyCents,
        model: agent.adapterConfig?.model, reasoning: agent.adapterConfig?.modelReasoningEffort,
        cwd: agent.adapterConfig?.cwd, timeoutSec: agent.adapterConfig?.timeoutSec,
        sandboxBypass: agent.adapterConfig?.dangerouslyBypassApprovalsAndSandbox }));
    }
  }
  for (const [graphId, key] of Object.entries({ design: 'designRunId', implementation: 'implementationRunId', verification: 'verificationRunId' })) {
    if (!state[key]) continue;
    const value = await dashboard(state[key]);
    const run = value.run;
    console.log(JSON.stringify({ graphId, runId: run.id, packVersion: run.packVersion,
      graphVersion: run.graph.version, status: run.status,
      nodes: Object.entries(run.nodeStates).filter(([, node]) => node.status !== 'pending').map(([id, node]) =>
        ({ id, status: node.status, attempts: node.attempts.length })),
      dispatches: value.dispatches, pendingHuman: run.pendingHuman, blocked: value.blocked }));
    for (const item of value.dispatches ?? []) {
      if (!item.agentRunId) continue;
      const heartbeat = await request('GET', `/api/heartbeat-runs/${item.agentRunId}`);
      console.log(JSON.stringify({ heartbeatId: heartbeat.id, nodeId: item.nodeId,
        status: heartbeat.status, errorCode: heartbeat.errorCode, exitCode: heartbeat.exitCode,
        startedAt: heartbeat.startedAt, finishedAt: heartbeat.finishedAt }));
    }
  }
}

async function heartbeatInfo(id) {
  const info = await request('GET', `/api/heartbeat-runs/${id}`);
  console.log(JSON.stringify({ id, keys: Object.keys(info), status: info.status,
    errorCode: info.errorCode, exitCode: info.exitCode, error: info.error,
    costAccountingPending: info.costAccountingPending, costAccountedAt: info.costAccountedAt,
    accountingLastError: info.accountingLastError, accountingAttemptCount: info.accountingAttemptCount,
    accountingCaptureFailed: info.usageJson?.accountingCaptureFailed,
    accountingReceiptReady: info.usageJson?.accountingReceiptReady,
    accountingProviderWorkStarted: info.usageJson?.accountingProviderWorkStarted,
    providerWorkStarted: info.resultJson?.executionRecovery?.providerWorkStarted,
    livenessState: info.livenessState, scheduledRetryAt: info.scheduledRetryAt,
    lastOutputAt: info.lastOutputAt, lastEventAt: info.lastEventAt,
    currentStatusMessage: info.currentStatusMessage,
    currentToolName: info.currentToolName,
    logStore: info.logStore, logBytes: info.logBytes,
    usageReceiptSequence: info.usageJson?.accountingReceiptSequence,
    usageReceiptIdPresent: Boolean(info.usageJson?.accountingReceiptId),
    usageInputTokens: info.usageJson?.inputTokens,
    usageOutputTokens: info.usageJson?.outputTokens }));
}

async function agentRuns(roleId) {
  const id = state.roleBindings?.[roleId];
  assert.ok(id, 'Unknown role');
  const runs = await request('GET', `/api/companies/${state.companyId}/heartbeat-runs`);
  console.log(JSON.stringify(runs.filter(item => item.agentId === id)
    .map(item => ({ id: item.id, status: item.status, issueId: item.issueId,
      retryOfRunId: item.retryOfRunId, errorCode: item.errorCode,
      costAccountingPending: item.costAccountingPending, accountingReceiptReady: item.usageJson?.accountingReceiptReady,
      startedAt: item.startedAt, finishedAt: item.finishedAt }))));
}

async function heartbeatEvents(id) {
  const data = await request('GET', `/api/heartbeat-runs/${id}/events`);
  const events = Array.isArray(data) ? data : data.events ?? [];
  console.log(JSON.stringify({ heartbeatId: id, count: events.length,
    recent: events.slice(-20).map(item => ({
      eventType: item.eventType, type: item.type, stream: item.stream,
      toolName: item.toolName ?? item.payload?.toolName ?? item.payload?.name,
      level: item.level, createdAt: item.createdAt,
    })) }));
}

async function accountingHealth() {
  const health = await request('GET', `/api/companies/${state.companyId}/accounting/health`);
  const inspection = await request('GET', `/api/companies/${state.companyId}/accounting/inspect`);
  console.log(JSON.stringify({ pendingRunCount: health.pendingRunCount,
    oldestPendingAt: health.oldestPendingAt, heldReservationCents: health.heldReservationCents,
    items: health.items?.map(item => ({ runId: item.runId, agentId: item.agentId,
      state: item.state, attempts: item.attempts, lastError: item.lastError })),
    findings: inspection.findings?.map(item => ({ kind: item.kind, entityId: item.entityId,
      repairable: item.repairable })) }));
}

async function retryLostDesign() {
  assert.ok(state.designRunId, 'Design run is missing');
  const before = await dashboard(state.designRunId);
  const dispatch = before.dispatches?.find(item => item.nodeId === 'classify-design');
  assert.ok(dispatch?.agentRunId, 'No classify-design heartbeat to diagnose');
  const heartbeat = await request('GET', `/api/heartbeat-runs/${dispatch.agentRunId}`);
  assert.equal(heartbeat.status, 'failed');
  assert.equal(heartbeat.errorCode, 'process_lost');
  const result = await graph('retry-node', { runId: state.designRunId, nodeId: 'classify-design',
    reason: `Authenticated owner retries classify-design after Docker Desktop stopped; Paperclip heartbeat ${heartbeat.id} failed with process_lost. Preserve the failed first attempt.`,
    idempotencyKey: 'real:retry:classify:process-lost-1' });
  assert.equal(result.result?.nextAttempt, 2);
  state.classifyRetryDecisionId = result.result.decision.id;
  await save();
  console.log(JSON.stringify({ stage: 'retried-lost-host-run', oldHeartbeatId: heartbeat.id,
    graphRunId: state.designRunId, nextAttempt: result.result.nextAttempt,
    decisionId: state.classifyRetryDecisionId, dispatch: result.dispatch }));
}

async function stopTakeover() {
  const before = await dashboard(state.designRunId);
  const active = before.dispatches?.find(item => item.nodeId === 'classify-design' && item.attempt === 3);
  if (active?.agentRunId) {
    const heartbeat = await request('GET', `/api/heartbeat-runs/${active.agentRunId}`);
    if (['queued', 'running'].includes(heartbeat.status)) {
      const cancelled = await request('POST', `/api/heartbeat-runs/${heartbeat.id}/cancel`, {});
      console.log(JSON.stringify({ stage: 'cancelled-takeover-heartbeat', id: cancelled.id,
        status: cancelled.status, errorCode: cancelled.errorCode }));
    }
  }
  const original = state.originalProductOwnerAgentId;
  assert.ok(original && before.config.roleBindings['product-owner'] === state.activeProductOwnerAgentId);
  const restored = await graph('configure', {
    roleBindings: { ...before.config.roleBindings, 'product-owner': original },
    reason: 'Authenticated owner restores original Product Owner role after confirming that takeover would evade Paperclip’s pending-cost accounting budget guard. Preserve all failed/cancelled runs and the budget hold; no further dispatch until supported accounting recovery.',
    idempotencyKey: 'real:configure:restore-budget-held-product-owner-1',
  });
  assert.equal(restored.roleBindings['product-owner'], original);
  state.activeProductOwnerAgentId = original;
  state.takeoverStopped = true;
  await save();
  console.log(JSON.stringify({ stage: 'restored-original-binding', originalAgentId: original,
    graphRunId: state.designRunId, pendingHeartbeatId: active?.agentRunId }));
}

async function watch(graphId, maxMinutes = 30) {
  const key = { 'ui-ux-design': 'designRunId', implementation: 'implementationRunId', verification: 'verificationRunId' }[graphId];
  assert.ok(state[key], `Start ${graphId} first`);
  const deadline = Date.now() + maxMinutes * 60_000;
  let previous = '';
  while (Date.now() < deadline) {
    const value = await dashboard(state[key]);
    const run = value.run;
    const signal = JSON.stringify({ status: run.status,
      nodes: Object.entries(run.nodeStates).filter(([, node]) => node.status !== 'pending')
        .map(([id, node]) => `${id}:${node.status}:${node.attempts.length}`),
      dispatches: value.dispatches?.map((item) => `${item.nodeId}:${item.state}:${item.agentRunId}`),
      pendingHuman: run.pendingHuman });
    if (signal !== previous) { console.log(signal); previous = signal; }
    if (run.status === 'completed') {
      const { validateRealRun } = await import('./validate-real-run.mjs');
      const name = { 'ui-ux-design': 'design', implementation: 'implementation', verification: 'verification' }[graphId];
      const validated = await validateRealRun(name, state[key]);
      if (name === 'design') state.designHandoff = validated.handoff;
      if (name === 'implementation') state.implementationHandoff = validated.handoff;
      await save();
      return;
    }
    if (!['running', 'paused'].includes(run.status)) {
      throw new Error(`${graphId} ended ${run.status}; inspect the saved run and heartbeat before any recovery`);
    }
    await sleep(5000);
  }
  throw new Error(`${graphId} still active after ${maxMinutes} minutes; inspect status without restarting`);
}

const action = process.argv[2];
if (action === 'upgrade') await upgrade();
else if (action === 'setup') await setup();
else if (action === 'start-design') await start('ui-ux-design');
else if (action === 'start-implementation') await start('implementation');
else if (action === 'start-verification') await start('verification');
else if (action === 'status') await status();
else if (action === 'heartbeat') await heartbeatInfo(process.argv[3]);
else if (action === 'agent-runs') await agentRuns(process.argv[3]);
else if (action === 'events') await heartbeatEvents(process.argv[3]);
else if (action === 'accounting-health') await accountingHealth();
else if (action === 'retry-lost-design') await retryLostDesign();
else if (action === 'stop-takeover') await stopTakeover();
else if (action === 'watch') await watch(process.argv[3], Number(process.argv[4] ?? 30));
else throw new Error('Usage: node scripts/e2e-real.mjs upgrade|setup|start-design|start-implementation|start-verification|status|watch <graph-id> [minutes]');
