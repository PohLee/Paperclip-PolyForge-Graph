import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalEvidence } from '../src/host/evidence-provider.mjs';
import { pluginId, root, waitFor, request } from './enhancement-client.mjs';

// Real Graph callbacks run in Paperclip process Agents. The release event,
// target and observations are explicitly synthetic local fixture inputs.
export async function runCrossPackCases({ state, save, record, command, read, data, call }) {
  const a = state.development;
  const endpoint = `/api/plugins/${pluginId}/api/company`;
  const graphPath = issueId => `/api/plugins/${pluginId}/api/issues/${issueId}/graph`;
  const graphRead = (issueId, runId) => data('GET', `${graphPath(issueId)}?runId=${runId}`);
  const graphCommand = (issueId, operation, fields, key) => data('POST', graphPath(issueId), {
    operation, ...fields, reason: `Synthetic cross-Pack acceptance: ${operation}`,
    idempotencyKey: `cross-pack:${operation}:${key}`
  });
  const reject = async (name, companyId, operation, fields, key) => {
    const response = await call('POST', endpoint, { companyId, operation, ...fields,
      reason: `Synthetic rejection probe: ${name}`, idempotencyKey: `cross-pack:reject:${key}` }, true);
    assert.ok(response.status >= 400 && response.status < 500,
      `${name} did not receive a scoped rejection: HTTP ${response.status} ${JSON.stringify(response.data)}`);
    return { status: response.status, error: response.data?.error ?? response.data?.message ?? null };
  };

  const fixture = JSON.parse(await readFile(resolve(root, `.e2e/evidence-provider-fixture-${a.companyId}.json`), 'utf8'));
  assert.equal(fixture.companyId, a.companyId);
  await command(a.companyId, 'configure-evidence-providers', { providers: [{ id: 'local-fixture',
    companyId: a.companyId, projectIds: [a.projectId], kinds: ['metric', 'release'],
    maxAgeSeconds: 604800, secretRef: { type: 'secret_ref', secretId: fixture.secretId, version: 'latest' }
  }] }, 'cross-pack:provider-release');
  const companyState = await read(a.companyId);
  assert.equal(companyState.capabilities?.['verified-release-event'], '1.0.0');
  const sourcePackVersion = companyState.enabledPacks.find(item => item.packId === 'adlc')?.version;
  assert.ok(sourcePackVersion, 'ADLC Pack is not enabled');

  if (!state.crossPackReleaseIssue) {
    state.crossPackReleaseIssue = await data('POST', `/api/companies/${a.companyId}/issues`, {
      projectId: a.projectId, title: 'Observe local synthetic release execution',
      description: 'Local fixture event only; no production deployment.', status: 'todo', priority: 'medium'
    });
    await save();
  }
  const releaseIssueId = state.crossPackReleaseIssue.id;
  const currentProductMemory = (await graphRead(state.designIssueId, state.designRunId)).productMemory;
  const productDecisionRefs = currentProductMemory?.active?.map(item => item.id) ?? [];
  assert.ok(productDecisionRefs.length > 0, 'Release work requires the active approved product baseline');
  const sourceInput = {
    feature: 'enhancement-fixture', fixtureScenario: 'cross-pack-release',
    product_decision_refs: productDecisionRefs,
    versioned_requirement: { id: 'REQ-ENHANCEMENT-1', version: 'v1' },
    release_execution_event: { id: 'local-release-execution-event', version: 'v1',
      source: 'synthetic-local-process', result: 'observed-synthetic-deployment' },
    release_plan_identity: { id: 'local-release-plan', version: 'v1' },
    release_authorization_decision: { id: 'local-human-release-authorization', version: 'v1' },
    implementation_candidate: { id: 'local-implementation-candidate', version: 'v1' }
  };
  if (!state.crossPackReleaseRunId) {
    const started = await graphCommand(releaseIssueId, 'start', {
      packId: 'adlc', packVersion: sourcePackVersion,
      graphId: 'release-observation', mode: 'autonomous', input: sourceInput
    }, 'start-release-canonical-v2');
    state.crossPackReleaseRunId = started.run.id;
    await save();
  }
  const releaseRunId = state.crossPackReleaseRunId;
  const pending = await waitFor(async () => {
    const dashboard = await graphRead(releaseIssueId, releaseRunId);
    const run = dashboard.run;
    if (run.status === 'completed') return dashboard;
    if (run.status === 'paused' && run.pendingHuman?.kind === 'decision' &&
        run.pendingHuman.nodeId === 'release-outcome') return dashboard;
    if (run.status !== 'running') throw new Error(`Release observation became ${run.status}`);
    if (run.nodeStates['post-release-observation']?.status === 'completed' &&
        run.nodeStates['release-outcome']?.status === 'pending') return dashboard;
    return null;
  }, 'real release observation process callbacks');
  if (pending.run.status !== 'completed') {
    const candidate = pending.run.nodeStates['record-release-execution'].artifacts.find(item => item.kind === 'release_execution_record');
    assert.ok(candidate?.digest && candidate?.record);
    if (pending.run.status === 'running') await graphCommand(releaseIssueId, 'escalate', {
      runId: releaseRunId, nodeId: 'release-outcome',
      evidence: [{ kind: 'release_execution_record', subjectRefs: [{ artifactId: candidate.id, version: candidate.version }] }]
    }, 'native-release-escalation');
    const paused = await graphRead(releaseIssueId, releaseRunId);
    assert.equal(paused.run.status, 'paused');
    const choice = paused.nativeDecisions.find(item => item.kind === 'decision' && item.nodeId === 'release-outcome');
    assert.ok(choice?.interactionId && !choice.syncError, `Native release Decision unavailable: ${JSON.stringify(paused.nativeDecisionError ?? choice)}`);
    state.crossPackNativeDecisionInteractionId = choice.interactionId;
    await save();
    const interactionsPath = `/api/issues/${releaseIssueId}/interactions`;
    const card = (await data('GET', interactionsPath)).find(item => item.id === choice.interactionId);
    assert.equal(card.status, 'pending');
    assert.equal(card.kind, 'ask_user_questions');
    const questions = card.payload.questionSet.questions;
    assert.ok(questions.some(item => item.id === 'choice'));
    assert.ok(questions.some(item => item.id === 'reason'));
    const respondPath = `${interactionsPath}/${card.id}/respond`;
    const outsiderEmail = `polyforge-decision-outsider-${Date.now()}@example.invalid`;
    const outsider = await request('POST', '/api/auth/sign-up/email', { body: {
      name: 'Synthetic Unassigned Decision User', email: outsiderEmail,
      password: randomBytes(24).toString('base64url')
    } });
    assert.ok(outsider.cookie);
    const outsiderAnswer = await request('POST', respondPath, { cookie: outsider.cookie, allowError: true,
      body: { answers: [{ questionId: 'choice', optionIds: ['complete'] },
        { questionId: 'reason', optionIds: [], otherText: 'Outsider attempted to decide.' },
        ...questions.filter(item => item.id.startsWith('evidence-')).map(item => ({
          questionId: item.id, optionIds: [], otherText: 'Untrusted outsider evidence.'
        }))] } });
    assert.ok(outsiderAnswer.status >= 400 && outsiderAnswer.status < 500,
      `Unassigned user answered a Board Decision: ${outsiderAnswer.status}`);
    assert.equal((await data('GET', interactionsPath)).find(item => item.id === card.id).status, 'pending');
    const ownerAnswers = [{ questionId: 'choice', optionIds: ['complete'] },
      { questionId: 'reason', optionIds: [], otherText: 'The local execution record and observation support only a synthetic completion.' },
      ...questions.filter(item => item.id.startsWith('evidence-')).map(item => ({ questionId: item.id,
        optionIds: [], otherText: `${item.prompt}: ${candidate.id}@${candidate.version} ${candidate.digest}` }))];
    const answered = await data('POST', respondPath, { answers: ownerAnswers });
    assert.equal(answered.status, 'answered');
    const applied = await waitFor(async () => {
      const dashboard = await graphRead(releaseIssueId, releaseRunId);
      if (dashboard.nativeDecisions.some(item => item.syncError)) throw new Error(`Native Decision sync failed: ${JSON.stringify(dashboard.nativeDecisions)}`);
      if (dashboard.run.nodeStates['release-outcome'].status === 'completed') return dashboard;
      return null;
    }, 'native Paperclip Decision applied to release Graph');
    assert.equal(applied.run.nodeStates['release-outcome'].outcome, 'complete');
    assert.ok(applied.decisions.some(item => item.nodeId === 'release-outcome' && item.outcome === 'complete' &&
      item.evidence.some(evidence => evidence.kind === 'paperclip_decision' && evidence.interactionId === card.id)));
    await record('Native Board Decision answer resolves mandatory release gate', {
      runId: releaseRunId, interactionId: card.id, outsiderStatus: outsiderAnswer.status,
      answeredStatus: answered.status, outcome: 'complete'
    });
  }
  const source = await waitFor(async () => {
    const dashboard = await graphRead(releaseIssueId, releaseRunId);
    if (dashboard.run.status === 'completed') return dashboard.run;
    if (dashboard.run.status !== 'running') throw new Error(`Release observation became ${dashboard.run.status}`);
    return null;
  }, 'completed ADLC release observation');
  assert.equal(source.packId, 'adlc');
  assert.equal(source.packVersion, sourcePackVersion);
  assert.equal(source.graph.id, 'release-observation');
  assert.equal(source.nodeStates['release-complete'].status, 'completed');
  const nativeResolution = (await graphRead(releaseIssueId, source.id)).decisions.find(item =>
    item.nodeId === 'release-outcome' && item.outcome === 'complete' &&
    item.evidence?.some(evidence => evidence.kind === 'paperclip_decision' &&
      evidence.interactionId === state.crossPackNativeDecisionInteractionId));
  assert.ok(nativeResolution, 'Release completion must come from the answered native Paperclip Decision');
  const event = source.nodeStates['record-release-execution'].artifacts.find(item => item.kind === 'release_execution_record');
  assert.equal(event.digest, `sha256:${createHash('sha256').update(canonicalEvidence(event.record)).digest('hex')}`);
  for (const key of ['release_execution_event', 'implementation_candidate', 'release_authorization_decision']) {
    assert.ok(event.sourceRefs.some(ref => ref.kind === 'run_input' && ref.key === key &&
      ref.id === source.input[key].id && ref.version === source.input[key].version));
  }
  const executionIds = Object.values(source.nodeStates).flatMap(node => node.attempts ?? [])
    .map(attempt => attempt.actor).filter(actor => actor?.kind === 'agent').map(actor => actor.executionId);
  assert.ok(executionIds.length > 0 && executionIds.every(Boolean));
  for (const id of new Set(executionIds)) assert.equal((await data('GET', `/api/heartbeat-runs/${id}`)).status, 'succeeded');
  await record('ADLC process Agent records observed local release with exact provenance', {
    runId: source.id, packVersion: source.packVersion, graphVersion: source.graph.version,
    event: { id: event.id, version: event.version, digest: event.digest }, processExecutions: executionIds.length
  });

  const ref = { id: event.id, version: event.version, digest: event.digest };
  const handoffFields = { projectId: a.projectId, sourceRunId: source.id, targetPackId: 'marketing',
    targetGraphId: 'acquisition-plan', contract: 'adlc.release-to-marketing', contractVersion: 1,
    sourceEvent: ref, artifacts: [{ ...ref, kind: event.kind }] };
  const missing = await reject('missing release receipt', a.companyId, 'record-handoff', handoffFields, 'missing-receipt');
  if (!state.crossPackReceipt) {
    const now = Date.now();
    state.crossPackReceipt = { id: `local-release-receipt-${source.id}`, providerId: 'local-fixture',
      companyId: a.companyId, projectId: a.projectId, kind: 'release',
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      subjectRefs: [source.input.release_execution_event, source.input.implementation_candidate,
        source.input.release_authorization_decision, ref],
      data: { sourceRunId: source.id, releaseEvent: source.input.release_execution_event,
        candidate: source.input.implementation_candidate,
        authorizationDecisionId: source.input.release_authorization_decision.id }
    };
    await save();
  }
  const receipt = state.crossPackReceipt;
  const signature = createHmac('sha256', fixture.value).update(canonicalEvidence(receipt)).digest('hex');
  const forged = await reject('forged release HMAC', a.companyId, 'import-evidence', {
    projectId: a.projectId, receipt, signature: `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`
  }, 'forged-receipt');
  const wrongScopeReceipt = { ...receipt, id: `${receipt.id}-wrong-project`, projectId: state.marketing.projectId };
  const wrongScopeSignature = createHmac('sha256', fixture.value).update(canonicalEvidence(wrongScopeReceipt)).digest('hex');
  const wrongReceipt = await reject('signed receipt wrong project', a.companyId, 'import-evidence', {
    projectId: a.projectId, receipt: wrongScopeReceipt, signature: wrongScopeSignature
  }, 'wrong-scope-receipt');
  const imported = await command(a.companyId, 'import-evidence', { projectId: a.projectId, receipt, signature },
    `cross-pack:import:${source.id}`);
  assert.equal(imported.id, receipt.id);
  const wrongHandoff = await reject('handoff wrong project', a.companyId, 'record-handoff', {
    ...handoffFields, projectId: state.marketing.projectId, evidenceReceiptId: imported.id
  }, 'wrong-scope-handoff');
  const wrongDigest = await reject('handoff wrong source digest', a.companyId, 'record-handoff', {
    ...handoffFields, sourceEvent: { ...ref, digest: `sha256:${'0'.repeat(64)}` }, evidenceReceiptId: imported.id
  }, 'wrong-digest-handoff');
  const wrongContract = await reject('handoff wrong contract version', a.companyId, 'record-handoff', {
    ...handoffFields, contractVersion: 2, evidenceReceiptId: imported.id
  }, 'wrong-contract-handoff');
  await record('Release HMAC and handoff reject forged missing wrong-scope and stale references', {
    missing, forged, wrongReceipt, wrongHandoff, wrongDigest, wrongContract
  });

  if (!state.crossPackHandoff) {
    state.crossPackHandoff = await command(a.companyId, 'record-handoff', {
      ...handoffFields, evidenceReceiptId: imported.id
    }, `cross-pack:handoff:${source.id}`);
    await save();
  }
  const handoff = state.crossPackHandoff;
  assert.equal(handoff.targetPack.id, 'marketing');
  assert.equal(handoff.targetGraph.id, 'acquisition-plan');
  assert.equal(handoff.sourcePack.version, source.packVersion);
  assert.equal(handoff.projectId, a.projectId);
  if (!state.crossPackMarketingIssue) {
    state.crossPackMarketingIssue = await data('POST', `/api/companies/${a.companyId}/issues`, {
      projectId: a.projectId, title: 'Plan acquisition from authenticated local release',
      description: 'Local proposal only; no campaign publication or spend.', status: 'todo', priority: 'medium'
    });
    await save();
  }
  const marketingIssueId = state.crossPackMarketingIssue.id;
  const marketingInput = { feature: 'enhancement-fixture', fixtureScenario: 'cross-pack-marketing',
    versioned_requirement: source.input.versioned_requirement, sourceRunId: source.id,
    handoffId: handoff.id, release_handoff: { id: handoff.id, version: 'v1', digest: event.digest },
    product_decision_refs: source.input.product_decision_refs };
  assert.deepEqual(marketingInput.product_decision_refs, productDecisionRefs);
  const wrongTarget = await call('POST', graphPath(marketingIssueId), { operation: 'start',
    packId: 'marketing', packVersion: handoff.targetPack.version, graphId: 'acquisition-plan', mode: 'autonomous',
    input: { ...marketingInput, handoffId: 'nonexistent-handoff' },
    reason: 'Reject unpinned target handoff', idempotencyKey: 'cross-pack:reject:wrong-target-handoff' }, true);
  assert.ok(wrongTarget.status >= 400);
  if (!state.crossPackMarketingRunId) {
    const started = await graphCommand(marketingIssueId, 'start', {
      packId: 'marketing', packVersion: handoff.targetPack.version,
      graphId: 'acquisition-plan', mode: 'autonomous', input: marketingInput
    }, `start-marketing:${handoff.id}`);
    state.crossPackMarketingRunId = started.run.id;
    await save();
  }
  const marketing = await waitFor(async () => {
    const dashboard = await graphRead(marketingIssueId, state.crossPackMarketingRunId);
    if (dashboard.run.status === 'completed') return dashboard.run;
    if (dashboard.run.status !== 'running') throw new Error(`Marketing acquisition run became ${dashboard.run.status}`);
    const risk = dashboard.run.nodeStates['assess-plan-risk'];
    if (risk?.status === 'awaiting_supervisor_review') {
      const subjectRefs = risk.artifacts.map(item => ({ artifactId: item.id, version: item.version }));
      const requiredEvidence = dashboard.run.pack.decisionRules.find(rule =>
        rule.type === 'review-disposition' && rule.mode === dashboard.run.mode &&
        rule.allowedRoles.includes('human-owner'))?.requiredEvidence;
      assert.ok(requiredEvidence?.length, 'Human risk review rule missing');
      await graphCommand(marketingIssueId, 'review', {
        runId: dashboard.run.id, nodeId: 'assess-plan-risk', outcome: 'accept',
        evidence: requiredEvidence.map(kind => ({ kind, subjectRefs }))
      }, `human-risk-review:${dashboard.run.id}`);
    }
    return null;
  }, 'completed Marketing acquisition process callbacks');
  assert.equal(marketing.packId, 'marketing');
  assert.equal(marketing.packVersion, handoff.targetPack.version);
  assert.equal(marketing.graph.version, handoff.targetGraph.version);
  assert.equal(marketing.nodeStates['plan-ready'].status, 'completed');
  assert.equal(marketing.input.handoffId, handoff.id);
  assert.equal(marketing.input.projectId, a.projectId);
  const marketingExecutions = Object.values(marketing.nodeStates).flatMap(node => node.attempts ?? [])
    .map(attempt => attempt.actor).filter(actor => actor?.kind === 'agent').map(actor => actor.executionId);
  assert.ok(marketingExecutions.length > 0 && marketingExecutions.every(Boolean));
  for (const id of new Set(marketingExecutions)) assert.equal((await data('GET', `/api/heartbeat-runs/${id}`)).status, 'succeeded');
  const recorded = (await read(a.companyId)).control.handoffs.find(item => item.id === handoff.id);
  assert.equal(recorded.evidenceReceiptId, imported.id);
  await record('Pinned ADLC to Marketing handoff and real acquisition Agent completion', {
    sourceRunId: source.id, sourceArtifactDigest: event.digest, receiptId: imported.id, handoffId: handoff.id,
    targetRunId: marketing.id, targetPackVersion: marketing.packVersion,
    targetGraphVersion: marketing.graph.version, processExecutions: marketingExecutions.length,
    wrongTargetStatus: wrongTarget.status
  });
}
