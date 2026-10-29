// Deterministic process adapter for the pinned Paperclip Docker E2E fixture.
// It uses the real host-injected run token and checkout; it makes no LLM claims.
import { createHash } from 'node:crypto';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const env = process.env;
const base = (env.PAPERCLIP_API_BASE || env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
let issueId = env.PAPERCLIP_TASK_ID;
const agentId = env.PAPERCLIP_AGENT_ID || env.AGENT_ID;
const runId = env.PAPERCLIP_RUN_ID;
const token = env.PAPERCLIP_API_KEY;
if (![agentId, runId, token].every(Boolean)) throw new Error(`Paperclip process fixture missing authenticated run context: ${JSON.stringify({ agent: !!agentId, run: !!runId, token: !!token })}`);

async function request(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (response.ok) return data;
    // Graph callbacks carry a stable idempotency key. A timed-out RPC may have
    // committed, so retry only those calls or reads, never an unkeyed mutation.
    if ((method === 'GET' || body?.idempotencyKey) && [502, 503].includes(response.status) && attempt < 2) {
      await new Promise(done => setTimeout(done, 250 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  }
}

// The pinned process adapter supplies run identity but does not always expose
// PAPERCLIP_TASK_ID. Resolve the assigned issue through that authenticated run.
if (!issueId) {
  const heartbeat = await request('GET', `/api/heartbeat-runs/${runId}`);
  issueId = heartbeat.issueId ?? heartbeat.contextSnapshot?.taskId;
  if (!issueId) {
    const context = heartbeat.contextSnapshot ?? {};
    const message = context.paperclipAgentMessage;
    if (message?.source === 'plugin_session' && message.pluginKey === 'pohlee.polyforge-graph' &&
        context.taskKey?.startsWith('plugin:pohlee.polyforge-graph:session:shadow:')) {
      const text = message.text ?? '';
      const jsonStart = text.indexOf('\n{');
      if (jsonStart < 0 || !text.startsWith('Perform one independent review of this authenticated candidate snapshot.')) {
        throw new Error('Shadow fixture received an unexpected bounded review prompt');
      }
      const packet = JSON.parse(text.slice(jsonStart + 1));
      if (packet.kind !== 'polyforge-shadow-review-v1' || !packet.sourceRunId || !packet.snapshotId ||
          !Array.isArray(packet.candidates) || !packet.candidates.length ||
          packet.candidates.some(item => !item.id || !item.version || !item.kind)) {
        throw new Error('Shadow fixture received an invalid pinned candidate packet');
      }
      const candidate = packet.candidates[0];
      console.log(JSON.stringify({ status: 'reviewed', fixture: 'local-process-shadow-review',
        snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId,
        findings: [{ severity: 'P3', summary: 'Synthetic fixture inspected this pinned artifact reference; no production quality claim.',
          sourceRef: { kind: candidate.kind, id: candidate.id, version: candidate.version, digest: candidate.digest ?? null } }] }));
      process.exit(0);
    }
  }
}
if (!issueId) throw new Error('Paperclip heartbeat did not identify an assigned issue');
const issue = await request('GET', `/api/issues/${issueId}`);
const description = issue.description ?? '';
if (issue.originKind === 'plugin:pohlee.polyforge-graph:strategy') {
  if (issue.companyId !== env.PAPERCLIP_COMPANY_ID || issue.assigneeAgentId !== agentId || !issue.originId) {
    throw new Error('CEO strategy fixture requires a company-scoped assigned native strategy issue');
  }
  const company = await request('GET', `/api/plugins/pohlee.polyforge-graph/api/company?companyId=${issue.companyId}`);
  const control = company.control ?? {}, organization = control.organization;
  if (organization?.ceo?.id !== agentId ||
      !organization.authorityPolicy?.ceoOperations?.includes('strategy') ||
      !organization.authorityPolicy?.ceoOperations?.includes('decision') ||
      !organization.authorityPolicy?.ceoDecisions?.includes('strategy')) {
    throw new Error('Board did not delegate this CEO strategy decision');
  }
  const escalation = control.escalations?.find(item => item.id === issue.originId &&
    item.subjectType === 'strategy' && item.status === 'pending' && item.eligibleRole === 'ceo');
  const review = control.reviews?.find(item => item.id === escalation?.subjectId && item.projectId === issue.projectId);
  const observed = review?.observations?.filter(item => item.status === 'observed' && item.evidenceReceiptId &&
    item.source === 'local-fixture' && typeof item.value === 'number') ?? [];
  if (!escalation || !observed.length || !escalation.evidence?.some(item => item.kind === 'outcome-review' &&
      item.reviewId === review.id && observed.every(row => item.receiptIds?.includes(row.evidenceReceiptId)))) {
    throw new Error('CEO strategy fixture requires the exact sourced local outcome review');
  }
  const subordinate = organization.domainHeads?.find(item => item.domain === 'product') ?? organization.domainHeads?.[0];
  const prior = control.goalHistory?.filter(item => item.scope === 'agent' && item.subjectId === subordinate?.agentId).at(-1);
  if (!prior?.goals?.length || !prior.goals[0].keyResults?.length) {
    throw new Error('CEO strategy fixture requires a subordinate Agent goal revision');
  }
  const goals = structuredClone(prior.goals);
  goals[0].keyResults[0].target += 1;
  await request('POST', `/api/issues/${issueId}/checkout`, {
    agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review']
  });
  await request('POST', '/api/plugins/pohlee.polyforge-graph/api/company', {
    companyId: issue.companyId, operation: 'adjudicate', escalationId: escalation.id, outcome: 'propose',
    evidence: [{ kind: 'observed-outcome', reviewId: review.id, receiptIds: observed.map(item => item.evidenceReceiptId) }],
    reason: 'Deterministic CEO fixture approved one bounded subordinate goal revision',
    idempotencyKey: `ceo-fixture:strategy-decision:${escalation.id}`
  });
  const adjustment = await request('POST', '/api/plugins/pohlee.polyforge-graph/api/company', {
    companyId: issue.companyId, operation: 'adjust-strategy', reviewId: review.id,
    changes: [{ subjectId: subordinate.agentId, goals }],
    reason: 'Deterministic local strategy fixture used an authenticated observed metric',
    idempotencyKey: `ceo-fixture:strategy-adjust:${review.id}`
  });
  if (!adjustment.adjustment?.goalRevisionIds?.length) throw new Error('CEO strategy fixture did not revise subordinate goals');
  await request('PATCH', `/api/issues/${issueId}`, { status: 'done' });
  console.log(JSON.stringify({ fixture: 'local-process-ceo-strategy', status: 'adjusted', issueId,
    escalationId: escalation.id, reviewId: review.id, priorRevisionId: prior.id,
    revisionIds: adjustment.adjustment.goalRevisionIds, executionId: runId }));
  process.exit(0);
}
if (issue.originKind === 'plugin:pohlee.polyforge-graph:intake') {
  if (issue.companyId !== env.PAPERCLIP_COMPANY_ID || issue.assigneeAgentId !== agentId || !issue.originId) {
    throw new Error('CEO intake fixture requires a company-scoped assigned native intake issue');
  }
  // Only this declared synthetic case has a deterministic route. Ordinary
  // user requests remain assigned to the CEO for real judgment.
  if (!description.startsWith('Synthetic CEO intake fixture:')) {
    console.log(JSON.stringify({ fixture: 'local-process-ceo-intake', status: 'needs-semantic-review',
      issueId, intakeId: issue.originId }));
    process.exit(0);
  }
  const company = await request('GET', `/api/plugins/pohlee.polyforge-graph/api/company?companyId=${issue.companyId}`);
  const organization = company.control?.organization;
  if (organization?.ceo?.id !== agentId) throw new Error('This process Agent is not the bound company CEO');
  const head = organization.domainHeads?.find(item => item.domain === 'product') ?? organization.domainHeads?.[0];
  if (!head?.agentId || head.agentId === agentId) throw new Error('Synthetic intake has no distinct delegated domain head');
  await request('POST', `/api/issues/${issueId}/checkout`, {
    agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review']
  });
  const routed = await request('POST', '/api/plugins/pohlee.polyforge-graph/api/company', {
    companyId: issue.companyId, operation: 'route-intake', intakeId: issue.originId,
    outcome: 'assign', assigneeId: head.agentId,
    reason: 'Deterministic local CEO intake fixture assigned its declared product request',
    idempotencyKey: `ceo-fixture:intake:${issue.originId}`
  });
  if (routed.intake?.status !== 'offered' || routed.intake.assigneeId !== head.agentId) {
    throw new Error('Synthetic CEO intake did not produce a delegated offer');
  }
  console.log(JSON.stringify({ fixture: 'local-process-ceo-intake', status: 'assigned',
    issueId, intakeId: issue.originId, assigneeId: head.agentId, executionId: runId }));
  process.exit(0);
}
if (issue.title?.startsWith('PolyForge CEO authority fixture')) {
  const prefix = 'PolyForge CEO authority fixture\n';
  if (!description.startsWith(prefix) || issue.assigneeAgentId !== agentId) {
    throw new Error('CEO authority fixture requires its assigned issue and exact prompt prefix');
  }
  const packet = JSON.parse(description.slice(prefix.length));
  if (packet.companyId !== issue.companyId || packet.companyId !== env.PAPERCLIP_COMPANY_ID ||
      !Array.isArray(packet.commands) || !packet.commands.length || packet.commands.length > 12) {
    throw new Error('CEO authority fixture packet has invalid company scope or command count');
  }
  await request('POST', `/api/issues/${issueId}/checkout`, {
    agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review']
  });
  const allowed = new Set(['route-intake', 'create-plan', 'set-goals', 'adjudicate']);
  const results = [];
  for (const entry of packet.commands) {
    if (!allowed.has(entry.operation) || !['ok', 'denied'].includes(entry.expect) ||
        !entry.idempotencyKey?.startsWith('ceo-fixture:') || !entry.fields ||
        typeof entry.fields !== 'object' || Array.isArray(entry.fields)) {
      throw new Error('CEO authority fixture received an out-of-contract command');
    }
    const response = await fetch(`${base}/api/plugins/pohlee.polyforge-graph/api/company`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Paperclip-Run-Id': runId,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry.fields, companyId: packet.companyId,
        operation: entry.operation, reason: 'Deterministic CEO authority fixture',
        idempotencyKey: entry.idempotencyKey })
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch { result = { error: raw.slice(0, 300) }; }
    if (entry.expect === 'ok' ? !response.ok : ![400, 403].includes(response.status)) {
      throw new Error(`CEO authority ${entry.operation} expected ${entry.expect}, got HTTP ${response.status}: ${JSON.stringify(result)}`);
    }
    results.push({ operation: entry.operation, expected: entry.expect, status: response.status,
      resultId: result?.id ?? result?.plan?.id ?? result?.decision?.id ?? null,
      error: entry.expect === 'denied' ? result?.error ?? result?.message ?? null : null });
  }
  await request('PATCH', `/api/issues/${issueId}`, { status: 'done' });
  console.log(JSON.stringify({ fixture: 'polyforge-ceo-authority', companyId: packet.companyId,
    issueId, executionId: runId, results }));
  process.exit(0);
}
const match = description.match(/PolyForge Graph run ([\w-]+), node ([\w-]+), attempt (\d+)\./);
const rootMatch = description.match(/Root Paperclip issue: ([\w-]+)\./);
const graphMatch = description.match(/Graph version [^;]+; Pack [^\n]+/);
if (!match || !rootMatch) throw new Error(`Fixture issue ${issueId} lacks Graph dispatch metadata`);
const [, graphRunId, nodeId, attemptText] = match;
const attempt = Number(attemptText);
const phase = issue.title?.endsWith(' review') ? 'supervisor' : 'work';
await request('POST', `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'] });

const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
const dashboard = await request('GET', `${graphPath}?runId=${graphRunId}`);
if (dashboard.run?.id !== graphRunId || !dashboard.run.packVersion) throw new Error('Pinned Graph context unavailable to assigned agent');
const node = dashboard.run.graph.nodes.find(item => item.id === nodeId);
if (!node) throw new Error(`Unknown pinned Graph node ${nodeId}`);
const scenario = dashboard.run.input?.fixtureScenario ?? 'default';
if (scenario === 'shadow-review' && nodeId === 'qa' && phase === 'work') {
  const endpoint = '/api/plugins/pohlee.polyforge-graph/api/company';
  const reviewerId = dashboard.run.input.fixtureShadowReviewerId;
  if (!reviewerId || reviewerId === agentId) throw new Error('Independent local Shadow reviewer missing');
  const opened = await request('POST', endpoint, {
    companyId: issue.companyId, operation: 'open-shadow', parentRunId: graphRunId,
    parentTaskId: nodeId, parentIssueId: issueId, agentId: reviewerId,
    reason: 'Owning deterministic QA fixture requests an isolated candidate review',
    idempotencyKey: `shadow-agent:${graphRunId}:${nodeId}:${attempt}`,
  });
  const deadline = Date.now() + 90_000;
  let closed;
  while (Date.now() < deadline) {
    const current = await request('GET', `${endpoint}?companyId=${issue.companyId}`);
    closed = current.control?.shadows?.find(item => item.id === opened.shadowId && item.status === 'closed');
    if (closed) break;
    await new Promise(done => setTimeout(done, 500));
  }
  if (closed?.outcome !== 'completed' || closed.requestedBy?.id !== agentId ||
      closed.requestedBy?.executionId !== runId || closed.executionId === runId) {
    throw new Error('Agent-triggered Shadow did not finish in a distinct authenticated execution');
  }
}
const conflictScenario = ['cross-handoff', 'conflict-continue', 'conflict-stop'].includes(scenario);
const artifactsFor = (id, round) => {
  const existing = dashboard.run.nodeStates[id]?.artifacts ?? [];
  if (existing.length && (id !== nodeId || phase === 'supervisor' || dashboard.run.nodeStates[id].status !== 'pending')) return existing;
  const source = dashboard.run.graph.nodes.find(item => item.id === id);
  return (source?.produces ?? []).map(kind => {
    const artifact = { kind, id: `${graphRunId}-${id}-${kind}-attempt${round}`, version: 'v1' };
    return scenario === 'shadow-review' ? { ...artifact,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(artifact)).digest('hex')}` } : artifact;
  });
};
let artifacts = artifactsFor(nodeId, attempt);
if (scenario === 'cross-pack-release' && nodeId === 'record-release-execution' && phase === 'work') {
  const input = dashboard.run.input;
  const sourceKeys = ['release_execution_event', 'implementation_candidate', 'release_authorization_decision'];
  const sourceRefs = sourceKeys.map(key => ({ kind: 'run_input', key, id: input[key].id, version: input[key].version }));
  const record = { fixture: 'local-process-release-observation', sourceRunId: graphRunId,
    executionEvent: input.release_execution_event, candidate: input.implementation_candidate,
    authorizationDecision: input.release_authorization_decision, releasePlan: input.release_plan_identity,
    operator: 'local-process-fixture', target: 'synthetic-local-target', result: 'observed-synthetic-deployment' };
  const digest = `sha256:${createHash('sha256').update(canonical(record)).digest('hex')}`;
  artifacts = [{ kind: 'release_execution_record', id: `${graphRunId}-release-execution-record`,
    version: 'v1', digest, record, sourceRefs }];
}
if (scenario === 'cross-pack-marketing' && nodeId === 'pin-release-handoff' && phase === 'work') {
  const input = dashboard.run.input;
  const record = { fixture: 'local-process-marketing-handoff', sourceRunId: input.sourceRunId,
    handoffId: input.handoffId, releaseHandoff: input.release_handoff,
    productDecisionRefs: input.product_decision_refs, targetRunId: graphRunId };
  artifacts = [{ kind: 'release_handoff_record', id: `${graphRunId}-release-handoff-record`, version: 'v1',
    digest: `sha256:${createHash('sha256').update(canonical(record)).digest('hex')}`, record }];
}
const subjectRefs = artifacts.map(artifact => ({ artifactId: artifact.id, version: artifact.version }));
const command = (operation, fields, keySuffix = '') => request('POST', graphPath, {
  operation, runId: graphRunId, nodeId, ...fields,
  actor: { kind: 'human', id: 'forged-owner', roles: ['human-owner'] },
  idempotencyKey: `${graphRunId}:${nodeId}:${attempt}:${phase}:${operation}:${keySuffix}`
});

const reviewed = Boolean(node.review);

if (phase === 'supervisor') {
  const reviewBase = {
    reason: 'Deterministic fixture independently checked the pinned artifact.',
    evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({ kind, subjectRefs }))
  };
  if (scenario === 'severe-five' && nodeId === 'minor-design' && attempt === 1) {
    let denied = false;
    try { await command('review', { ...reviewBase, outcome: 'accept' }, 'forbidden-severe-accept'); }
    catch (error) { denied = /unresolved P0\/P1|known risk/i.test(error.message); if (!denied) throw error; }
    if (!denied) throw new Error('Unresolved severe finding was automatically accepted');
    await command('review', { ...reviewBase, outcome: 'rework', reason: 'P1 remains after five rounds; require a new attempt.' }, 'severe-rework');
  } else await command('review', { ...reviewBase, outcome: 'accept' });
} else if (['classify-design', 'minor-gate', 'promote-directions', 'finalist-route', 'final-design',
  'classify-implementation', 'readiness-gate', 'implementation-shape', 'implementation-gate', 'acceptance-gate',
  'plan-disposition'].includes(nodeId)) {
  const routes = {
    'classify-design': scenario === 'major-full' ? 'major' : 'minor', 'minor-gate': 'accept',
    'promote-directions': scenario === 'major-full' ? 'both' : 'a',
    'finalist-route': scenario === 'major-full' ? 'prototype' : 'direct', 'final-design': 'accept',
    'classify-implementation': scenario === 'defect-full' ? 'defect' : 'feature',
    'readiness-gate': 'proceed', 'implementation-shape': 'parallel',
    'implementation-gate': scenario.startsWith('conflict-') ? 'accept' : attempt === 1 ? 'rework' : 'accept',
    'acceptance-gate': 'accept', 'plan-disposition': 'ready'
  };
  const kinds = dashboard.run.pack.decisionRules.find(rule => rule.type === node.decisionType && rule.mode === dashboard.run.mode).requiredEvidence;
  const candidates = (node.candidateNodes ?? []).flatMap(id => artifactsFor(id, attempt)
    .filter(item => !node.candidateKinds || node.candidateKinds.includes(item.kind))
    .map(item => ({ artifactId: item.id, version: item.version })));
  const selectedFinalists = scenario === 'major-full' && nodeId === 'final-design'
    ? dashboard.run.nodeStates['filter-finalists']?.attempts.at(-1)?.output?.selectedFinalists ?? [] : [];
  const finalSelection = selectedFinalists.at(-1);
  const decisionPayload = {
    outcome: routes[nodeId], reason: `Deterministic fixture route for ${nodeId}`,
    evidence: kinds.map(kind => ({ kind, subjectRefs: selectedFinalists.length ? selectedFinalists : candidates })),
    ...(finalSelection ? { artifacts: [{ id: finalSelection.artifactId, version: finalSelection.version,
      kind: 'final_design_identity' }] } : {})
  };
  let skipDecision = false;
  if (conflictScenario && nodeId === 'implementation-gate' && attempt === (scenario === 'cross-handoff' ? 2 : 1) &&
      !dashboard.run.conflicts?.some(item => item.nodeId === nodeId && item.status === 'resolved')) {
    const positions = Object.fromEntries(['cpo', 'cto-caio'].map(side => [side,
      dashboard.decisions.findLast(item => item.type === 'conflict_position' && item.conflictRole === side)]));
    if (!positions.cpo?.id || !positions['cto-caio']?.id) throw new Error('Missing same-run signed conflict positions');
    const opened = await command('open-conflict', {
      positionDecisionIds: { cpo: positions.cpo.id, cto: positions['cto-caio'].id },
      negotiation: [{ dimension: 'risk', issue: 'Product timing versus technical regression risk',
        proposal: 'Bound the scope and retain regression checks', cpoResponse: 'Proceed within bounded scope',
        ctoResponse: 'Require human risk disposition', evidence: [{ kind: 'requirement', summary: 'Current requirement', sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }] }],
      unresolved: [{ dimension: 'risk', issue: 'Residual regression risk', options: ['Proceed with current checks', 'Require mitigation'] }],
      options: [{ id: 'proceed', label: 'Proceed with checks', disposition: 'continue' },
        { id: 'replan', label: 'Replan and rerun implementation', disposition: 'rework', targetNodeId: 'implementation-plan' },
        { id: 'stop', label: 'Stop this Graph after conflict', disposition: 'stop' }],
      reason: 'The two trusted role positions remain different after documented negotiation.'
    });
    const conflictId = opened.result?.id;
    if (!conflictId) throw new Error('open-conflict returned no conflict ID');
    let resolution = null;
    for (let poll = 0; poll < 120; poll++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const current = await request('GET', `${graphPath}?runId=${graphRunId}`);
      const resolvedConflict = current.run?.conflicts?.find(item => item.id === conflictId && item.status === 'resolved');
      if (['running', 'stopped'].includes(current.run?.status) && resolvedConflict) {
        resolution = current.decisions.find(item => item.id === resolvedConflict.resolutionDecisionId);
        break;
      }
    }
    if (!resolution) throw new Error('Human owner did not resolve the fixture conflict within two minutes');
    if (['rework', 'stop'].includes(resolution.disposition)) skipDecision = true;
    else if (resolution.disposition === 'continue') decisionPayload.evidence.push({ kind: 'conflict_resolution', decisionId: resolution.id });
    else throw new Error(`Unexpected conflict disposition ${resolution.disposition}`);
  }
  if (scenario === 'cross-handoff' && nodeId === 'implementation-gate' && attempt > 1 && !skipDecision) {
    const stale = node.candidateNodes.flatMap(id => (dashboard.run.nodeStates[id]?.attempts[0]?.artifacts ?? [])
      .filter(item => !node.candidateKinds || node.candidateKinds.includes(item.kind))
      .map(item => ({ artifactId: item.id, version: item.version })));
    if (!stale.length) throw new Error('Missing first-attempt candidates for stale evidence probe');
    let denied = false;
    try { await command('decide', { ...decisionPayload, evidence: [
      ...kinds.map(kind => ({ kind, subjectRefs: stale })),
      ...decisionPayload.evidence.filter(item => item.kind === 'conflict_resolution')
    ] }, 'stale-candidate-probe'); }
    catch (error) { denied = /current|candidate|subject|stale|version/i.test(error.message); if (!denied) throw error; }
    if (!denied) throw new Error('Stale implementation candidate evidence was accepted');
  }
  if (node.selection && scenario === 'major-full' && nodeId === 'final-design') {
    let multipleDenied = false, staleDenied = false;
    try { await command('decide', { ...decisionPayload,
      artifacts: selectedFinalists.map(item => ({ id: item.artifactId, version: item.version })) }, 'multiple-finalists-probe'); }
    catch (error) { multipleDenied = /exactly one|single|one artifact/i.test(error.message); if (!multipleDenied) throw error; }
    try { await command('decide', { ...decisionPayload,
      artifacts: [{ id: 'stale-finalist', version: 'v0' }] }, 'stale-finalist-probe'); }
    catch (error) { staleDenied = /shortlist|frozen|candidate|current|selection/i.test(error.message); if (!staleDenied) throw error; }
    if (!multipleDenied || !staleDenied) throw new Error('Final selection accepted multiple or stale artifacts');
  }
  if (!skipDecision) await command('decide', decisionPayload);
} else {
  if (conflictScenario && ['cpo-alignment', 'cto-alignment'].includes(nodeId)) {
    const side = nodeId === 'cpo-alignment' ? 'cpo' : 'cto-caio';
    await command('record-conflict-position', {
      side, stance: side === 'cpo' ? 'go' : 'modify',
      reason: side === 'cpo' ? 'Fixture product outcome favors the candidate.' : 'Fixture technical risk requires bounded mitigation.',
      dimensions: {
        scope: 'Current approved feature only', timeline: 'This acceptance run', resources: 'Bounded fixture capacity',
        risk: side === 'cpo' ? 'Product delay risk' : 'Technical regression risk', successCriteria: 'Pass pinned acceptance checks'
      },
      nonNegotiables: [side === 'cpo' ? 'Preserve user outcome' : 'Preserve regression checks'],
      evidence: [{ kind: 'requirement', summary: 'Current versioned feature requirement', sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }]
    }, `position-${side}`);
  }
  if (scenario === 'major-full' && nodeId === 'principle-research') {
    let denied = false;
    try {
      await command('product-decision', {
        feature: dashboard.run.input.feature, status: 'approved', outcome: 'Unauthorized fixture change',
        reason: 'Authorization probe; this agent is not the human owner.',
        evidence: ['current_product_decision', 'proposed_change', 'user_impact'].map(kind => ({ kind, summary: 'Authorization probe' }))
      }, 'unauthorized-product-probe');
    } catch (error) { denied = /human|role|authoriz|permission/i.test(error.message); if (!denied) throw error; }
    if (!denied) throw new Error('Agent managed to approve a product replacement');
  }
  let decisionIds = [];
  if (node.decisionTraceRequired) {
    const traced = await command('record-work-decision', {
      category: ['ui-ux-designer-lead', 'product-owner', 'product-manager', 'cpo'].includes(node.role) ? 'product' : 'engineering',
      question: `Which pinned procedure applies to ${nodeId}?`,
      options: [{ id: 'pinned-node', label: 'Follow the pinned Graph task and active product decision' }],
      outcome: 'pinned-node', reason: `The pinned ${nodeId} task defines this deterministic fixture output.`,
      ruleRef: `node:${nodeId}`, behaviorImpact: 'none',
      evidence: [{ kind: 'requirement', summary: 'Current versioned requirement', sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }]
    });
    const id = traced.result?.id ?? traced.decision?.id ?? traced.id;
    if (!id) throw new Error(`record-work-decision returned no ID for ${nodeId}`);
    decisionIds = [id];
  }
  const selectedFinalists = scenario === 'major-full' && nodeId === 'filter-finalists'
    ? ['a1', 'b1'].map(id => artifactsFor(`freeze-${id}`, attempt)[0]).map(item => ({ artifactId: item.id, version: item.version }))
    : null;
  const blindedEvaluation = scenario === 'major-full' && nodeId === 'blind-evaluator'
    ? ['wireframe-a', 'wireframe-b'].map((id, index) => {
      const source = artifactsFor(id, attempt)[0];
      return { code: `direction-${index + 1}`, sourceRef: { artifactId: source.id, version: source.version },
        score: index === 0 ? 82 : 79, criteria: ['requirement_fit', 'accessibility', 'interaction_clarity'] };
    }) : null;
  const defectEvidence = scenario === 'defect-full' && nodeId === 'defect-diagnosis'
    ? { reproduction: 'Synthetic fixture input triggers incorrect branch', firstDivergence: 'Expected protected branch differs from observed fixture branch',
        workingComparison: 'Baseline fixture branch remains correct', hypothesis: 'Synthetic routing condition is inverted' }
    : scenario === 'defect-full' && nodeId === 'defect-red-check'
      ? { checkId: `red-${graphRunId}`, expectedBeforeFix: 'fail', observedBeforeFix: 'fail',
          diagnosedCause: 'Synthetic routing condition is inverted' } : null;
  const submission = {
    output: { fixture: true, nodeId, ...(selectedFinalists ? { selectedFinalists } : {}),
      ...(node.outputContract === 'work-plan' ? {
        tickets: [{ id: 'T-1', deliverable: 'Fixture outcome', owner: 'lead-engineer',
          verification: 'Fixture check', blockers: [] }]
      } : {}),
      ...(node.outputContract === 'work-completion' ? {
        candidateRefs: artifacts.filter(item => item.kind === 'implementation_candidate')
          .map(item => ({ artifactId: item.id, version: item.version })),
        tickets: [{ id: 'T-1', result: 'complete', evidenceRef: `fixture://${graphRunId}/check`,
          observed: 'Fixture check passed' }]
      } : {}),
      ...(node.outputContract === 'acceptance-matrix' ? {
        candidateRefs: (dashboard.run.input.implementation_candidate.artifacts ?? [dashboard.run.input.implementation_candidate])
          .map(item => ({ artifactId: item.artifactId ?? item.id, version: item.version })),
        criteria: dashboard.run.input.acceptance_criteria.map(row => ({ id: row.id, result: 'pass',
          evidence: [{ kind: 'report', ref: `fixture://${graphRunId}/qa`, observed: 'Synthetic fixture pass; no real application test claim' }] }))
      } : {}),
      ...(blindedEvaluation ? { blindedEvaluation } : {}), ...(defectEvidence ? { defectEvidence } : {}) }, artifacts, decisionIds,
    evidence: [{ kind: 'fixture_result', subjectRefs }]
  };
  await command('submit', submission);
  if (nodeId === 'minor-design') await command('submit', submission); // retry of the same signed callback
  if (reviewed) {
    const severe = scenario === 'severe-five' && nodeId === 'minor-design' && attempt === 1;
    const selfReview = { artifactVersion: 'v1', findings: severe ? [{ severity: 'P1', status: 'open', summary: 'Fixture severe finding remains unresolved' }] : [],
      fixes: [], evidence: [{ kind: 'fixture_self_review', subjectRefs }] };
    for (let round = 1; round <= (severe ? 5 : 1); round++) await command('self-review', selfReview, `round-${round}`);
    if (nodeId === 'minor-design' && !severe) await command('self-review', selfReview, 'round-1');
  }
}

console.log(JSON.stringify({ fixture: 'polyforge', issueId, graphRunId, nodeId, attempt, phase, rootIssueId: rootMatch[1], promptTag: graphMatch?.[0] ?? null }));
