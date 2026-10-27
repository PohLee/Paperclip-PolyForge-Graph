// Deterministic process adapter for the pinned Paperclip Docker E2E fixture.
// It uses the real host-injected run token and checkout; it makes no LLM claims.
const env = process.env;
const base = (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
let issueId = env.PAPERCLIP_TASK_ID;
const agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID;
const runId = env.PAPERCLIP_RUN_ID;
const token = env.PAPERCLIP_API_KEY;
if (![agentId, runId, token].every(Boolean)) throw new Error(`Paperclip process fixture missing authenticated run context: ${JSON.stringify({ agent: !!agentId, run: !!runId, token: !!token })}`);

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Paperclip-Run-Id': runId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

// The pinned process adapter supplies run identity but does not always expose
// PAPERCLIP_TASK_ID. Resolve the assigned issue through that authenticated run.
if (!issueId) {
  const heartbeat = await request('GET', `/api/heartbeat-runs/${runId}`);
  issueId = heartbeat.issueId ?? heartbeat.contextSnapshot?.taskId;
}
if (!issueId) throw new Error('Paperclip heartbeat did not identify an assigned issue');
const issue = await request('GET', `/api/issues/${issueId}`);
const description = issue.description ?? '';
const match = description.match(/PolyForge Graph run ([\w-]+), node ([\w-]+), attempt (\d+)\./);
const rootMatch = description.match(/Root Paperclip issue: ([\w-]+)\./);
const graphMatch = description.match(/Graph version [^;]+; Pack [^\n]+/);
if (!match || !rootMatch) throw new Error(`Fixture issue ${issueId} lacks Graph dispatch metadata`);
const [, graphRunId, nodeId, attemptText] = match;
const attempt = Number(attemptText);
const phase = issue.title?.endsWith(' review') ? 'supervisor' : 'work';
const { pack } = await import(env.POLYFORGE_ADLC_PACK_ENTRY || '/opt/polyforge/adlc-pack/index.mjs');
await request('POST', `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'] });

const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
const dashboard = await request('GET', `${graphPath}?runId=${graphRunId}`);
if (dashboard.run?.id !== graphRunId || dashboard.run.packVersion !== pack.version) throw new Error('Pinned Graph context unavailable to assigned agent');
const node = dashboard.run.graph.nodes.find(item => item.id === nodeId);
if (!node) throw new Error(`Unknown pinned Graph node ${nodeId}`);
const artifactsFor = (id, round) => {
  const existing = dashboard.run.nodeStates[id]?.artifacts ?? [];
  if (existing.length) return existing;
  const source = dashboard.run.graph.nodes.find(item => item.id === id);
  return (source?.produces ?? []).map(kind => ({ kind, id: `${id}-${kind}-attempt${round}`, version: 'v1' }));
};
const artifacts = artifactsFor(nodeId, attempt);
const subjectRefs = artifacts.map(artifact => ({ artifactId: artifact.id, version: artifact.version }));
const command = (operation, fields) => request('POST', graphPath, {
  operation, runId: graphRunId, nodeId, ...fields,
  actor: { kind: 'human', id: 'forged-owner', roles: ['human-owner'] },
  idempotencyKey: `${graphRunId}:${nodeId}:${attempt}:${phase}:${operation}`
});

const reviewed = nodeId === 'minor-design' || nodeId === 'wireframe-a' || nodeId === 'wireframe-b' ||
  nodeId.startsWith('visual-') || ['implementation-plan', 'backend', 'frontend'].includes(nodeId);

if (phase === 'supervisor') {
  await command('review', {
    outcome: 'accept', reason: 'Deterministic fixture independently checked the pinned artifact.',
    evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({ kind, subjectRefs }))
  });
} else if (['classify-design', 'minor-gate', 'promote-directions', 'finalist-route', 'final-design', 'implementation-gate', 'acceptance-gate'].includes(nodeId)) {
  const routes = {
    'classify-design': 'minor', 'minor-gate': 'accept', 'promote-directions': 'a',
    'finalist-route': 'direct', 'final-design': 'accept',
    'implementation-gate': attempt === 1 ? 'rework' : 'accept', 'acceptance-gate': 'accept'
  };
  const kinds = nodeId === 'classify-design' ? ['versioned_requirement', 'design_impact_rationale']
    : nodeId === 'implementation-gate' ? ['candidate_versions', 'independent_review', 'test_reports']
    : nodeId === 'acceptance-gate' ? ['fixed_candidate_identity', 'qa_report', 'security_report', 'regression_report']
    : ['candidate_versions', 'evaluation', 'product_decision_refs'];
  const candidates = nodeId === 'implementation-gate'
    ? ['backend', 'frontend'].flatMap(id => artifactsFor(id, attempt).map(item => ({ artifactId: item.id, version: item.version })))
    : nodeId === 'acceptance-gate' ? artifactsFor('freeze-candidate', 1).map(item => ({ artifactId: item.id, version: item.version })) : [];
  await command('decide', {
    outcome: routes[nodeId], reason: `Deterministic fixture route for ${nodeId}`,
    evidence: kinds.map(kind => ({ kind, subjectRefs: candidates }))
  });
} else {
  const submission = {
    output: { fixture: true, nodeId }, artifacts,
    evidence: [{ kind: 'fixture_result', subjectRefs }]
  };
  await command('submit', submission);
  if (nodeId === 'minor-design') await command('submit', submission); // retry of the same signed callback
  if (reviewed) {
    const selfReview = { artifactVersion: 'v1', findings: [], fixes: [], evidence: [{ kind: 'fixture_self_review', subjectRefs }] };
    await command('self-review', selfReview);
    if (nodeId === 'minor-design') await command('self-review', selfReview);
  }
}

console.log(JSON.stringify({ fixture: 'polyforge', issueId, graphRunId, nodeId, attempt, phase, rootIssueId: rootMatch[1], promptTag: graphMatch?.[0] ?? null }));
