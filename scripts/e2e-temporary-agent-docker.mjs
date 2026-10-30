// Deterministic Docker acceptance of native Paperclip fresh sessions. This
// changes one existing idle process Agent and restores its configuration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { client as defaultClient, waitFor as defaultWaitFor,
  pluginId } from './enhancement-client.mjs';

const companyId = process.env.POLYFORGE_TEMPORARY_COMPANY_ID ??
  '102d94df-b5e6-432f-af03-57440e026124';
const projectId = process.env.POLYFORGE_TEMPORARY_PROJECT_ID ??
  '4c3410ed-3a05-47b5-b13e-7b1f20e2071d';
const agentId = process.env.POLYFORGE_TEMPORARY_AGENT_ID ??
  'dd618a1d-cacf-42ab-b921-f1cff84ff1ec';
const clientPath = process.env.POLYFORGE_E2E_CLIENT;
const custom = clientPath && isAbsolute(clientPath)
  ? await import(pathToFileURL(clientPath).href) : null;
if (clientPath && !isAbsolute(clientPath)) throw new Error('POLYFORGE_E2E_CLIENT must be absolute');
const { data } = await (custom?.client ?? defaultClient)();
const waitFor = custom?.waitFor ?? defaultWaitFor;
const companyPath = `/api/plugins/${pluginId}/api/company`;
const command = (operation, fields, key) => data('POST', companyPath, {
  companyId, operation, ...fields, reason: `Deterministic Temporary Agent acceptance: ${operation}`,
  idempotencyKey: key,
});
const read = () => data('GET', `${companyPath}?companyId=${companyId}`);
const nonce = randomUUID();
const snapshotMode = process.env.POLYFORGE_TEMPORARY_MODE === 'snapshot';
const expectedKind = snapshotMode ? 'shadow-agent' : 'sub-agent';
const originalAgent = await data('GET', `/api/agents/${agentId}`);
const agentsBefore = await data('GET', `/api/companies/${companyId}/agents`);
assert.equal(originalAgent.companyId, companyId);
assert.ok(['idle', 'error'].includes(originalAgent.status),
  'Acceptance Agent must have no live work before temporary config');
assert.equal(originalAgent.adapterType, 'process');
const running = (await data('GET', `/api/companies/${companyId}/heartbeat-runs`))
  .filter((run) => run.agentId === agentId &&
    ['running', 'queued', 'scheduled_retry'].includes(run.status));
assert.equal(running.length, 0, 'Acceptance Agent has active runs');
const originalPolicy = (await read()).control.temporaryAgentPolicy;
const adapterConfig = { ...originalAgent.adapterConfig, command: 'node',
  args: ['/opt/polyforge/plugin/scripts/e2e-temporary-agent.mjs'],
  timeoutSec: 120,
  env: { ...originalAgent.adapterConfig?.env,
    POLYFORGE_TEMPORARY_DELAY_MS: '20000',
    POLYFORGE_TEMPORARY_MODE: snapshotMode ? 'snapshot' : 'fresh' } };
let changed = false;
let policyChanged = false;
let issue;
let completed = false;
try {
  await data('PATCH', `/api/agents/${agentId}`, { adapterConfig });
  changed = true;
  await command('configure-temporary-agent-policy', { policy: {
    version: 1, enabled: true, maxConcurrentChildren: 2,
    maxDepth: 1, maxDurationSeconds: 180,
    allowSharedWorkspaceWrites: false,
    allowedPurposes: ['review', 'research', 'analyze', 'implement'],
  } }, `temporary:${nonce}:policy`);
  policyChanged = true;
  issue = await data('POST', `/api/companies/${companyId}/issues`, {
    projectId, title: `Deterministic ${expectedKind} acceptance ${nonce}`,
    description: 'polyforge-temporary-agent-parent-v1\nSynthetic native session acceptance; no model validation.',
    status: 'todo', priority: 'medium',
  });
  let snapshotFixture;
  const graphPath = `/api/plugins/${pluginId}/api/issues/${issue.id}/graph`;
  const productDecision = (status, outcome, extra = {}) => data('POST', graphPath, {
    operation: 'product-decision', feature: `temporary-snapshot-${nonce}`, status, outcome,
    reason: 'Synthetic snapshot transport acceptance; does not change the calculator project',
    evidence: [{ kind: 'synthetic_fixture', id: issue.id }],
    ...extra, idempotencyKey: `temporary:${nonce}:decision:${status}:${outcome}`,
  });
  if (snapshotMode) {
    const baseline = await productDecision('approved', 'Synthetic baseline: subtraction remains subtraction');
    const rejected = await productDecision('rejected', 'Synthetic change: replace subtraction with addition',
      { supersedes: baseline.result.id });
    snapshotFixture = { baselineId: baseline.result.id, rejectedId: rejected.result.id };
    await data('PATCH', `/api/issues/${issue.id}`, {
      description: `polyforge-temporary-agent-parent-v1\n${JSON.stringify({ snapshotFixture })}\nSynthetic context transport, not model-quality validation.`,
    });
  }
  await data('PATCH', `/api/issues/${issue.id}`, { assigneeAgentId: agentId });
  const parentRunId = await waitFor(async () => {
    const runs = await data('GET', `/api/companies/${companyId}/heartbeat-runs`);
    return runs.find((run) => run.agentId === agentId &&
      (run.issueId ?? run.contextSnapshot?.taskId) === issue.id)?.id;
  }, 'automatically scheduled Temporary Agent parent heartbeat', 60_000);
  let restarted = false;
  let initialSnapshotDigest;
  let lateDecisionId;
  if (snapshotMode) {
    const active = await waitFor(async () => (await read()).temporaryAgents.find(item =>
      item.parent?.executionId === parentRunId && item.status === 'active' && item.executionId),
    'active snapshot child', 30_000);
    assert.equal(active.context.mode, 'snapshot');
    initialSnapshotDigest = active.context.digest;
    const late = await productDecision('rejected', 'Synthetic later change: replace subtraction with multiplication',
      { supersedes: snapshotFixture.baselineId });
    lateDecisionId = late.result.id;
  }
  if (process.env.POLYFORGE_TEMPORARY_RESTART === '1') {
    await waitFor(async () => (await read()).temporaryAgents.find(item =>
      item.parent?.executionId === parentRunId && item.status === 'active' && item.executionId),
    'active child before plugin restart', 30_000);
    const reloaded = await data('POST', `/api/plugins/${pluginId}/upgrade`, {});
    assert.equal(reloaded.status, 'ready');
    restarted = true;
  }
  const parentRun = await waitFor(async () => {
    const run = await data('GET', `/api/heartbeat-runs/${parentRunId}`);
    return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status) ? run : null;
  }, 'Temporary Agent parent completion', 120_000);
  assert.equal(parentRun.status, 'succeeded', parentRun.stderrExcerpt ?? 'Parent fixture failed');
  const launch = await waitFor(async () => {
    const state = await read();
    return state.temporaryAgents.find((item) => item.parent?.executionId === parentRunId) ?? null;
  }, 'Temporary Agent launch', 60_000);
  assert.equal(launch.kind, expectedKind);
  assert.equal(launch.purpose, 'research');
  assert.notEqual(launch.executionId, parentRunId);
  const closed = await waitFor(async () => {
    const state = await read();
    return state.temporaryAgents.find((item) => item.temporaryAgentId === launch.temporaryAgentId &&
      item.status === 'closed') ?? null;
  }, 'Temporary Agent result reconciliation', 120_000);
  assert.equal(closed.outcome, 'completed');
  assert.equal(closed.result?.output?.fixture, 'deterministic-process');
  assert.ok(closed.result.output.companyMutationDenied >= 400);
  assert.ok(closed.result.output.graphMutationDenied >= 400);
  if (snapshotMode) {
    assert.equal(closed.context.digest, initialSnapshotDigest);
    assert.equal(closed.result.output.snapshotDigest, initialSnapshotDigest);
    assert.equal(closed.result.output.baselineId, snapshotFixture.baselineId);
    assert.equal(closed.result.output.rejectionId, snapshotFixture.rejectedId);
    assert.equal(closed.result.output.advisoryAndRejectionRetained, true);
    assert.ok(!closed.result.output.decisionIds.includes(lateDecisionId), 'Post-capture decision changed a frozen packet');
  }
  const childRun = await data('GET', `/api/heartbeat-runs/${closed.executionId}`);
  assert.equal(childRun.status, 'succeeded');
  assert.equal(childRun.companyId, companyId);
  assert.equal(childRun.agentId, agentId);
  const children = (await read()).temporaryAgents.filter(item => item.parent?.executionId === parentRunId);
  assert.equal(children.length, 1, 'Repeated delegation must create one child per parent execution');
  const agentsAfter = await data('GET', `/api/companies/${companyId}/agents`);
  assert.deepEqual(agentsAfter.map((agent) => agent.id).sort(),
    agentsBefore.map((agent) => agent.id).sort(),
    'Temporary execution must not create an organizational Agent');
  completed = true;
  console.log(JSON.stringify({ kind: 'deterministic-process', temporaryAgentKind: expectedKind, companyId,
    issueId: issue.id, parentRunId, temporaryAgentId: closed.temporaryAgentId,
    childRunId: closed.executionId, status: closed.status, outcome: closed.outcome,
    restarted, context: closed.context,
    ...(snapshotMode ? { ...snapshotFixture, lateDecisionId, frozenAfterDecisionChange: true } : {}),
    nativeForkAvailable: (await read()).temporaryAgentCapabilities.nativeFork }));
} finally {
  if (!completed && issue) await data('PATCH', `/api/issues/${issue.id}`, { status: 'cancelled' });
  if (policyChanged) await command('configure-temporary-agent-policy',
    { policy: originalPolicy }, `temporary:${nonce}:restore-policy`);
  if (changed) await data('PATCH', `/api/agents/${agentId}`,
    { adapterConfig: originalAgent.adapterConfig });
}
