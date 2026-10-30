// Deterministic process-adapter fixture for the pinned Paperclip host. It
// exercises native sessions and authenticated company routes; no model runs.
const env = process.env;
const base = (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL ||
  'http://127.0.0.1:3100').replace(/\/$/, '');
const pluginId = 'pohlee.polyforge-graph';
const agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID;
const runId = env.PAPERCLIP_RUN_ID;
const token = env.PAPERCLIP_API_KEY;
const companyId = env.PAPERCLIP_COMPANY_ID;
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
  if (!allowError && [502, 503].includes(response.status) && attempt < 8 &&
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
      packet.taskKey !== taskKey || packet.kind !== 'sub-agent' ||
      packet.purpose !== 'research' || packet.workspace?.writeAccess !== 'none') {
    throw new Error('Unexpected bounded Sub-Agent packet');
  }
  const parentIssueId = packet.brief.inputRefs.find((ref) => ref.kind === 'issue')?.id;
  if (!parentIssueId) throw new Error('Research packet missing issue reference');
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
      companyMutationDenied: denied.status, graphMutationDenied: graphDenied.status } }));
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
const deadlineAt = new Date(Date.now() + 90_000).toISOString();
const delegation = {
  id: `temporary-${runId}`, kind: 'sub-agent', purpose: 'research',
  parent: { agentId, executionId: runId, taskId: issueId },
  context: { mode: 'fresh' },
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
  reason: 'Deterministic native Sub-Agent acceptance', idempotencyKey: key };
const opened = (await request('POST', companyPath, openBody)).data;
const replay = (await request('POST', companyPath, openBody)).data;
if (!opened.temporaryAgentId || !opened.sessionId || !opened.executionId ||
    replay.temporaryAgentId !== opened.temporaryAgentId || replay.replayed !== true) {
  throw new Error('Native Sub-Agent creation or idempotent replay failed');
}
const shadowDenied = await request('POST', companyPath, { ...openBody,
  request: { ...delegation, id: `${delegation.id}-shadow`, kind: 'shadow-agent',
    context: { mode: 'fork' } },
  idempotencyKey: `temporary-fixture:${runId}:shadow-denied` }, true);
if (shadowDenied.status < 400) throw new Error('Host pretended a fresh session was a native fork');
// Complete the native parent assignment so Paperclip does not schedule an
// automatic continuation of an unfinished fixture issue.
const waitUntil = Date.now() + 45_000;
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
await request('PATCH', `/api/issues/${issueId}`, { status: 'done' });
console.log(JSON.stringify({ fixture: 'deterministic-process',
  parentRunId: runId, issueId, temporaryAgentId: opened.temporaryAgentId,
  childRunId: opened.executionId, replayed: replay.replayed,
  nativeForkDenied: shadowDenied.status }));
