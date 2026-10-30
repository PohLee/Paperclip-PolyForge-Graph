// Deterministic process-adapter fixture for the pinned Paperclip host. It
// exercises native sessions and authenticated company routes; no model runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const env = process.env;
const base = (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL ||
  'http://127.0.0.1:3100').replace(/\/$/, '');
const pluginId = 'pohlee.polyforge-graph';
const agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID;
const runId = env.PAPERCLIP_RUN_ID;
const token = env.PAPERCLIP_API_KEY;
const companyId = env.PAPERCLIP_COMPANY_ID;
const snapshotMode = env.POLYFORGE_TEMPORARY_MODE === 'snapshot';
const expectedKind = snapshotMode ? 'shadow-agent' : 'sub-agent';
if (![agentId, runId, token, companyId].every(Boolean)) {
  throw new Error('Temporary Agent fixture missing host-injected run identity');
}

async function request(method, path, body, allowError = false, attempt = 0) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Paperclip-Run-Id': runId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text.slice(0, 1000) }; }
  const transient = [502, 503].includes(response.status) || !response.ok &&
    /Worker process exited|worker.*(?:not running|not ready|unavailable)/i.test(JSON.stringify(data));
  if (transient && attempt < 20 &&
      (method === 'GET' || body?.idempotencyKey)) {
    await new Promise(resolve => setTimeout(resolve, 750));
    return request(method, path, body, allowError, attempt + 1);
  }
  if (!response.ok && !allowError) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

const heartbeat = (await request('GET', `/api/heartbeat-runs/${runId}`)).data;
if (heartbeat.agentId !== agentId || heartbeat.companyId !== companyId) {
  throw new Error('Host heartbeat identity mismatches process environment');
}
const context = heartbeat.contextSnapshot ?? {};
const taskKey = context.taskKey ?? '';
const childPrefix = `plugin:${pluginId}:session:temporary:`;
if (taskKey.startsWith(childPrefix)) {
  const message = context.paperclipAgentMessage;
  if (message?.source !== 'plugin_session' || message.pluginKey !== pluginId) {
    throw new Error('Child session prompt was not host injected');
  }
  const packet = JSON.parse(message.text ?? '');
  if (packet.schema !== 'polyforge.temporary-agent.task.v1' ||
      packet.taskKey !== taskKey || packet.kind !== expectedKind ||
      packet.purpose !== 'research' || packet.workspace?.writeAccess !== 'none') {
    throw new Error('Unexpected bounded Temporary Agent packet');
  }
  const parentIssueId = packet.brief.inputRefs.find((ref) => ref.kind === 'issue')?.id;
  if (!parentIssueId) throw new Error('Research packet missing issue reference');
  let snapshotProof = {};
  if (snapshotMode) {
    const issue = (await request('GET', `/api/issues/${parentIssueId}`)).data;
    const metadata = JSON.parse(issue.description.split('\n').find(line => line.startsWith('{'))).snapshotFixture;
    const { digest, ...payload } = packet.contextSnapshot ?? {};
    const canonical = JSON.stringify(payload, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    assert.equal(digest, `sha256:${createHash('sha256').update(canonical).digest('hex')}`);
    assert.equal(payload.schema, 'polyforge.temporary-agent.snapshot.v1');
    assert.equal(payload.source.companyId, companyId);
    assert.equal(payload.source.agentId, agentId);
    assert.equal(payload.source.taskId, parentIssueId);
    assert.notEqual(payload.source.executionId, runId);
    const baseline = payload.authority.decisions.find(item => item.id === metadata.baselineId);
    const rejected = payload.authority.decisions.find(item => item.id === metadata.rejectedId);
    assert.equal(baseline?.status, 'approved');
    assert.equal(rejected?.status, 'rejected');
    assert.equal(rejected?.outcome, 'Synthetic change: replace subtraction with addition');
    assert.ok(payload.authority.activeProductDecisionIds.includes(baseline.id));
    assert.ok(!payload.authority.activeProductDecisionIds.includes(rejected.id));
    assert.ok(payload.advisory.conclusions.includes('Synthetic conflicting claim: subtraction-to-addition is approved.'));
    snapshotProof = { snapshotDigest: digest, baselineId: baseline.id, rejectionId: rejected.id,
      decisionIds: payload.authority.decisions.map(item => item.id), advisoryAndRejectionRetained: true };
  } else assert.equal(packet.contextSnapshot, undefined);
  const denied = await request('POST', `/api/plugins/${pluginId}/api/company`, {
    companyId, operation: 'open-temporary-agent',
    request: { id: 'forbidden-child-spawn' },
    reason: 'Probe child authority denial',
    idempotencyKey: `temporary-child-denial:${runId}`,
  }, true);
  if (denied.status < 400) throw new Error('Child acquired parent delegation authority');
  if (!/temporary execution may only return its bounded result/i.test(JSON.stringify(denied.data))) {
    throw new Error(`Child denial was not the temporary execution guard: ${JSON.stringify(denied.data)}`);
  }
  const graphDenied = await request('POST',
    `/api/plugins/${pluginId}/api/issues/${parentIssueId}/graph`, {
      operation: 'status', reason: 'Probe child Graph authority denial',
      idempotencyKey: `temporary-child-graph-denial:${runId}`,
    }, true);
  if (graphDenied.status < 400) throw new Error('Child acquired parent Graph authority');
  const delay = Number(env.POLYFORGE_TEMPORARY_DELAY_MS ?? 0);
  if (Number.isInteger(delay) && delay > 0 && delay <= 60_000) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  console.log(JSON.stringify({ status: 'completed',
    summary: 'Deterministic fixture inspected the pinned issue reference and verified child authority denial.',
    evidenceRefs: [{ kind: 'issue', id: parentIssueId }],
    output: { fixture: 'deterministic-process', childRunId: runId,
      companyMutationDenied: denied.status, graphMutationDenied: graphDenied.status, ...snapshotProof } }));
  process.exit(0);
}

const issueId = env.PAPERCLIP_TASK_ID ?? heartbeat.issueId ?? context.taskId;
if (!issueId) throw new Error('Parent run has no assigned issue');
const issue = (await request('GET', `/api/issues/${issueId}`)).data;
if (issue.companyId !== companyId || issue.assigneeAgentId !== agentId ||
    !issue.description?.includes('polyforge-temporary-agent-parent-v1')) {
  throw new Error('Parent issue is not the designated deterministic fixture');
}
await request('POST', `/api/issues/${issueId}/checkout`, {
  agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'],
});
const deadlineAt = new Date(Date.now() + 150_000).toISOString();
const delegation = {
  id: `temporary-${runId}`, kind: expectedKind, purpose: 'research',
  parent: { agentId, executionId: runId, taskId: issueId },
  context: snapshotMode ? { mode: 'snapshot', snapshot: {
    objective: 'Verify a frozen parent handoff with a conflicting synthetic claim',
    currentState: 'A synthetic product baseline and rejected change are recorded for this test issue.',
    conclusions: ['Synthetic conflicting claim: subtraction-to-addition is approved.'],
    openQuestions: ['Which authoritative decision contradicts the parent claim?'],
    evidenceRefs: [{ kind: 'issue', id: issueId }],
  } } : { mode: 'fresh' },
  brief: { objective: 'Inspect this deterministic issue reference',
    scope: 'One issue and its identifier', outputFormat: 'JSON',
    boundaries: ['Read only', 'No Graph or company mutation'],
    inputRefs: [{ kind: 'issue', id: issueId }],
    acceptanceCriteria: ['Return issue reference', 'Verify child authority denial'],
    allowedActions: ['research'], deadlineAt },
  limits: { maxTasks: 1, maxConcurrent: 1 },
  workspace: { mode: 'shared', writeAccess: 'none' },
};
const companyPath = `/api/plugins/${pluginId}/api/company`;
const key = `temporary-fixture:${runId}:open`;
const openBody = { companyId, operation: 'open-temporary-agent', request: delegation,
  reason: `Deterministic native ${expectedKind} acceptance`, idempotencyKey: key };
const opened = (await request('POST', companyPath, openBody)).data;
const replay = (await request('POST', companyPath, openBody)).data;
if (!opened.temporaryAgentId || !opened.sessionId || !opened.executionId ||
    replay.temporaryAgentId !== opened.temporaryAgentId || replay.replayed !== true) {
  throw new Error('Native Sub-Agent creation or idempotent replay failed');
}
if (snapshotMode) {
  assert.equal(opened.context.mode, 'snapshot');
  assert.equal(opened.context.source.executionId, runId);
  assert.match(opened.context.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(replay.context.digest, opened.context.digest);
  const reviewDenied = await request('POST', companyPath, { ...openBody,
    request: { ...delegation, id: `${delegation.id}-review`, purpose: 'review',
      brief: { ...delegation.brief, allowedActions: ['review'] } },
    idempotencyKey: `temporary-fixture:${runId}:review-denied` }, true);
  assert.ok(reviewDenied.status >= 400);
  assert.match(JSON.stringify(reviewDenied.data), /independent review requires a fresh Sub-Agent/);
}
const shadowDenied = await request('POST', companyPath, { ...openBody,
  request: { ...delegation, id: `${delegation.id}-shadow`, kind: 'shadow-agent',
    context: { mode: 'fork' } },
  idempotencyKey: `temporary-fixture:${runId}:shadow-denied` }, true);
if (shadowDenied.status < 400) throw new Error('Host pretended a fresh session was a native fork');
// Complete the native parent assignment so Paperclip does not schedule an
// automatic continuation of an unfinished fixture issue.
const waitUntil = Date.now() + 100_000;
let childResult;
while (Date.now() < waitUntil) {
  const state = (await request('GET', `${companyPath}?companyId=${companyId}`)).data;
  childResult = state.temporaryAgents?.find(item => item.temporaryAgentId === opened.temporaryAgentId);
  if (childResult?.status === 'closed') break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (childResult?.status !== 'closed' || childResult.outcome !== 'completed') {
  throw new Error('Child did not complete within fixture parent deadline');
}
if (snapshotMode) assert.equal(childResult.result.output.snapshotDigest, opened.context.digest);
await request('PATCH', `/api/issues/${issueId}`, { status: 'done' });
console.log(JSON.stringify({ fixture: 'deterministic-process',
  parentRunId: runId, issueId, temporaryAgentId: opened.temporaryAgentId,
  childRunId: opened.executionId, replayed: replay.replayed,
  nativeForkDenied: shadowDenied.status, context: opened.context }));
