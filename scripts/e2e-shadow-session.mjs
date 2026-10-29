import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, pluginId, root, waitFor } from './enhancement-client.mjs';
import { fixtureContractInputs } from './fixture-contract-inputs.mjs';

// Real Paperclip SDK session lifecycle against a synthetic local process Agent.
// No model adapter is invoked by this case.
export async function runShadowSessionCase({ state, command, read, data, record }) {
  const { companyId, projectId, issueId } = state.development;
  const before = await read(companyId);
  const bindings = before.config?.roleBindings ?? {};
  const reviewerId = bindings['adlc:product-manager'];
  assert.ok(reviewerId && reviewerId !== bindings.ceo, 'Distinct bound review fixture Agent required');
  const reviewer = await data('GET', `/api/agents/${reviewerId}`);
  assert.equal(reviewer.adapterType, 'process');
  assert.equal(reviewer.adapterConfig?.command, 'node');
  assert.deepEqual(reviewer.adapterConfig?.args, ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs']);
  assert.ok(reviewer.adapterConfig.timeoutSec > 0 && reviewer.adapterConfig.timeoutSec <= 900);
  assert.ok(reviewer.budgetMonthlyCents > reviewer.spentMonthlyCents);

  const nonce = Date.now().toString(36);
  const graphPath = `/api/plugins/${pluginId}/api/issues/${issueId}/graph`;
  const graphCommand = (operation, fields) => data('POST', graphPath, {
    operation, ...fields, reason: `Synthetic local Shadow acceptance: ${operation}`,
    idempotencyKey: `shadow-fixture:${nonce}:${operation}`,
  });
  const requirementId = `REQ-SHADOW-${nonce}`;
  const baseline = await graphCommand('product-decision', {
    feature: `shadow-fixture-${nonce}`, status: 'approved', outcome: 'Preserve the synthetic verification baseline',
    evidence: [{ kind: 'synthetic_requirement', id: requirementId }],
  });
  const started = await graphCommand('start', {
    packId: 'adlc', graphId: 'verification', mode: 'assisted',
    input: { ...fixtureContractInputs('verification', requirementId), fixtureScenario: 'shadow-review',
      fixtureShadowReviewerId: reviewerId,
      feature: `shadow-fixture-${nonce}`, projectId,
      versioned_requirement: { id: requirementId, version: 'v1' },
      product_decision_refs: [baseline.result.id], productDecisionRefs: [baseline.result.id],
      implementation_candidate: { id: `synthetic-candidate-${nonce}`, version: 'v1' } },
  });
  const runId = started.run.id;
  const atGate = await waitFor(async () => {
    const current = await data('GET', `${graphPath}?runId=${runId}`);
    if (!['running', 'paused'].includes(current.run.status)) {
      throw new Error(`Shadow fixture parent Graph ended before gate: ${current.run.status}`);
    }
    return current.ready?.some((item) => item.id === 'acceptance-gate') ? current : null;
  }, 'pinned verification candidate at human gate', 180_000);
  const frozen = atGate.run.nodeStates['freeze-candidate'].artifacts;
  const matrix = atGate.run.nodeStates['acceptance-matrix'].artifacts;
  assert.ok([...frozen, ...matrix].every((item) => item.id && item.version && item.digest));
  const afterAgentReview = await read(companyId);
  const agentShadow = afterAgentReview.control.shadows?.find(item => item.parentRunId === runId &&
    item.parentTaskId === 'qa' && item.requestedBy?.kind === 'agent');
  assert.ok(agentShadow, 'Owning namespaced QA Agent created a Shadow');
  assert.equal(agentShadow.requestedBy.id, bindings['adlc:qa-engineer']);
  assert.notEqual(agentShadow.executionId, agentShadow.requestedBy.executionId);
  assert.equal(agentShadow.status, 'closed');
  assert.equal(agentShadow.outcome, 'completed');
  assert.deepEqual(agentShadow.goalContext, atGate.run.goalContext);
  assert.equal(agentShadow.reviewResult?.status, 'synthetic-fixture-reviewed');
  await record?.('Owning namespaced Graph Agent triggers independent bounded Shadow', {
    companyId, runId, shadowId: agentShadow.id, executionId: agentShadow.executionId,
    parentExecutionId: agentShadow.requestedBy.executionId, outcome: agentShadow.outcome,
  });
  const key = `shadow-fixture:${nonce}:open`;
  const fields = { parentRunId: runId, parentTaskId: 'acceptance-gate', agentId: reviewerId };
  const opened = await command(companyId, 'open-shadow', fields, key);
  assert.ok(opened.shadowId && opened.sessionId && opened.executionId);
  assert.ok(Date.parse(opened.deadlineAt) - Date.now() <= 900_000);
  const closed = await waitFor(async () => {
    const current = await read(companyId);
    return current.control.shadows?.find((item) => item.id === opened.shadowId && item.status === 'closed') ?? null;
  }, 'local Shadow session completion', 120_000);
  assert.equal(closed.outcome, 'completed');
  assert.equal(closed.executionId, opened.executionId);
  assert.equal(closed.sessionId, opened.sessionId);
  assert.deepEqual(closed.goalContext, atGate.run.goalContext);
  assert.equal(closed.reviewResult?.status, 'synthetic-fixture-reviewed');
  assert.match(closed.reviewResult.outputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(closed.reviewResult.findings.length);
  const candidate = closed.reviewResult.findings[0].sourceRef;
  assert.ok([...frozen, ...matrix].some((item) => item.id === candidate.id &&
    item.version === candidate.version && item.digest === candidate.digest));
  const heartbeat = await data('GET', `/api/heartbeat-runs/${opened.executionId}`);
  assert.equal(heartbeat.companyId, companyId);
  assert.equal(heartbeat.agentId, reviewerId);
  assert.equal(heartbeat.status, 'succeeded');
  const replay = await command(companyId, 'open-shadow', fields, key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.shadowId, opened.shadowId);
  const changed = await data('POST', `/api/plugins/${pluginId}/api/company`, {
    companyId, operation: 'open-shadow', ...fields, agentId: bindings['adlc:qa-engineer'],
    reason: 'Synthetic changed Shadow replay must fail', idempotencyKey: key,
  }).then(() => ({ accepted: true }), () => ({ accepted: false }));
  assert.equal(changed.accepted, false);
  const proof = { companyId, runId, shadowId: closed.id, parentTaskId: closed.parentTaskId,
    sessionId: closed.sessionId, executionId: closed.executionId,
    snapshotId: closed.contextRef.snapshotId, findings: closed.reviewResult.findings.length,
    outcome: closed.outcome, reviewer: 'local deterministic process fixture' };
  await record?.('Real bounded Shadow SDK session and pinned candidate review', proof);
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = JSON.parse(await readFile(resolve(root, '.e2e/enhancement-checkpoint.json'), 'utf8'));
  const { data } = await client();
  const endpoint = `/api/plugins/${pluginId}/api/company`;
  const read = (companyId) => data('GET', `${endpoint}?companyId=${companyId}`);
  const command = (companyId, operation, fields, key) => data('POST', endpoint, {
    companyId, operation, ...fields, reason: `Synthetic local Shadow session: ${operation}`,
    idempotencyKey: key,
  });
  console.log(JSON.stringify(await runShadowSessionCase({ state, command, read, data }), null, 2));
}
