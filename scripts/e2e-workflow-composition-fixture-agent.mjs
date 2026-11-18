// Synthetic Paperclip Process Agent for workflow composition only.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const base = (env = process.env) => (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const sourceRef = (kind, key) => ({ kind, summary: 'Synthetic fixture source from the pinned workflow input.', sourceRef: { kind: 'run_input', key } });

function adlcPayload(node, run) {
  const input = run.input.workflowInput;
  if (node.outputContract === 'architecture-baseline') return { systemId: input.system_id,
    summary: 'Synthetic fixture architecture baseline; no live system was inspected.', diagram: 'client -> service -> datastore',
    implementationStatus: 'proposed', invariants: [{ id: `INV-E2E-${input.system_id}`,
      rule: 'Only the named service writes its datastore.', enforcement: 'Service boundary', proof: 'Synthetic fixture assertion', status: 'active' }] };
  if (node.outputContract === 'delivery-report') {
    const candidate = input.implementation_candidate, target = input.delivery_target;
    return { candidateRefs: candidate.artifacts, prUrl: target.prUrl, headSha: target.headSha, state: 'open',
      checks: input.required_checks.map(name => ({ name, sourceRef: `synthetic://fixture/check/${encodeURIComponent(name)}`,
        headSha: target.headSha, result: 'unverified' })), approvals: [],
      review: { sourceRef: 'synthetic://fixture/review', headSha: target.headSha, verdict: 'blocked' },
      unresolvedFindings: 1, mergeable: false, observedRequiredApprovals: input.required_approvals };
  }
  throw new Error(`No ADLC fixture is defined for ${node.id}/${node.outputContract}`);
}

function marketingPayload(node, run) {
  if (node.id === 'draft-acquisition-brief') {
    const input = run.input.workflowInput;
    return { acquisition_plan: { proposal: `Synthetic, no-spend validation proposal for ${input.product}. Audience: ${input.audience}. Objective: ${input.objective}. Treat supplied claims as unverified; use a consent-safe test with named ownership, a timebox, measures, and a stop condition.`,
      assumptions: ['Caller-supplied product and audience claims remain unverified.'],
      authorization: 'No publication, messaging, outreach, or spend is authorized.' } };
  }
  if (node.id === 'assess-acquisition-risk') return { risk_assessment: {
    findings: ['Product claims and audience fit are unverified; obtain owner review before public claims or outreach.',
      'This fixture has no spend or messaging authority.'], disposition: 'human-authorization-required' } };
  throw new Error(`No Marketing fixture is defined for ${node.id}`);
}

function artifactByKind(run, nodeId, kind) {
  const artifact = run.nodeStates[nodeId]?.artifacts?.find(item => item.kind === kind);
  if (!artifact?.id || !artifact.version) throw new Error(`Required persisted ${kind} artifact is missing at ${nodeId}`);
  return { id: artifact.id, version: artifact.version };
}

export function creativePayload(node, run, envelopes, decisions = [], reviewerExecutionId) {
  const generated = {};
  const artifactRef = (nodeId, kind) => artifactByKind(run, nodeId, kind);
  const envelope = kind => {
    const item = envelopes.find(row => row.kind === kind);
    if (!item) throw new Error(`Paperclip dispatch omitted artifact envelope for ${kind}`);
    return item;
  };
  for (const kind of node.produces ?? []) {
    const identity = { id: envelope(kind).id, version: envelope(kind).version };
    if (kind === 'brand_evidence_ledger') generated[kind] = { ...identity,
      sources: [{ id: 'caller-input', version: 'v1' }], claims: [],
      unknowns: ['Independent audience and category research is unavailable in this synthetic fixture.'] };
    else if (kind === 'brand_strategy') generated[kind] = { ...identity,
      evidenceRef: artifactRef('collect-brand-evidence', 'brand_evidence_ledger'),
      audience: run.input.workflowInput.targetAudience, positioning: 'A dependable way to coordinate team schedules.',
      promise: run.input.workflowInput.brandPromise, proof: 'Caller supplied points are unverified.' };
    else if (kind === 'brand_territories') generated[kind] = { ...identity,
      strategyRef: artifactRef('develop-brand-strategy', 'brand_strategy'),
      territories: ['calm operational clarity', 'confident team coordination'] };
    else if (kind === 'brand_identity_system') generated[kind] = { ...identity,
      strategyRef: artifactRef('develop-brand-strategy', 'brand_strategy'),
      territoryRef: artifactRef('develop-brand-territory', 'brand_territories'),
      rules: ['Prioritize legibility and clear schedule-change states.'],
      assetRefs: [artifactRef('develop-brand-territory', 'brand_territories')] };
    else if (kind === 'brand_voice_system') generated[kind] = { ...identity,
      strategyRef: artifactRef('develop-brand-strategy', 'brand_strategy'), voice: ['clear', 'calm'],
      messaging: ['Make shift changes clear.'], factBoundaries: ['Do not assert unverified outcomes.'] };
    else if (kind === 'brand_foundation_review') generated[kind] = { ...identity,
      strategyRef: artifactRef('develop-brand-strategy', 'brand_strategy'),
      identityRef: artifactRef('develop-brand-identity', 'brand_identity_system'),
      voiceRef: artifactRef('develop-brand-voice', 'brand_voice_system'),
      disposition: 'ready', findings: [{ id: 'SYNTHETIC-EVIDENCE-GAP', summary: 'Fixture contains no independent audience research.',
        status: 'accepted-exception' }], reviewerExecutionId,
      subjectAuthorExecutionIds: [] };
    else if (kind === 'brand_foundation_package') {
      const decision = decisions.find(item => item.nodeId === 'accept-brand-foundation' && item.outcome === 'ready');
      if (!decision?.id || !decision.at) throw new Error('Persisted ready decision is unavailable for the foundation package');
      generated[kind] = { ...identity,
        strategyRef: artifactRef('develop-brand-strategy', 'brand_strategy'),
        identityRef: artifactRef('develop-brand-identity', 'brand_identity_system'),
        voiceRef: artifactRef('develop-brand-voice', 'brand_voice_system'),
        evidenceRefs: [artifactRef('collect-brand-evidence', 'brand_evidence_ledger')],
        reviewRef: artifactRef('review-brand-foundation', 'brand_foundation_review'),
        acceptanceDecisionRef: { id: decision.id, version: decision.at } };
    } else throw new Error(`No Creative fixture payload is defined for ${kind}`);
  }
  return generated;
}

export async function runWorkflowCompositionFixture(env = process.env) {
  const token = env.PAPERCLIP_API_KEY, agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID, hostRunId = env.PAPERCLIP_RUN_ID;
  if (!token || !agentId || !hostRunId) throw new Error('Fixture is missing Host-injected Agent, run, or credential');
  async function call(method, path, body, { auth = token, run = hostRunId, allowError = false } = {}) {
    const response = await fetch(base(env) + path, { method, headers: { Authorization: `Bearer ${auth}`,
      ...(run ? { 'X-Paperclip-Run-Id': run } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const raw = await response.text(); let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok && !allowError) throw new Error(`${method} ${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
    return { status: response.status, data };
  }
  const heartbeat = (await call('GET', `/api/heartbeat-runs/${hostRunId}`)).data;
  const issueId = env.PAPERCLIP_TASK_ID || heartbeat.issueId || heartbeat.contextSnapshot?.taskId;
  if (!issueId) throw new Error('Authenticated heartbeat did not identify the dispatched issue');
  await call('POST', `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'] });
  const issue = (await call('GET', `/api/issues/${issueId}`)).data;
  assert.equal(issue.assigneeAgentId, agentId); assert.equal(issue.checkoutRunId, hostRunId);
  const match = issue.description?.match(/PolyForge Graph run ([\w-]+), node ([\w-]+), attempt (\d+)\./);
  if (!match) throw new Error('Dispatched issue lacks PolyForge Graph metadata');
  const [, runId, nodeId, attempt] = match;
  const path = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
  const dashboard = (await call('GET', `${path}?runId=${runId}`)).data;
  const run = dashboard.run, node = run.graph.nodes.find(row => row.id === nodeId);
  if (!node) throw new Error(`Dispatched node ${nodeId} is absent from the pinned workflow`);
  if (node.type === 'workflow') throw new Error('Workflow nodes must be started by trusted Host orchestration');
  const phase = issue.title?.endsWith(' review') ? 'supervisor' : 'work';
  const key = `composition:${runId}:${nodeId}:${attempt}:${phase}`;
  const command = (operation, fields = {}) => ({ operation, runId, nodeId, ...fields, idempotencyKey: `${key}:${operation}` });
  const post = async body => {
    for (let retry = 0; ; retry++) {
      try { return await call('POST', path, body); }
      catch (error) {
        // A sibling may commit while the trusted adapter validates. Repeat the
        // same idempotent command through full server validation, never bypass it.
        if (retry >= 4 || !error.message.includes('Run changed since validation; revalidate before applying')) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (retry + 1)));
      }
    }
  };

  if (phase === 'supervisor') {
    const refs = dashboard.run.nodeStates[nodeId].artifacts.map(item => ({ artifactId: item.id, version: item.version }));
    if (!refs.length) throw new Error(`Supervisor review for ${nodeId} has no actual persisted artifact references`);
    await post(command('review', { outcome: 'accept', reason: 'Reviewed synthetic fixture artifacts and their explicit evidence limits.',
      evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({ kind, subjectRefs: refs })) }));
  } else if (node.type === 'decision') {
    const rule = dashboard.run.pack.decisionRules.find(item => item.type === node.decisionType && item.mode === run.mode);
    if (!rule) throw new Error(`Missing pinned decision rule for ${node.decisionType}/${run.mode}`);
    const refs = Object.values(run.nodeStates).flatMap(state => state.artifacts ?? []).map(item => ({ artifactId: item.id, version: item.version }));
    await post(command('decide', { outcome: node.outcomes.includes('hold') ? 'hold' : node.outcomes[0],
      reason: 'Synthetic fixture only; external observation, human approval, and production actions are not asserted.',
      evidence: rule.requiredEvidence.map(kind => ({ kind, subjectRefs: refs })) }));
  } else {
    let output;
    if (run.packId === 'adlc') output = adlcPayload(node, run);
    else if (run.packId === 'marketing') output = marketingPayload(node, run);
    else if (run.packId === 'creative-team') output = null;
    else throw new Error(`Unexpected Pack ${run.packId}`);
    const artifacts = (node.produces ?? []).map(kind => ({ kind, id: `${runId}-${nodeId}-${attempt}-${kind}`, version: 'synthetic-v1' }));
    const payloads = run.packId === 'creative-team' ? creativePayload(node, run, artifacts, dashboard.decisions, hostRunId) : {};
    if (run.packId === 'creative-team') output = {};
    let decisionIds = [];
    if (node.decisionTraceRequired) {
      const choice = (await post(command('record-work-decision', { category: 'process',
        question: `How should synthetic fixture work for ${nodeId} proceed?`, options: [{ id: 'bounded', label: 'Record bounded synthetic evidence' }],
        outcome: 'bounded', reason: 'Synthetic fixture only; no external observation or action is asserted.',
        ruleRef: `node:${nodeId}`, behaviorImpact: 'none', evidence: [sourceRef('requirement', 'workflowInput')] }))).data;
      const decisionId = choice.result?.id ?? choice.decision?.id ?? choice.id;
      if (!decisionId) throw new Error(`Work decision for ${nodeId} returned no persisted identity`);
      decisionIds = [decisionId];
    }
    const submission = command('submit', { output, payloads, artifacts, decisionIds,
      evidence: [{ kind: 'fixture_result', subjectRefs: artifacts.map(item => ({ artifactId: item.id, version: item.version })) }] });
    const wrong = JSON.parse(await readFile(env.POLYFORGE_COMPOSITION_WRONG_AGENT_FILE, 'utf8'));
    assert.notEqual(wrong.id, agentId);
    const before = await call('GET', `${path}?runId=${runId}`);
    const denied = await call('POST', path, submission, { auth: wrong.key, allowError: true });
    const after = await call('GET', `${path}?runId=${runId}`);
    assert.ok([400, 401, 403, 409].includes(denied.status), `wrong Agent credential received HTTP ${denied.status}`);
    // Other ready nodes can legitimately finish while this request is rejected.
    assert.deepEqual(after.data.run.nodeStates[nodeId], before.data.run.nodeStates[nodeId], 'wrong Agent changed its target node');
    assert.deepEqual(after.data.decisions.filter(row => row.nodeId === nodeId), before.data.decisions.filter(row => row.nodeId === nodeId), 'wrong Agent changed target decisions');
    await post(submission);
    if (node.review) {
      const current = (await call('GET', `${path}?runId=${runId}`)).data;
      const actualRefs = current.run.nodeStates[nodeId].artifacts.map(item => ({ artifactId: item.id, version: item.version }));
      if (!actualRefs.length) throw new Error(`Self-review for ${nodeId} has no actual artifact references`);
      await post(command('self-review', { artifactVersion: actualRefs[0].version, findings: [], fixes: [],
        evidence: [{ kind: 'fixture_self_review', subjectRefs: actualRefs }] }));
    }
  }
  // Completing Graph work does not close its native Paperclip assignment. Close
  // this fixture's checked-out task so Host continuation does not replay it.
  await call('PATCH', `/api/issues/${issueId}`, { status: 'done' });
  console.log(JSON.stringify({ stage: 'composition-fixture-action', synthetic: true, issueId, runId, nodeId,
    attempt: Number(attempt), phase, agentId, hostRunId }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWorkflowCompositionFixture().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
