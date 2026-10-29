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
await request('POST', `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ['todo', 'backlog', 'in_progress', 'in_review'] });

const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${issueId}/graph`;
const dashboard = await request('GET', `${graphPath}?runId=${graphRunId}`);
if (dashboard.run?.id !== graphRunId || !dashboard.run.packVersion) throw new Error('Pinned Graph context unavailable to assigned agent');
const node = dashboard.run.graph.nodes.find(item => item.id === nodeId);
if (!node) throw new Error(`Unknown pinned Graph node ${nodeId}`);
const scenario = dashboard.run.input?.fixtureScenario ?? 'default';
const conflictScenario = ['cross-handoff', 'conflict-continue', 'conflict-stop'].includes(scenario);
const artifactsFor = (id, round) => {
  const existing = dashboard.run.nodeStates[id]?.artifacts ?? [];
  if (existing.length && (id !== nodeId || phase === 'supervisor' || dashboard.run.nodeStates[id].status !== 'pending')) return existing;
  const source = dashboard.run.graph.nodes.find(item => item.id === id);
  return (source?.produces ?? []).map(kind => ({ kind, id: `${graphRunId}-${id}-${kind}-attempt${round}`, version: 'v1' }));
};
const artifacts = artifactsFor(nodeId, attempt);
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
  'classify-implementation', 'readiness-gate', 'implementation-shape', 'implementation-gate', 'acceptance-gate'].includes(nodeId)) {
  const routes = {
    'classify-design': scenario === 'major-full' ? 'major' : 'minor', 'minor-gate': 'accept',
    'promote-directions': scenario === 'major-full' ? 'both' : 'a',
    'finalist-route': scenario === 'major-full' ? 'prototype' : 'direct', 'final-design': 'accept',
    'classify-implementation': scenario === 'defect-full' ? 'defect' : 'feature',
    'readiness-gate': 'proceed', 'implementation-shape': 'parallel',
    'implementation-gate': scenario.startsWith('conflict-') ? 'accept' : attempt === 1 ? 'rework' : 'accept',
    'acceptance-gate': 'accept'
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
