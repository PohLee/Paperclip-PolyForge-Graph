// Run inside the isolated official Host container; never logs API credentials.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { observeGraph, assertDispatches, assertCandidateIdentity } from './e2e-minimal-helpers.mjs';

const base = 'http://127.0.0.1:3100', pluginId = 'pohlee.polyforge-graph';
const evidencePath = '/paperclip/v1-evidence.json';
const identity = assertCandidateIdentity({ sha256: process.env.POLYFORGE_V1_CANDIDATE_SHA256, version: process.env.POLYFORGE_V1_CANDIDATE_VERSION });
const evidence = { candidateSha256: identity.sha256, candidateVersion: identity.version,
  expected: { pack: 'adlc@0.3.2', graph: 'request-triage@0.2.0', outcome: 'needs-info', terminal: 'triage-needs-info' }, stages: [] };
async function record(stage, details = {}) {
  evidence.stages.push({ stage, ...details });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage, ...details }));
}
async function call(method, path, body, signal) {
  const response = await fetch(base + path, { method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
  const text = await response.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
try {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 'ok'); assert.equal(health.serverVersion, '2026.1106.0');
  assert.equal(health.commit, 'd69631b01b9c658f80bf8bed389863dce82643e1');
  await record('host-health', { serverVersion: health.serverVersion, commit: health.commit });
  const plugin = await call('POST', '/api/plugins/install', { packageName: '/opt/polyforge/plugin', isLocalPath: true });
  assert.equal(plugin.version, identity.version); assert.equal(plugin.manifestJson.version, identity.version);
  assert.equal(plugin.status, 'ready'); assert.equal(plugin.manifestJson.minimumHostVersion, '2026.1106.0');
  assert.equal(plugin.manifestJson.agents.length, 28); assert.equal(plugin.manifestJson.skills.length, 61);
  await record('plugin-installed', { status: plugin.status, agents: 28, skills: 61 });
  const company = await call('POST', '/api/companies', { name: 'V1 isolated triage', description: 'Disposable local Process fixture only' });
  assert.ok(company.id);
  const root = await call('POST', `/api/companies/${company.id}/issues`, { title: 'V1 synthetic dashboard request',
    description: 'Please add a dashboard. The affected user and expected behavior are not specified.', status: 'todo', priority: 'medium' });
  assert.ok(root.id);
  const graphPath = `/api/plugins/${pluginId}/api/issues/${root.id}/graph`;
  const command = (operation, fields = {}, signal) => call('POST', graphPath, { operation, ...fields, idempotencyKey: `v1-owner:${operation}:${root.id}` }, signal);
  const settings = await call('GET', `/api/plugins/${pluginId}/api/settings?companyId=${company.id}`);
  assert.equal(settings.runtime.version, identity.version);
  assert.deepEqual(settings.catalog.map(x => `${x.id}@${x.version}`).sort(), ['adlc@0.3.2', 'creative-team@0.3.1', 'marketing@0.0.4']);
  await call('POST', `/api/plugins/${pluginId}/api/company`, { companyId: company.id, operation: 'enable-pack', packId: 'adlc', version: '0.3.2',
    reason: 'Enable the fixed Pack for isolated V1', idempotencyKey: `v1-enable:${company.id}` });
  const provision = await command('provision', { packId: 'adlc', packVersion: '0.3.2', reason: 'Create isolated Process fixture roles' });
  assert.ok(provision.roleBindings['adlc:product-owner']); assert.ok(provision.roleBindings['adlc:cpo']);
  const wrong = await call('POST', `/api/companies/${company.id}/agents`, { name: 'V1 wrong identity', role: 'general', adapterType: 'process',
    adapterConfig: { command: 'node', args: ['-e', 'process.exit(0)'], timeoutSec: 10 }, budgetMonthlyCents: 0 });
  const key = await call('POST', `/api/agents/${wrong.id}/keys`, { name: 'v1-wrong-agent' });
  const secret = key.key ?? key.apiKey ?? key.token;
  if (typeof secret !== 'string' || !secret) throw new Error('Official key response did not contain the one-time secret');
  await writeFile('/paperclip/v1-wrong-agent.json', JSON.stringify({ id: wrong.id, key: secret }), { mode: 0o600 });
  await record('prepared', { companyId: company.id, rootIssueId: root.id, wrongAgentId: wrong.id,
    productOwnerId: provision.roleBindings['adlc:product-owner'], cpoId: provision.roleBindings['adlc:cpo'] });
  const socket = new WebSocket(`ws://127.0.0.1:3100/api/companies/${company.id}/events/ws`);
  let runId;
  const completed = await observeGraph({ socket,
    start: async signal => {
      const started = await command('start', { packId: 'adlc', packVersion: '0.3.2', graphId: 'request-triage', mode: 'autonomous',
        input: { source_request: { id: root.id, version: 'v1' }, fixture: 'v1-isolated-needs-info' } }, signal);
      runId = started.run.id;
      assert.equal(started.run.graph.version, '0.2.0');
      if (signal.aborted) throw new Error('Observation ended before Graph start completed');
      await record('graph-started', { graphRunId: runId, dispatch: started.dispatch });
      return started;
    },
    read: (id, signal) => call('GET', `${graphPath}?runId=${id}`, undefined, signal),
  });
  const latest = completed.latest;
  assert.equal(latest.run.status, 'completed');
  assert.equal(latest.run.nodeStates['triage-disposition'].outcome, 'needs-info');
  assert.equal(latest.run.nodeStates['triage-needs-info'].status, 'completed');
  const attempts = Object.entries(latest.run.nodeStates).flatMap(([nodeId, state]) => state.attempts.filter(x => x.actor?.kind === 'agent')
    .map(x => ({ nodeId, agentId: x.actor.id, hostRunId: x.actor.executionId })));
  assert.ok(attempts.length && attempts.every(x => x.hostRunId));
  const hostRuns = [];
  for (const id of completed.ids) {
    const heartbeat = await call('GET', `/api/heartbeat-runs/${id}`);
    hostRuns.push({ id, status: heartbeat.status, issueId: heartbeat.issueId, agentId: heartbeat.agentId });
    assert.equal(heartbeat.status, 'succeeded');
  }
  assert.equal(latest.run.nodeStates['assess-request'].attempts.length, 1, 'duplicate callback caused another attempt');
  const workRun = attempts.find(x => x.nodeId === 'assess-request');
  assert.ok(workRun);
  const log = await call('GET', `/api/heartbeat-runs/${workRun.hostRunId}/log`);
  function findProbe(value) {
    if (typeof value === 'string') {
      for (const line of value.split('\n')) {
        try { const found = findProbe(JSON.parse(line)); if (found) return found; } catch { /* non-JSON log line */ }
      }
    } else if (value && typeof value === 'object') {
      if (value.stage === 'wrong-agent-rejected-and-valid-submitted') return value;
      for (const item of Object.values(value)) { const found = findProbe(item); if (found) return found; }
    }
    return null;
  }
  const probe = findProbe(log);
  assert.ok(probe && probe.unchangedGraphAndDecisions && probe.wrongAgentId === wrong.id && probe.hostRunId === workRun.hostRunId,
    'Missing authenticated wrong-agent negative evidence in the real work heartbeat');
  const issues = await call('GET', `/api/companies/${company.id}/issues`);
  const companyRuns = await call('GET', `/api/companies/${company.id}/heartbeat-runs?limit=1000`);
  assert.ok(Array.isArray(companyRuns) && companyRuns.length < 1000, 'Run inventory must be complete, below Host limit');
  const dispatchIssues = issues.filter(x => x.originKind === 'plugin:pohlee.polyforge-graph:node' && x.originId?.startsWith(`${runId}:`));
  const actualRuns = companyRuns.filter(run => dispatchIssues.some(issue => issue.id === run.issueId));
  const phases = assertDispatches(issues, runId, actualRuns, provision.roleBindings);
  assert.deepEqual(actualRuns.map(x => x.id).sort(), completed.ids.sort(), 'unexpected or missing dispatched Host run');
  assert.ok(actualRuns.every(run => run.status === 'succeeded'));
  await record('graph-terminal', { graphRunId: runId, status: latest.run.status, outcome: 'needs-info', terminal: 'triage-needs-info',
    attempts, hostRuns, dispatchIssueCount: dispatchIssues.length, phases, negative: { wrongAgentId: probe.wrongAgentId,
      httpStatus: probe.wrongAgentHttpStatus, reason: probe.rejectionReason, checkout: probe.checkout,
      unchangedGraphAndDecisions: true, acceptedResult: probe.acceptedResult, replayResult: probe.replayResult } });
} catch (error) {
  await record('failed', { error: error.message });
  process.exitCode = 1;
}
