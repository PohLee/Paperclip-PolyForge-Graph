// Deterministic Docker acceptance against real Paperclip managed process agents.
// Requires the prior e2e.mjs bootstrap and an installed/upgraded plugin. It does
// not assert that an LLM designed, coded, or independently reasoned about work.
import assert from 'node:assert/strict';
import { fixtureContractInputs } from './fixture-contract-inputs.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignOrganization } from '../src/plugin/alignment.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const origin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const plugin = 'pohlee.polyforge-graph';
const auth = JSON.parse(await readFile(resolve(root, '.e2e/auth.json'), 'utf8'));
const prior = JSON.parse(await readFile(resolve(root, '.e2e/result.json'), 'utf8'));
const localPack = (await import(pathToFileURL(resolve(root, '..', 'Paperclip-PolyForge-Graph-ADLC', 'index.mjs')).href)).pack;
const expectedPackVersion = process.env.POLYFORGE_ACCEPTANCE_PACK_VERSION || localPack.version;
assert.equal(expectedPackVersion, localPack.version,
  'Acceptance expects the currently loaded Pack source; use its matching published source for an older version');
const expectedGraphVersion = graphId => localPack.graphs.find(item => item.id === graphId)?.version;
const hasDefectRoute = localPack.graphs.find(item => item.id === 'implementation')?.nodes.some(item => item.id === 'defect-diagnosis');
const legacyCheckpointPath = resolve(root, '.e2e/acceptance-checkpoint.json');
const legacyCheckpoint = await readFile(legacyCheckpointPath, 'utf8').then(JSON.parse).catch(() => null);
const checkpointPath = legacyCheckpoint?.packVersion === expectedPackVersion
  ? legacyCheckpointPath : resolve(root, `.e2e/acceptance-checkpoint-${expectedPackVersion}.json`);
const priorCheckpoint = await readFile(checkpointPath, 'utf8').then(JSON.parse).catch(() => null);
assert.ok(!priorCheckpoint || priorCheckpoint.packVersion === expectedPackVersion,
  `Checkpoint ${checkpointPath} belongs to Pack ${priorCheckpoint?.packVersion}, expected ${expectedPackVersion}`);
const checkpoint = priorCheckpoint ?? { packVersion: expectedPackVersion,
  suffix: randomUUID().slice(0, 8), runs: {}, completed: {} };
const suffix = checkpoint.suffix;
const invocationId = randomUUID().slice(0, 8);
const saveCheckpoint = () => writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function http(method, path, body, { anonymous = false, optional = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: origin, ...(anonymous ? {} : { Cookie: auth.cookie }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 300) }; }
  if (!response.ok && !optional) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

async function reject(method, path, body, pattern, options) {
  const response = await http(method, path, body, { ...options, optional: true });
  assert.ok(response.status >= 400, `${method} ${path} unexpectedly succeeded`);
  if (pattern) assert.match(JSON.stringify(response.data), pattern);
  return response.status;
}

async function waitFor(predicate, label, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  let last, lastHostError;
  while (Date.now() < deadline) {
    try { last = await predicate(); }
    catch (error) {
      if (!/-> 50[23]:/.test(String(error))) throw error;
      lastHostError = String(error);
      last = null;
    }
    if (last) return last;
    await sleep(1800);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}; hostError=${lastHostError ?? 'none'}`);
}

const source = (key = 'versioned_requirement') => ({ kind: 'requirement', summary: `Current ${key}`,
  sourceRef: { kind: 'run_input', key } });
const productEvidence = ['superseded_decision_id', 'replacement_rationale', 'impact_analysis'].map(kind => ({ kind, summary: `${kind} for deterministic acceptance`, sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }));

async function runAcceptance() {
  assert.equal((await http('GET', '/api/auth/get-session')).data?.user?.id, auth.userId);
  const installed = (await http('GET', `/api/plugins/${plugin}`)).data;
  assert.equal(installed.status, 'ready');
  let company, issue;
  if (checkpoint.companyId && checkpoint.issueId) {
    company = { id: checkpoint.companyId }; issue = { id: checkpoint.issueId };
  } else {
    company = (await http('POST', '/api/companies', { name: `PolyForge acceptance ${suffix}`,
      description: 'Isolated deterministic host acceptance; not LLM business validation' })).data;
    issue = (await http('POST', `/api/companies/${company.id}/issues`, { title: `ADLC acceptance ${suffix}`,
      description: 'Deterministic three-Graph acceptance fixture', status: 'todo', priority: 'medium' })).data;
    checkpoint.companyId = company.id; checkpoint.issueId = issue.id;
    await saveCheckpoint();
  }
  const path = `/api/plugins/${plugin}/api/issues/${issue.id}/graph`;
  let seq = 0;
  const command = (operation, fields = {}) => http('POST', path, { operation, ...fields,
    idempotencyKey: `acceptance:${suffix}:${invocationId}:${++seq}:${operation}` }).then(value => value.data);
  const read = runId => http('GET', `${path}?runId=${runId}`).then(value => value.data);
  if (!checkpoint.provisioned) {
    const provision = await command('provision', { reason: 'Bind isolated managed fixture agents and bundled Pack skills' });
    assert.equal(Object.keys(provision.roleBindings ?? {}).length, 11);
    assert.equal(provision.skills?.length, Object.keys(localPack.skills).length);
    await command('configure', { roleBindings: provision.roleBindings,
      userRoles: { [auth.userId]: ['product-owner', 'cpo', 'cto-caio', 'principal-engineer'] },
      defaultMode: 'autonomous', reason: 'Authorized synthetic owner for acceptance gates' });
    checkpoint.provisioned = true;
    await saveCheckpoint();
  }
  if (!checkpoint.organizationAligned) {
    const { plan, confirmation } = await alignOrganization({
      companyId: company.id, issueId: issue.id, newKey: randomUUID,
      command: fields => http('POST', path, fields).then(value => value.data),
      readAgent: agentId => http('GET', `/api/agents/${agentId}`).then(value => value.data),
      patchAgent: (agentId, reportsTo) => http('PATCH', `/api/agents/${agentId}`, { reportsTo }).then(value => value.data)
    });
    assert.equal(plan.assignments?.length, 11);
    assert.equal(plan.assignments.filter(item => item.toReportsTo === null).length, 2);
    assert.equal(plan.assignments.filter(item => item.toReportsTo !== null).length, 9);
    assert.equal(confirmation.aligned, true);
    checkpoint.organizationAligned = true;
    await saveCheckpoint();
  }
  const feature = `acceptance-feature-${suffix}`;
  const baseline = checkpoint.baselineId ? { id: checkpoint.baselineId }
    : (await command('product-decision', { feature, status: 'approved', outcome: 'Preserve fixture baseline',
      reason: 'Approved deterministic product baseline', evidence: [{ kind: 'requirement', id: `REQ-${suffix}` }] })).result;
  assert.ok(baseline.id);
  checkpoint.baselineId = baseline.id;
  await saveCheckpoint();
  const baseInput = { feature, versioned_requirement: { id: `REQ-${suffix}`, version: 'v1' },
    product_decision_refs: [baseline.id], productDecisionRefs: [baseline.id] };
  const start = async (key, graphId, fixtureScenario, input = baseInput, mode = 'autonomous') => {
    if (checkpoint.runs[key]) return checkpoint.runs[key];
    const result = await command('start', { graphId, mode, input: { ...fixtureContractInputs(graphId, input.versioned_requirement.id), ...input, fixtureScenario } });
    assert.equal(result.run.packVersion, expectedPackVersion);
    assert.equal(result.run.graph.version, expectedGraphVersion(graphId));
    checkpoint.runs[key] = result.run.id;
    await saveCheckpoint();
    return result.run.id;
  };
  const complete = async (runId, label) => waitFor(async () => {
    const state = await read(runId);
    if (state.run?.status === 'completed') return state;
    if (state.run?.status && !['running', 'paused'].includes(state.run.status)) throw new Error(`${label}: ${state.run.status}`);
    return null;
  }, label);
  const successfulHeartbeats = async (state, label) => {
    const attempts = Object.values(state.run.nodeStates).flatMap(item => item.attempts ?? []);
    const ids = [...new Set([...attempts.map(item => item.actor?.executionId),
      ...state.decisions.map(item => item.actor?.executionId)].filter(Boolean))];
    assert.ok(ids.length > 0, `${label} has no managed agent execution`);
    for (const id of ids) {
      const heartbeat = (await http('GET', `/api/heartbeat-runs/${id}`)).data;
      assert.equal(heartbeat.status, 'succeeded', `${label} heartbeat ${id} failed`);
      assert.equal(heartbeat.companyId, company.id);
    }
    return ids.length;
  };
  const assertWorkTrace = state => {
    const records = new Map(state.decisions.map(item => [item.id, item]));
    for (const node of state.run.graph.nodes.filter(item => item.type === 'task' && item.decisionTraceRequired)) {
      for (const attempt of state.run.nodeStates[node.id].attempts.filter(item => item.actor?.kind === 'agent')) {
        assert.ok(attempt.decisionIds?.length > 0, `${node.id} missing work decision IDs`);
        for (const id of attempt.decisionIds) {
          const decision = records.get(id);
          assert.equal(decision?.type, 'work_choice');
          assert.equal(decision.nodeId, node.id);
          assert.equal(decision.actor.executionId, attempt.actor.executionId);
          assert.equal(decision.attemptNumber, state.run.nodeStates[node.id].attempts.indexOf(attempt) + 1);
        }
      }
    }
  };

  // A: full major design branch, real managed agents, exact candidate identity.
  const designId = await start('majorDesign', 'ui-ux-design', 'major-full');
  const design = await complete(designId, 'major design');
  const completedExecution = nodeId => {
    const attempt = design.run.nodeStates[nodeId].attempts.findLast(item => item.actor?.executionId && item.output);
    assert.ok(attempt, `${nodeId} has no completed managed execution`);
    return attempt.actor.executionId;
  };
  const requiredDesignNodes = ['principle-research', 'wireframe-a', 'wireframe-b', 'design-norms-check',
    'product-owner-fit', 'blind-evaluator', 'filter-finalists', 'prototype-a', 'prototype-b', 'experiment-comparison'];
  for (const id of requiredDesignNodes) assert.equal(design.run.nodeStates[id].status, 'completed', id);
  assert.equal(design.run.graph.nodes.find(item => item.id === 'blind-evaluator').isolation, 'blind-anonymized-input');
  assert.notEqual(completedExecution('blind-evaluator'), completedExecution('wireframe-a'));
  const blindOutput = design.run.nodeStates['blind-evaluator'].attempts[0].output.blindedEvaluation;
  assert.deepEqual(blindOutput.map(item => item.code), ['direction-1', 'direction-2']);
  assert.ok(blindOutput.every(item => !('author' in item) && item.sourceRef?.artifactId && item.sourceRef?.version));
  const visualIds = ['a1','a2','a3','a4','b1','b2','b3','b4'];
  const visualIdentities = [];
  for (const id of visualIds) {
    const visual = design.run.nodeStates[`visual-${id}`].artifacts[0];
    const frozen = design.run.nodeStates[`freeze-${id}`].artifacts[0];
    const qc = design.run.nodeStates[`qc-${id}`].artifacts[0];
    assert.equal(visual.kind, `visual_candidate_${id}`);
    assert.equal(frozen.kind, `frozen_visual_${id}`);
    assert.equal(qc.kind, `visual_qc_${id}`);
    assert.ok(visual.id !== frozen.id && frozen.id !== qc.id);
    assert.notEqual(completedExecution(`visual-${id}`), completedExecution(`qc-${id}`));
    visualIdentities.push(`${visual.id}@${visual.version}`);
  }
  assert.equal(new Set(visualIdentities).size, 8);
  assert.notEqual(design.run.nodeStates['prototype-a'].artifacts[0].id, design.run.nodeStates['prototype-b'].artifacts[0].id);
  assert.notEqual(completedExecution('prototype-a'), completedExecution('prototype-b'));
  const finalists = design.run.nodeStates['filter-finalists'].attempts.at(-1).output.selectedFinalists;
  assert.equal(finalists.length, 2);
  for (const ref of finalists) assert.ok(visualIds.some(id => design.run.nodeStates[`freeze-${id}`].artifacts
    .some(item => item.id === ref.artifactId && item.version === ref.version)));
  const finalDecision = design.decisions.findLast(item => item.nodeId === 'final-design' && item.outcome === 'accept');
  assert.ok(finalDecision?.id);
  const selectedDesign = finalDecision.artifacts.map(item => ({ artifactId: item.id, version: item.version }));
  if (design.run.graph.nodes.find(item => item.id === 'final-design').selection) {
    assert.equal(selectedDesign.length, 1);
    assert.ok(finalists.some(item => item.artifactId === selectedDesign[0].artifactId && item.version === selectedDesign[0].version));
  } else assert.deepEqual(selectedDesign, finalists);
  assertWorkTrace(design);
  const designHeartbeats = await successfulHeartbeats(design, 'major design');
  const designHandoff = { id: selectedDesign[0].artifactId, version: selectedDesign[0].version,
    selectedCandidates: finalists, decisionId: finalDecision.id };
  console.log(`A major design passed: 8 distinct candidates, 2 finalists, ${designHeartbeats} successful heartbeats`);

  // B: five P1 self-review rounds lead to independent rework, never automatic acceptance.
  const severeId = await start('severeFive', 'ui-ux-design', 'severe-five');
  const severe = await complete(severeId, 'five-round severe finding');
  const minor = severe.run.nodeStates['minor-design'];
  assert.equal(minor.attempts.length, 2);
  assert.equal(minor.attempts[0].selfReviews.length, 5);
  assert.ok(minor.attempts[0].selfReviews.every(item => item.findings.some(finding => finding.severity === 'P1' && finding.status === 'open')));
  assert.equal(minor.attempts[0].supervisorReview.outcome, 'rework');
  assert.equal(minor.attempts[1].supervisorReview.outcome, 'accept');
  const severeHeartbeats = await successfulHeartbeats(severe, 'five-round review');
  console.log(`B severe review passed: five unresolved rounds, independent rework, ${severeHeartbeats} successful heartbeats`);

  // F: real versioned Design -> Implementation -> Verification handoffs.
  const implementationId = await start('implementation', 'implementation', 'cross-handoff', { ...baseInput, final_design_identity: designHandoff });
  const implementationConflictState = await waitFor(async () => {
    const state = await read(implementationId);
    return state.run.conflicts?.some(item => item.protocolVersion === 2) ? state : null;
  }, 'same-run CPO/CTO conflict');
  const conflict = implementationConflictState.run.conflicts.find(item => item.protocolVersion === 2);
  const cpoPosition = implementationConflictState.decisions.find(item => item.id === conflict.positionDecisionIds.cpo);
  const ctoPosition = implementationConflictState.decisions.find(item => item.id === conflict.positionDecisionIds.cto);
  assert.equal(cpoPosition?.runId, implementationId);
  assert.equal(ctoPosition?.runId, implementationId);
  assert.notEqual(cpoPosition.actor.executionId, ctoPosition.actor.executionId);
  let resolved;
  if (conflict.status === 'waiting_human') {
    checkpoint.pausedConflict = { companyId: company.id, issueId: issue.id,
      runId: implementationId, conflictId: conflict.id, observedAt: new Date().toISOString() };
    await saveCheckpoint();
    console.log(`BROWSER_QA_CONFLICT ${JSON.stringify(checkpoint.pausedConflict)}`);
    await sleep(Number(process.env.POLYFORGE_ACCEPTANCE_CONFLICT_HOLD_MS ?? 60_000));
    assert.ok([401, 403].includes(await reject('POST', path, { operation: 'resolve-conflict', runId: implementationId,
      conflictId: conflict.id, outcome: 'replan', reason: 'Forged anonymous approval', evidence: [source()] }, null, { anonymous: true })));
    resolved = (await command('resolve-conflict', { runId: implementationId, conflictId: conflict.id,
      outcome: 'replan', reason: 'Human owner requires a new implementation plan and candidate.', evidence: [source()] })).result;
  } else {
    resolved = { decision: implementationConflictState.decisions.find(item => item.id === conflict.resolutionDecisionId) };
  }
  checkpoint.conflictResolutionId = resolved.decision.id;
  delete checkpoint.pausedConflict;
  await saveCheckpoint();
  assert.equal(resolved.decision.actor.kind, 'human');
  assert.equal(resolved.decision.actor.id, auth.userId);
  assert.equal(resolved.decision.disposition, 'rework');
  assert.ok(resolved.decision.effect);
  const implementation = await complete(implementationId, 'implementation rework');
  assert.deepEqual(implementation.run.input.final_design_identity, designHandoff);
  assert.equal(implementation.run.nodeStates['implementation-plan'].attempts.length, 3);
  assert.equal(implementation.run.nodeStates['implementation-gate'].attempts[1].outcome, 'conflict_rework');
  assert.equal(implementation.run.nodeStates['implementation-gate'].attempts.length, 3);
  const currentCandidates = ['integrate-candidate'].flatMap(id => implementation.run.nodeStates[id].artifacts
    .filter(item => item.kind === 'implementation_candidate')
    .map(item => ({ kind: item.kind, artifactId: item.id, version: item.version })));
  assert.equal(currentCandidates.length, 1);
  const implementationGate = implementation.decisions.findLast(item => item.nodeId === 'implementation-gate' && item.outcome === 'accept');
  assert.ok(implementationGate?.id);
  assertWorkTrace(implementation);
  const implementationHeartbeats = await successfulHeartbeats(implementation, 'implementation');
  const implementationHandoff = { artifacts: currentCandidates, decisionId: implementationGate.id };
  let verificationId = await start('verification', 'verification', 'cross-handoff', { ...baseInput, implementation_candidate: implementationHandoff });
  let verification = await complete(verificationId, 'verification');
  assert.deepEqual(verification.run.input.implementation_candidate, implementationHandoff);
  assert.equal(verification.run.nodeStates['freeze-candidate'].artifacts[0].kind, 'fixed_candidate_identity');
  assert.ok(verification.decisions.some(item => item.nodeId === 'acceptance-gate' && item.outcome === 'accept'));
  assertWorkTrace(verification);
  let verificationHeartbeats;
  try { verificationHeartbeats = await successfulHeartbeats(verification, 'verification'); }
  catch (error) {
    if (checkpoint.failedVerificationId) throw error;
    checkpoint.failedVerificationId = verificationId;
    checkpoint.failedVerificationReason = String(error);
    delete checkpoint.runs.verification;
    await saveCheckpoint();
    verificationId = await start('verification', 'verification', 'cross-handoff', { ...baseInput, implementation_candidate: implementationHandoff });
    verification = await complete(verificationId, 'verification rerun after failed host heartbeat');
    assert.deepEqual(verification.run.input.implementation_candidate, implementationHandoff);
    assertWorkTrace(verification);
    verificationHeartbeats = await successfulHeartbeats(verification, 'verification rerun');
  }
  console.log(`F cross-Graph handoff passed: implementation ${implementationHeartbeats}, verification ${verificationHeartbeats} successful heartbeats`);

  let defectId = null, defectHeartbeats = 0;
  if (hasDefectRoute) {
    defectId = await start('defect', 'implementation', 'defect-full', { ...baseInput, final_design_identity: designHandoff });
    const defect = await complete(defectId, 'defect diagnosis and red reproduction');
    for (const id of ['defect-diagnosis', 'defect-red-check', 'implementation-readiness', 'readiness-gate',
      'implementation-plan', 'backend', 'frontend']) assert.equal(defect.run.nodeStates[id].status, 'completed', id);
    const diagnosis = defect.run.nodeStates['defect-diagnosis'].attempts.at(-1);
    const red = defect.run.nodeStates['defect-red-check'].attempts.at(-1);
    assert.equal(diagnosis.artifacts[0].kind, 'root_cause_report');
    assert.ok(diagnosis.output.defectEvidence.firstDivergence && diagnosis.output.defectEvidence.hypothesis);
    assert.equal(red.artifacts[0].kind, 'failing_regression_check');
    assert.equal(red.output.defectEvidence.observedBeforeFix, 'fail');
    assert.ok(defect.decisions.some(item => item.nodeId === 'classify-implementation' && item.outcome === 'defect'));
    assert.ok(defect.decisions.some(item => item.nodeId === 'readiness-gate' && item.outcome === 'proceed'));
    assertWorkTrace(defect);
    defectHeartbeats = await successfulHeartbeats(defect, 'defect implementation');
    console.log(`F defect route passed: root cause, red reproduction, readiness, build; ${defectHeartbeats} successful heartbeats`);
  }

  // D: the implementation run itself paused for the independently signed positions.
  assert.equal(conflict.protocolVersion, 2);
  assert.equal(conflict.negotiation.length, 1);
  assert.equal(implementation.run.conflicts.find(item => item.id === conflict.id)?.status, 'resolved');
  assert.ok(implementation.decisions.some(item => item.id === resolved.decision.id));
  console.log('D conflict passed: signed positions, negotiated disagreement, human decision, resumed run');

  // E: proposed and approved supersession; stale product references fail start.
  const memoryFeature = `acceptance-memory-${suffix}`;
  const memoryBaseline = checkpoint.memoryBaselineId ? { id: checkpoint.memoryBaselineId }
    : (await command('product-decision', { feature: memoryFeature, status: 'approved',
      outcome: 'Original approved behavior', reason: 'Initial test decision', evidence: [{ kind: 'requirement', id: 'MEM-1' }] })).result;
  checkpoint.memoryBaselineId = memoryBaseline.id;
  await saveCheckpoint();
  const memoryInput = { feature: memoryFeature, versioned_requirement: { id: 'MEM-1', version: 'v1' },
    product_decision_refs: [memoryBaseline.id] };
  const memoryRunId = await start('memoryProposal', 'ui-ux-design', 'memory-proposal', memoryInput, 'manual');
  const proposed = checkpoint.memoryProposedId ? { id: checkpoint.memoryProposedId }
    : (await command('product-decision', { runId: memoryRunId, feature: memoryFeature,
      status: 'proposed', outcome: 'Approved changed behavior', supersedes: memoryBaseline.id,
      changeScope: ['MEM-1'], reason: 'Propose a bounded feature change', evidence: productEvidence })).result;
  checkpoint.memoryProposedId = proposed.id;
  await saveCheckpoint();
  if (!checkpoint.memoryApprovedId) await reject('POST', path, { operation: 'product-decision', runId: memoryRunId, feature: memoryFeature,
    status: 'approved', outcome: 'Approved changed behavior', supersedes: memoryBaseline.id,
    changeScope: ['MEM-1'], reason: 'Approval without proposal', evidence: productEvidence,
    idempotencyKey: `acceptance:${suffix}:missing-proposal` }, /proposal/i);
  const approved = checkpoint.memoryApprovedId ? { id: checkpoint.memoryApprovedId, proposalId: proposed.id }
    : (await command('product-decision', { runId: memoryRunId, feature: memoryFeature,
      status: 'approved', outcome: 'Approved changed behavior', supersedes: memoryBaseline.id,
      proposalId: proposed.id, changeScope: ['MEM-1'], reason: 'Human owner approves proposed bounded change',
      evidence: productEvidence })).result;
  checkpoint.memoryApprovedId = approved.id;
  await saveCheckpoint();
  assert.equal(approved.proposalId, proposed.id);
  await reject('POST', path, { operation: 'start', graphId: 'ui-ux-design', mode: 'manual', input: memoryInput,
    idempotencyKey: `acceptance:${suffix}:stale-product-ref` }, /active|product decision/i);
  const currentMemoryRunId = await start('memoryCurrent', 'ui-ux-design', 'memory-current', { ...memoryInput, product_decision_refs: [approved.id] }, 'manual');
  assert.equal((await read(currentMemoryRunId)).run.packVersion, expectedPackVersion);
  console.log('E memory passed: proposed/approved link, missing proposal and stale references rejected');

  // C: an earlier published Pack run continues with its old pinned graph after new Pack is installed.
  const oldPath = `/api/plugins/${plugin}/api/issues/${prior.issueId}/graph`;
  const oldRead = () => http('GET', `${oldPath}?runId=${prior.manualRunId}`).then(value => value.data);
  const oldBefore = await oldRead();
  assert.ok(['0.1.0', '0.1.1'].includes(oldBefore.run.packVersion));
  if (oldBefore.run.status !== 'completed') {
    assert.equal(oldBefore.run.nodeStates['classify-design'].status, 'pending');
    await http('POST', oldPath, { operation: 'decide', runId: prior.manualRunId, nodeId: 'classify-design', outcome: 'none',
      reason: 'Human owner resumes the old pinned Pack run after upgrading the installed Pack.',
      evidence: [{ kind: 'versioned_requirement' }, { kind: 'design_impact_rationale' }],
      idempotencyKey: `acceptance:${suffix}:old-run-resume` });
  }
  const oldAfter = await waitFor(async () => { const state = await oldRead(); return state.run.status === 'completed' ? state : null; }, 'old Pack run completion');
  assert.equal(oldAfter.run.packVersion, oldBefore.run.packVersion);
  assert.equal(oldAfter.run.graph.version, oldBefore.run.graph.version);
  const newId = await start('newPinned', 'ui-ux-design', 'new-pack-snapshot');
  const newRun = await complete(newId, 'new Pack run');
  assert.equal(newRun.run.packVersion, expectedPackVersion);
  assert.equal(newRun.run.graph.version, '0.1.1');
  console.log(`C version pin passed: old ${oldAfter.run.packVersion}/${oldAfter.run.graph.version}, new ${newRun.run.packVersion}/${newRun.run.graph.version}`);

  const actualRuns = { 'ui-ux-design': design.run, implementation: implementation.run, verification: verification.run };
  for (const [id, actual] of Object.entries(actualRuns)) {
    assert.equal(actual.packVersion, expectedPackVersion, `${id} Pack snapshot differs from acceptance source`);
    assert.equal(actual.graph.version, expectedGraphVersion(id), `${id} graph snapshot differs from acceptance source`);
  }
  const result = { kind: 'deterministic-host-fixture', pluginVersion: installed.version, companyId: company.id,
    issueId: issue.id, feature, packVersion: design.run.packVersion,
    graphVersions: Object.fromEntries(Object.entries(actualRuns).map(([id, actual]) => [id, actual.graph.version])),
    runs: { majorDesign: designId, severeFive: severeId, implementation: implementationId, defect: defectId,
      verification: verificationId, conflict: implementationId, memoryProposal: memoryRunId,
      memoryCurrent: currentMemoryRunId, oldPinned: prior.manualRunId, newPinned: newId },
    hostFailures: checkpoint.failedVerificationId ? { failedVerificationId: checkpoint.failedVerificationId,
      reason: checkpoint.failedVerificationReason } : {},
    heartbeats: { majorDesign: designHeartbeats, severeFive: severeHeartbeats,
      implementation: implementationHeartbeats, verification: verificationHeartbeats, defect: defectHeartbeats },
    decisionIds: { finalDesign: finalDecision.id, implementationGate: implementationGate.id,
      cpoPosition: cpoPosition.id, ctoPosition: ctoPosition.id, conflictResolution: resolved.decision.id,
      productProposal: proposed.id, productApproved: approved.id },
    limitations: ['Deterministic process fixture does not establish LLM business-quality output.',
      'The new Pack version was deployed before this script; deployment transition timing is external evidence.'] };
  await writeFile(resolve(root, `.e2e/acceptance-result-${expectedPackVersion}.json`), JSON.stringify(result, null, 2));
  return result;
}

runAcceptance().then(result => console.log(`A–F Docker acceptance passed; evidence .e2e/acceptance-result-${result.packVersion}.json; company ${result.companyId}`))
  .catch(error => { console.error(error); process.exitCode = 1; });
