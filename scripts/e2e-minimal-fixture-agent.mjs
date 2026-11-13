// Isolated Process fixture only. No model, external research, or production claim.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertNegativeResult, assertActiveDispatch } from './e2e-minimal-helpers.mjs';

export function triageSubmission({ graphRunId, requestId, companyId, decisionId }) {
  const artifacts = ['triage_report', 'request_brief'].map(kind => ({ kind, id: `${graphRunId}-${kind}`, version: 'v1' }));
  const brief = { id: artifacts[1].id, version: 'v1', sourceRef: `paperclip://issue/${requestId}`,
    literalAsk: 'Clarify an unspecified dashboard request', underlyingProblem: 'The request does not identify its user',
    problemStatus: 'reported', affectedUser: 'unknown', desiredOutcome: 'Clarify the requested dashboard',
    acceptanceBoundary: 'Reporter identifies the affected user and desired behavior', owner: 'product-owner',
    mustHaves: [], hardConstraints: [], exclusions: [], unknowns: ['Which user is affected?'], authorityFromUrgency: false };
  return { output: { requestRefs: [{ artifactId: requestId, version: 'v1' }], category: 'enhancement', surface: 'issue',
    disposition: 'needs-info', duplicateCheck: { result: 'none', sourceRef: `paperclip://company-issues/${companyId}` },
    priorDecisionCheck: { result: 'none', sourceRef: `paperclip://graph-run/${graphRunId}` },
    claimCheck: { result: 'not-applicable', sourceRef: `paperclip://issue/${requestId}` },
    questions: ['Which user is affected and what behavior is needed?'] }, artifacts, payloads: { request_brief: brief },
    decisionIds: [decisionId], evidence: [{ kind: 'fixture_result', subjectRefs: artifacts.map(x => ({ artifactId: x.id, version: x.version })) }] };
}

export async function runFixture(env = process.env) {
  const base = (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
  const token = env.PAPERCLIP_API_KEY, agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID, hostRunId = env.PAPERCLIP_RUN_ID;
  if (!token || !agentId || !hostRunId) throw new Error('Fixture missing host-injected agent, run or credential');
  async function call(method, path, body, auth = token, run = hostRunId, allowError = false) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${auth}`,
      ...(run ? { 'X-Paperclip-Run-Id': run } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok && !allowError) throw new Error(`${method} ${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
    return { status: response.status, data };
  }
  let issueId = env.PAPERCLIP_TASK_ID;
  if (!issueId) { const heartbeat = (await call('GET', `/api/heartbeat-runs/${hostRunId}`)).data; issueId = heartbeat.issueId ?? heartbeat.contextSnapshot?.taskId; }
  if (!issueId) throw new Error('Authenticated heartbeat did not identify task issue');
  const issue = (await call('GET', `/api/issues/${issueId}`)).data;
  const match = (issue.description ?? '').match(/PolyForge Graph run ([\w-]+), node ([\w-]+), attempt (\d+)\./);
  if (!match) throw new Error('Missing Graph dispatch metadata');
  const [, graphRunId, nodeId, attempt] = match;
  if (!['assess-request', 'triage-disposition'].includes(nodeId)) throw new Error(`Unexpected fixture node ${nodeId}`);
  await call('POST', `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'] });
  const checkedOut = (await call('GET', `/api/issues/${issueId}`)).data;
  assert.equal(checkedOut.assigneeAgentId, agentId);
  assert.equal(checkedOut.checkoutRunId, hostRunId);
  const path = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
  const read = async () => (await call('GET', `${path}?runId=${graphRunId}`)).data;
  const dashboard = await read(), node = dashboard.run.graph.nodes.find(item => item.id === nodeId);
  if (dashboard.run.graph.id !== 'request-triage' || dashboard.run.graph.version !== '0.2.0' || dashboard.run.packVersion !== '0.3.2') throw new Error('Unexpected Graph or Pack version');
  const phase = issue.title?.endsWith(' review') ? 'supervisor' : 'work';
  const command = (operation, fields, suffix = '') => ({ operation, runId: graphRunId, nodeId, ...fields,
    idempotencyKey: `v1:${graphRunId}:${nodeId}:${attempt}:${phase}:${operation}:${suffix}` });
  const post = body => call('POST', path, body);
  if (phase === 'supervisor') {
    const refs = dashboard.run.nodeStates[nodeId].artifacts.map(x => ({ artifactId: x.id, version: x.version }));
    await post(command('review', { outcome: 'accept', reason: 'Reviewed the synthetic request and its explicit unknowns.',
      evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({ kind, subjectRefs: refs })) }));
  } else if (nodeId === 'triage-disposition') {
    const refs = dashboard.run.nodeStates['assess-request'].artifacts.filter(x => x.kind === 'triage_report').map(x => ({ artifactId: x.id, version: x.version }));
    const rule = dashboard.run.pack.decisionRules.find(item => item.type === node.decisionType && item.mode === dashboard.run.mode);
    await post(command('decide', { outcome: 'needs-info', reason: 'The synthetic request does not specify its affected user.',
      evidence: rule.requiredEvidence.map(kind => ({ kind, subjectRefs: refs })) }));
  } else {
    const requestId = dashboard.run.input.source_request.id;
    const issues = (await call('GET', `/api/companies/${issue.companyId}/issues`)).data;
    if (!Array.isArray(issues) || issues.filter(x => x.title === 'V1 synthetic dashboard request').length !== 1) throw new Error('Synthetic company issue search did not establish the expected unique request');
    if (dashboard.decisions.some(x => x.type === 'product_decision' && x.status === 'rejected')) throw new Error('Unexpected prior rejection in this isolated Graph');
    const decision = (await post(command('record-work-decision', { category: 'product', question: 'How should this incomplete request be routed?',
      options: [{ id: 'needs-info', label: 'Ask for the missing user and behavior' }], outcome: 'needs-info',
      reason: 'The actual synthetic request omits its user and desired behavior.', ruleRef: 'node:assess-request', behaviorImpact: 'none',
      evidence: [{ kind: 'requirement', summary: 'Synthetic request text', sourceRef: { kind: 'run_input', key: 'source_request' } }] }))).data;
    const decisionId = decision.result?.id ?? decision.decision?.id ?? decision.id;
    assert.ok(decisionId, 'missing work decision identity');
    const submission = command('submit', triageSubmission({ graphRunId, requestId, companyId: issue.companyId, decisionId }));
    const wrong = JSON.parse(await readFile('/paperclip/v1-wrong-agent.json', 'utf8'));
    const wrongIdentity = (await call('GET', '/api/agents/me', undefined, wrong.key, null)).data;
    assert.equal(wrongIdentity.id, wrong.id, 'wrong-agent credential did not authenticate as the intended different agent');
    assert.notEqual(wrong.id, agentId);
    const before = await read();
    const assignment = assertActiveDispatch({ issue, checkedOut, graphRunId, nodeId, attempt, agentId, hostRunId, dashboard: before });
    const rejected = await call('POST', path, submission, wrong.key, hostRunId, true);
    const after = await read();
    const rejectionReason = assertNegativeResult(rejected, before, after);
    const accepted = (await post(submission)).data;
    assert.ok(accepted && accepted.result != null, 'legal submission returned no result');
    const afterAccepted = await read();
    const replay = (await post(submission)).data;
    assert.deepEqual(replay.result, accepted.result, 'idempotent submit returned a different result');
    const afterReplay = await read();
    assert.deepEqual(afterReplay.run, afterAccepted.run, 'idempotent replay changed Graph state');
    assert.deepEqual(afterReplay.decisions, afterAccepted.decisions, 'idempotent replay changed decisions');
    const refs = submission.artifacts.map(x => ({ artifactId: x.id, version: x.version }));
    await post(command('self-review', { artifactVersion: 'v1', findings: [], fixes: [], evidence: [{ kind: 'fixture_self_review', subjectRefs: refs }] }, 'one'));
    console.log(JSON.stringify({ stage: 'wrong-agent-rejected-and-valid-submitted', issueId, graphRunId, nodeId, hostRunId,
      wrongAgentId: wrong.id, wrongAgentHttpStatus: rejected.status, rejectionReason,
      checkout: assignment,
      unchangedGraphAndDecisions: true, acceptedResult: accepted.result, replayResult: replay.result }));
  }
  console.log(JSON.stringify({ stage: 'fixture-action-complete', issueId, graphRunId, nodeId, attempt: Number(attempt), phase, agentId, hostRunId }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runFixture().catch(error => { console.error(error.message); process.exitCode = 1; });
}
