// Runs inside the official isolated Host image. Every generated artifact is synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const base = 'http://127.0.0.1:3100', pluginId = 'pohlee.polyforge-graph';
const evidencePath = '/paperclip/workflow-composition-evidence.json';
const gatewayToken = process.env.POLYFORGE_CREATIVE_E2E_TOKEN;
const gatewayPort = Number(process.env.POLYFORGE_CREATIVE_E2E_PORT || 3218);
const selectedPack = process.env.POLYFORGE_COMPOSITION_PACK || null;
assert.ok(selectedPack === null || ['adlc', 'marketing', 'creative-team'].includes(selectedPack), 'Unknown fixture Pack filter');
const expected = [
  { id: 'adlc', version: '0.3.3', graphs: [
    { id: 'system-architecture-workflow', version: '1.0.0', input: { system_id: 'synthetic-orders', architecture_brief: 'Synthetic example: isolate order writes behind one service and document its invariants.' }, manualGate: true },
    { id: 'architecture-review-composed', version: '1.0.0', input: { system_id: 'synthetic-billing', architecture_brief: 'Synthetic composed example: separate invoice writes from payment capture.' }, manualGate: true, child: true },
    { id: 'code-delivery-workflow', version: '1.0.0', input: { implementation_candidate: { artifacts: [{ artifactId: 'fixture-candidate', version: 'v1' }] },
      delivery_target: { repository: 'fixture/local', prUrl: 'https://example.invalid/fixture/1', headSha: 'a'.repeat(40) },
      required_checks: ['fixture-check'], required_approvals: 1 } },
  ] },
  { id: 'marketing', version: '0.0.5', graphs: [{ id: 'acquisition-readiness-review', version: '1.0.0', input: {
    product: 'Synthetic inventory forecasting for independent grocers', audience: 'Synthetic operations leads',
    objective: 'Test qualified demo interest', constraints: ['No spend or public claims without owner approval'] }, child: true }] },
  { id: 'creative-team', version: '0.3.3', graphs: [{ id: 'brand-foundation-composed', version: '1.0.0', input: {
    brandName: 'Northstar Fixture', category: 'Team scheduling software', targetAudience: 'Operations leads at distributed service teams',
    brandPromise: 'Make shift changes clear and dependable', proofPoints: ['Synthetic point: review coverage before publishing', 'Synthetic point: retain a change history'] }, child: true }] },
];
const evidence = { fixture: 'synthetic-local-process-agents', hostImage: 'ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da', expected, stages: [] };
const runToIssue = new Map();
const companyRoots = new Map();

async function record(stage, details = {}) {
  evidence.stages.push({ stage, ...details });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage, ...details }));
}
async function call(method, path, body, { allowError = false, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { Origin: base,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await response.text(); let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok && !allowError) throw new Error(`${method} ${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}
const pluginIssuePath = issueId => `/api/plugins/${pluginId}/api/issues/${issueId}/graph`;
const readRun = async (issueId, runId) => (await call('GET', `${pluginIssuePath(issueId)}?runId=${encodeURIComponent(runId)}`)).data;

async function resolveRunIssue(companyId, runId) {
  if (runToIssue.has(runId)) return runToIssue.get(runId);
  for (const [rootRunId, issueId] of companyRoots.get(companyId) ?? []) {
    const root = await readRun(issueId, rootRunId).catch(() => null);
    if (!root?.run) continue;
    const seen = new Set(); const pending = [root.run];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current.id)) continue;
      seen.add(current.id); runToIssue.set(current.id, issueId);
      if (current.id === runId) return issueId;
      for (const childId of Object.values(current.nodeStates ?? {}).map(state => state.childRunId).filter(Boolean)) {
        if (seen.has(childId)) continue;
        const child = await readRun(issueId, childId).catch(() => null);
        if (child?.run) pending.push(child.run);
      }
    }
  }
  return null;
}

function evidenceArtifacts(dashboard) {
  const rows = [];
  for (const [nodeId, state] of Object.entries(dashboard.run.nodeStates ?? {})) {
    for (const artifact of state.artifacts ?? []) {
      const payload = state.output?.creativeArtifacts?.[artifact.kind] ?? state.output?.[artifact.kind] ??
        state.attempts?.at(-1)?.output?.creativeArtifacts?.[artifact.kind] ?? state.attempts?.at(-1)?.output?.[artifact.kind];
      if (artifact.id && artifact.version && payload && payload.id === artifact.id && payload.version === artifact.version) {
        rows.push({ nodeId, artifact, payload });
      }
    }
  }
  return rows;
}

async function createCreativeGateway() {
  if (!gatewayToken) throw new Error('POLYFORGE_CREATIVE_E2E_TOKEN is required for the loopback-only Creative fixture gateway');
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers.authorization !== `Bearer ${gatewayToken}`) return send(403, { protocol: 'polyforge-creative-host-v1', error: 'fixture gateway token rejected' });
    if (request.url === '/v1/creative/capabilities') return send(200, { protocol: 'polyforge-creative-host-v1', result: {
      services: ['resolveDecisionEvidence'], imageProviderIds: [], imageDecoder: false } });
    if (request.url !== '/v1/creative/evidence/resolve') return send(404, { protocol: 'polyforge-creative-host-v1', error: 'unsupported fixture operation' });
    try {
      if (typeof input.companyId !== 'string' || typeof input.runId !== 'string' || !Array.isArray(input.requiredKinds)) throw new Error('Evidence request identity is incomplete');
      const issueId = await resolveRunIssue(input.companyId, input.runId);
      if (!issueId) throw new Error('Requested workflow run is not linked to a registered root issue');
      const dashboard = await readRun(issueId, input.runId);
      if (dashboard.run?.id !== input.runId || dashboard.run.input?.paperclipCompanyId !== input.companyId ||
          dashboard.run.graph?.id !== input.graphId) throw new Error('Persisted workflow run scope does not match the evidence request');
      const sourceKind = { brand_strategy: 'brand_strategy', brand_identity_system: 'brand_identity_system',
        brand_voice_system: 'brand_voice_system', evidence_quality: 'brand_evidence_ledger', review_findings: 'brand_foundation_review' };
      const actual = evidenceArtifacts(dashboard);
      const resolved = input.requiredKinds.map(kind => {
        const expectedKind = sourceKind[kind] ?? kind;
        const source = [...actual].reverse().find(item => item.artifact.kind === expectedKind);
        if (!source) throw new Error(`No persisted ${expectedKind} artifact can support required evidence ${kind}`);
        const ref = { id: source.artifact.id, version: source.artifact.version, kind: source.artifact.kind };
        return { kind, payload: source.payload, sourceRef: ref, subjectRefs: [ref] };
      });
      send(200, { protocol: 'polyforge-creative-host-v1', companyId: input.companyId, result: resolved });
    } catch (error) { send(409, { protocol: 'polyforge-creative-host-v1', error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(gatewayPort, '127.0.0.1', resolve); });
  return server;
}

async function workflowTree(issueId, runId, seen = new Set()) {
  if (seen.has(runId)) return [];
  seen.add(runId);
  const dashboard = await readRun(issueId, runId); runToIssue.set(runId, issueId);
  const result = [{ dashboard, issueId }];
  for (const childId of Object.values(dashboard.run.nodeStates ?? {}).map(state => state.childRunId).filter(Boolean)) {
    result.push(...await workflowTree(issueId, childId, seen));
  }
  return result;
}

async function failedDispatch(companyId, runIds) {
  const issues = (await call('GET', `/api/companies/${companyId}/issues`)).data;
  for (const issue of issues) {
    if (!runIds.some(id => issue.originId?.startsWith(`${id}:`)) || issue.status !== 'blocked') continue;
    const detail = (await call('GET', `/api/issues/${issue.id}`)).data;
    const hostRunId = detail.executionBlocker?.runId ?? issue.interruption?.observedRunId ?? issue.activeRun?.id ?? issue.executionRunId;
    let heartbeat = null, log = null;
    if (hostRunId) {
      heartbeat = (await call('GET', `/api/heartbeat-runs/${hostRunId}`, undefined, { allowError: true })).data;
      log = (await call('GET', `/api/heartbeat-runs/${hostRunId}/log`, undefined, { allowError: true })).data;
    }
    return { issue: issue.identifier ?? issue.id, title: issue.title, hostRunId,
      heartbeat: heartbeat ? { status: heartbeat.status, error: heartbeat.error, exitCode: heartbeat.exitCode,
        startedAt: heartbeat.startedAt, finishedAt: heartbeat.finishedAt, stderr: heartbeat.resultJson?.stderr } : null,
      log: typeof log?.content === 'string' ? log.content.slice(-6000) : log };
  }
  return null;
}

export async function rejectHumanGateAsWrongAgent(companyId, tree, issueId, runId, item, wrongAgent, recordStage = record) {
  const execution = tree.flatMap(row => Object.values(row.dashboard.run.nodeStates ?? {}).flatMap(state => state.attempts ?? []))
    .find(attempt => attempt.actor?.kind === 'agent' && attempt.actor.executionId);
  if (!execution) throw new Error('Cannot exercise human-gate denial: no authenticated Agent execution is available as a negative-test run binding');
  const path = pluginIssuePath(issueId), before = await readRun(issueId, runId);
  const currentItem = before.work.find(work => work.kind === 'human' && work.operation === item.operation && work.nodeId === item.nodeId);
  if (!currentItem) throw new Error('The human work item changed before the authorization probe');
  const result = await call('POST', path, { operation: item.operation, runId, nodeId: item.nodeId,
    ...(item.operation === 'resolve-human-gate' ? { expectedDecisionId: before.run.pendingHuman.escalationDecisionId,
      expectedRunDigest: before.runDigest } : {}),
    outcome: currentItem.outcomes?.[0] ?? 'accept', reason: 'Wrong Agent credential must not resolve a human decision.',
    idempotencyKey: `composition-wrong-agent-human-gate:${runId}:${item.nodeId}` }, { allowError: true,
      headers: { Authorization: `Bearer ${wrongAgent.key}`, 'X-Paperclip-Run-Id': execution.actor.executionId } });
  const after = await readRun(issueId, runId);
  assert.ok([401, 403].includes(result.status), `wrong Agent was not denied authorization: HTTP ${result.status}`);
  assert.deepEqual(after.run, before.run, 'wrong Agent credential changed human-gated Graph state');
  assert.deepEqual(after.decisions, before.decisions, 'wrong Agent credential changed human-gated decisions');
  await recordStage('wrong-agent-human-gate-denied', { runId, nodeId: item.nodeId, wrongAgentId: wrongAgent.id,
    hostAgentRunId: execution.actor.executionId, status: result.status, unchanged: true });
}

export async function resolvePendingHuman(companyId, issueId, runId, dashboard, wrongAgent, recordStage = record) {
  const item = (dashboard.work ?? []).find(work => work.kind === 'human' && ['resolve-human-gate', 'decide', 'review'].includes(work.operation));
  if (!item) return false;
  const tree = await workflowTree(issueId, runId);
  await rejectHumanGateAsWrongAgent(companyId, tree, issueId, runId, item, wrongAgent, recordStage);
  // Prepare the owner's outcome, evidence and preconditions from the same displayed work item.
  const target = dashboard;
  const rule = target.run.pack.decisionRules.find(entry => entry.type === target.run.graph.nodes.find(node => node.id === item.nodeId)?.decisionType && entry.mode === target.run.mode);
  const refs = (item.operation === 'review' ? target.run.nodeStates[item.nodeId].artifacts :
    Object.values(target.run.nodeStates).flatMap(state => state.artifacts ?? []))
    .map(artifact => ({ artifactId: artifact.id, version: artifact.version }));
  if (!refs.length) throw new Error(`Human gate ${item.nodeId} has no persisted artifact references`);
  const operation = item.operation;
  const evidenceRows = operation === 'review'
    ? ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({ kind, subjectRefs: refs }))
    : (rule?.requiredEvidence ?? []).map(kind => ({ kind, subjectRefs: refs }));
  const authorized = await call('POST', pluginIssuePath(issueId), { operation, runId, nodeId: item.nodeId,
    ...(operation === 'resolve-human-gate' ? { expectedDecisionId: target.run.pendingHuman.escalationDecisionId,
      expectedRunDigest: target.runDigest } : {}),
    outcome: item.outcomes.includes('accept') ? 'accept' : item.outcomes[0],
    reason: 'Authenticated local owner reviewed the synthetic proposal and its persisted fixture artifact references.', evidence: evidenceRows,
    idempotencyKey: `composition-local-owner-human-gate:${runId}:${item.nodeId}` });
  await recordStage(operation === 'review' ? 'local-owner-review-resolved' : 'local-owner-human-gate-resolved', { runId, nodeId: item.nodeId,
    result: authorized.data.result?.status ?? 'accepted', operation: 'official-local-owner-command' });
  return true;
}

async function waitForWorkflow(companyId, issueId, reference, initialHandle, wrongAgent) {
  const deadline = Date.now() + 600_000;
  let lastTree = [];
  while (Date.now() < deadline) {
    lastTree = await workflowTree(issueId, initialHandle.runId);
    const failed = await failedDispatch(companyId, lastTree.map(row => row.dashboard.run.id));
    if (failed) throw new Error(`Blocked dispatch: ${JSON.stringify(failed)}`);
    let handledHuman = false;
    for (const row of lastTree) {
      if (row.dashboard.work?.some(item => item.kind === 'human' && ['resolve-human-gate', 'decide', 'review'].includes(item.operation))) {
        await resolvePendingHuman(companyId, issueId, row.dashboard.run.id, row.dashboard, wrongAgent);
        handledHuman = true;
      }
    }
    const root = lastTree[0].dashboard;
    if (root.run.status === 'completed') {
      const inspected = (await call('POST', pluginIssuePath(issueId), { operation: 'workflow-inspect', runId: initialHandle.runId })).data.handle;
      assert.equal(inspected.status, 'completed'); assert.deepEqual(inspected.workflow, reference);
      assert.ok(inspected.output && Object.keys(inspected.output).length, 'completed workflow returned no validated output');
      return { dashboard: root, tree: lastTree, handle: inspected };
    }
    if (['failed', 'stopped', 'blocked'].includes(root.run.status)) throw new Error(`Workflow ${reference.graphId} ended ${root.run.status}`);
    const blocked = lastTree.flatMap(row => row.dashboard.work ?? []).find(item => item.kind === 'blocked');
    if (blocked) throw new Error(`Workflow ${reference.graphId} is blocked at ${blocked.nodeId}: ${blocked.reason}`);
    if (!handledHuman) await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw new Error(`Workflow deadline exceeded for ${reference.graphId}; last tree: ${JSON.stringify(lastTree.map(row => ({
    runId: row.dashboard.run.id, status: row.dashboard.run.status, work: row.dashboard.work })))}`);
}

async function main() {
  await writeFile('/paperclip/creative-gateway-token', gatewayToken, { mode: 0o600, flag: 'wx' });
  const gateway = await createCreativeGateway();
  try {
    const health = (await call('GET', '/api/health')).data;
    assert.equal(health.status, 'ok'); assert.equal(health.serverVersion, '2026.1106.0');
    const identity = { sha256: process.env.POLYFORGE_V1_CANDIDATE_SHA256, version: process.env.POLYFORGE_V1_CANDIDATE_VERSION };
    assert.match(identity.sha256 ?? '', /^[0-9a-f]{64}$/); assert.match(identity.version ?? '', /^\d+\.\d+\.\d+$/);
    await record('host-health', { serverVersion: health.serverVersion, candidateVersion: identity.version, candidateSha256: identity.sha256, selectedPack });
    const installed = await call('POST', '/api/plugins/install', { packageName: '/opt/polyforge/plugin', isLocalPath: true });
    assert.equal(installed.data.version, identity.version); assert.equal(installed.data.status, 'ready');
    assert.equal(installed.data.manifestJson.minimumHostVersion, '2026.1106.0');
    await record('plugin-installed', { version: installed.data.version, status: installed.data.status, creativeGateway: 'loopback resolveDecisionEvidence only' });
    const company = await call('POST', '/api/companies', { name: 'Workflow composition synthetic E2E',
      description: 'Disposable isolated company; Agent outputs, gateway decisions, and all artifacts are synthetic.' });
    const companyId = company.data.id; assert.ok(companyId);
    const setupIssue = await call('POST', `/api/companies/${companyId}/issues`, { title: 'Synthetic composition provisioning',
      description: 'Disposable fixture setup issue.', status: 'todo', priority: 'medium' });
    const setupIssueId = setupIssue.data.id;
    const setupPath = pluginIssuePath(setupIssueId);
    const settings = (await call('GET', `/api/plugins/${pluginId}/api/settings?companyId=${companyId}`)).data;
    for (const pack of expected) assert.ok(settings.catalog.some(item => item.id === pack.id && item.version === pack.version),
      `Mounted Pack catalog lacks ${pack.id}@${pack.version}`);
    await record('catalog-verified', { packs: expected.map(pack => `${pack.id}@${pack.version}`) });
    const fixtureAgents = new Set();
    for (const pack of expected) {
      await call('POST', `/api/plugins/${pluginId}/api/company`, { companyId, operation: 'enable-pack', packId: pack.id, version: pack.version,
        reason: 'Enable exact candidate Pack in disposable workflow composition company.', idempotencyKey: `composition-enable:${pack.id}` });
      const provision = await call('POST', setupPath, { operation: 'provision', packId: pack.id, packVersion: pack.version,
        reason: 'Provision isolated Process fixture roles for workflow composition.', idempotencyKey: `composition-provision:${pack.id}` });
      assert.ok(provision.data.roleBindings && Object.keys(provision.data.roleBindings).length, `No roles provisioned for ${pack.id}`);
      for (const agentId of Object.values(provision.data.roleBindings)) fixtureAgents.add(agentId);
    }
    for (const agentId of fixtureAgents) {
      const agent = (await call('GET', `/api/agents/${agentId}`)).data;
      assert.equal(agent.adapterType, 'process', 'E2E must not invoke a paid model adapter');
      await call('PATCH', `/api/agents/${agentId}`, { adapterConfig: { ...agent.adapterConfig, timeoutSec: 300 } });
    }
    const session = (await call('GET', '/api/auth/get-session')).data;
    assert.ok(session?.user?.id, 'Official Host did not identify the local owner');
    await call('POST', setupPath, { operation: 'configure',
      userRoles: { [session.user.id]: ['cto-caio', 'creative-team:creative-director'] },
      reason: 'Assign explicit domain review roles to the authenticated owner in this disposable synthetic company.',
      idempotencyKey: 'composition-owner-role-configuration' });
    await record('owner-domain-roles-configured', { userId: session.user.id, roles: ['cto-caio', 'creative-team:creative-director'] });
    const wrong = await call('POST', `/api/companies/${companyId}/agents`, { name: 'Composition unauthorized fixture', role: 'general', adapterType: 'process',
      adapterConfig: { command: 'node', args: ['-e', 'process.exit(0)'], timeoutSec: 10 }, budgetMonthlyCents: 0 });
    const key = await call('POST', `/api/agents/${wrong.data.id}/keys`, { name: 'composition-wrong-agent' });
    const secret = key.data.key ?? key.data.apiKey ?? key.data.token;
    if (!secret) throw new Error('Official Agent key endpoint did not return its one-time secret');
    const wrongAgent = { id: wrong.data.id, key: secret };
    const wrongIdentity = await call('GET', '/api/agents/me', undefined, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(wrongIdentity.data.id, wrongAgent.id, 'wrong-Agent secret did not authenticate as the issued Agent');
    await writeFile('/paperclip/workflow-composition-wrong-agent.json', JSON.stringify(wrongAgent), { mode: 0o600 });
    await record('company-ready', { companyId, setupIssueId, wrongAgentId: wrongAgent.id });

    const actualRuns = [];
    const selected = expected.filter(pack => !selectedPack || pack.id === selectedPack)
      .toSorted((left, right) => Number(right.id === 'creative-team') - Number(left.id === 'creative-team'));
    for (const pack of selected) for (const graph of pack.graphs) {
      const rootIssue = await call('POST', `/api/companies/${companyId}/issues`, { title: `Synthetic ${graph.id} workflow root`,
        description: `Disposable isolated root issue for ${pack.id}/${graph.id}; fixture data is synthetic.`, status: 'todo', priority: 'medium' });
      const issueId = rootIssue.data.id, graphPath = pluginIssuePath(issueId);
      const reference = { packId: pack.id, packVersion: pack.version, graphId: graph.id, graphVersion: graph.version };
      const before = await call('GET', `/api/companies/${companyId}/issues`);
      const graphBefore = (await call('GET', graphPath)).data;
      const graphInventory = value => ({ runs: value.runs ?? [], decisions: value.decisions ?? [] });
      const badInput = graph.id.includes('architecture') ? { system_id: 'synthetic-only' } : {};
      const invalid = await call('POST', graphPath, { operation: 'workflow-start', issueId, ...reference,
        workflowInput: badInput, mode: graph.manualGate ? 'manual' : 'autonomous', idempotencyKey: `composition-invalid:${graph.id}` }, { allowError: true });
      assert.ok(invalid.status >= 400, `${graph.id} accepted malformed input`);
      const afterInvalid = await call('GET', `/api/companies/${companyId}/issues`);
      assert.equal(afterInvalid.data.length, before.data.length, `${graph.id} invalid input mutated issue inventory`);
      assert.deepEqual(graphInventory((await call('GET', graphPath)).data), graphInventory(graphBefore),
        `${graph.id} invalid input mutated run or decision state`);
      const wrongVersion = await call('POST', graphPath, { operation: 'workflow-start', issueId,
        ...reference, packVersion: '99.99.99', workflowInput: graph.input, mode: graph.manualGate ? 'manual' : 'autonomous',
        idempotencyKey: `composition-wrong-version:${graph.id}` }, { allowError: true });
      assert.ok(wrongVersion.status >= 400, `${graph.id} accepted wrong Pack version`);
      const afterVersion = await call('GET', `/api/companies/${companyId}/issues`);
      assert.equal(afterVersion.data.length, before.data.length, `${graph.id} wrong version mutated issue inventory`);
      assert.deepEqual(graphInventory((await call('GET', graphPath)).data), graphInventory(graphBefore),
        `${graph.id} wrong version mutated run or decision state`);
      await record('negative-starts-unchanged', { graph: `${pack.id}/${graph.id}@${graph.version}`,
        invalidInputStatus: invalid.status, wrongVersionStatus: wrongVersion.status, unchanged: true });

      try {
        const started = await call('POST', graphPath, { operation: 'workflow-start', issueId, ...reference,
          workflowInput: graph.input, mode: graph.manualGate ? 'manual' : 'autonomous', idempotencyKey: `composition-start:${graph.id}` });
        const handle = started.data.handle; assert.equal(handle.workflow.graphId, graph.id); assert.ok(handle.runId);
        runToIssue.set(handle.runId, issueId);
        if (!companyRoots.has(companyId)) companyRoots.set(companyId, new Map());
        companyRoots.get(companyId).set(handle.runId, issueId);
        await record('workflow-started', { workflow: reference, rootIssueId: issueId, runId: handle.runId,
          status: handle.status, childExpected: graph.child === true });
        const outcome = await waitForWorkflow(companyId, issueId, reference, handle, wrongAgent);
        const childLinks = outcome.tree.flatMap(row => Object.entries(row.dashboard.run.nodeStates ?? {}).filter(([, state]) => state.childRunId)
          .map(([nodeId, state]) => ({ parentRunId: row.dashboard.run.id, nodeId, childRunId: state.childRunId,
            childOutput: state.output, status: state.status })));
        if (graph.child) assert.ok(childLinks.length, `${graph.id} completed without a linked child workflow`);
        assert.ok(childLinks.every(link => link.status === 'completed' && link.childOutput), `${graph.id} omitted completed child output`);
        const result = { workflow: reference, rootIssueId: issueId, runId: handle.runId, status: outcome.handle.status,
          output: outcome.handle.output, childLinks };
        actualRuns.push(result); await record('workflow-completed', result);
      } catch (error) {
        const result = { workflow: reference, rootIssueId: issueId, status: 'integration-failed', error: error.message };
        actualRuns.push(result); await record('workflow-integration-failed', result);
      }
    }
    evidence.results = actualRuns;
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    const failures = actualRuns.filter(result => result.status !== 'completed');
    if (failures.length) throw new Error(`Composition integration failures: ${failures.map(item => `${item.workflow.graphId}: ${item.error}`).join(' | ')}`);
    await record('all-selected-workflows-completed', { count: actualRuns.length, selectedPack, synthetic: true });
  } finally {
    await new Promise(resolve => gateway.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  await record('failed', { error: error.message }).catch(() => {});
  console.error(error.stack ?? error.message); process.exitCode = 1;
});
