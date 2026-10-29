import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, pluginId, root, waitFor } from './enhancement-client.mjs';

// The agent fixture executes these commands with Paperclip's own heartbeat
// token. This driver never supplies an agent identity in a user request.
export async function runCeoAuthorityCases({ state, command, read, data, record }) {
  const { companyId, projectId, issueId } = state.development;
  const before = await read(companyId);
  const ceoId = before.setup.organization?.ceo?.id;
  const subordinateId = before.setup.organization?.domainHeads?.[0]?.agentId;
  assert.ok(ceoId && subordinateId && ceoId !== subordinateId);
  const ceo = await data('GET', `/api/agents/${ceoId}`);
  const subordinate = await data('GET', `/api/agents/${subordinateId}`);
  for (const agent of [ceo, subordinate]) {
    assert.equal(agent.companyId, companyId);
    assert.equal(agent.adapterType, 'process');
    assert.equal(agent.adapterConfig?.command, 'node');
    assert.deepEqual(agent.adapterConfig?.args, ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs']);
    assert.ok(agent.adapterConfig?.timeoutSec > 0 && agent.adapterConfig.timeoutSec <= 900);
    assert.ok(agent.budgetMonthlyCents > agent.spentMonthlyCents);
  }
  const authorityPolicy = {
    ceoOperations: ['intake', 'decision', 'work-plan', 'agent-goal', 'strategy', 'cross-pack'],
    ceoDecisions: ['intake', 'work-plan', 'agent-goal'],
  };
  await command(companyId, 'configure-organization', {
    organization: { ...before.setup.organization, authorityPolicy },
  }, `ceo-fixture:board-policy:${companyId}`);

  const sourceComment = await data('POST', `/api/issues/${issueId}/comments`, {
    body: 'Synthetic intake for CEO process authority verification.',
  });
  const intake = await command(companyId, 'create-intake', {
    projectId, title: 'Synthetic CEO routing request', sourceIssueId: issueId,
    sourceCommentId: sourceComment.id,
  });
  const ceoEscalation = await command(companyId, 'escalate-decision', {
    subjectType: 'intake', subjectId: intake.intake.id,
    question: 'Should the CEO coordinate this synthetic intake?',
    options: [{ id: 'coordinate', label: 'Coordinate' }, { id: 'return', label: 'Return' }],
    evidence: [{ kind: 'paperclip-intake', intakeId: intake.intake.id }],
  });
  assert.equal(ceoEscalation.eligibleRole, 'ceo');
  const ownerEscalation = await command(companyId, 'escalate-decision', {
    subjectType: 'strategy', subjectId: projectId,
    question: 'Should the Board change the synthetic strategy?',
    options: [{ id: 'hold', label: 'Hold' }, { id: 'change', label: 'Change' }],
    evidence: [{ kind: 'synthetic-fixture', projectId }],
  });
  assert.equal(ownerEscalation.eligibleRole, 'human-owner');

  const nonce = Date.now().toString(36);
  const runAgent = async (agent, commands, label) => {
    const request = { companyId, commands };
    const issue = await data('POST', `/api/companies/${companyId}/issues`, {
      projectId, title: `PolyForge CEO authority fixture · ${label}`,
      description: `PolyForge CEO authority fixture\n${JSON.stringify(request)}`,
      status: 'todo', priority: 'medium', assigneeAgentId: agent.id,
    });
    const wake = await data('POST', `/api/agents/${agent.id}/wakeup`, {
      source: 'on_demand', reason: `Deterministic ${label} authority verification`,
      payload: { issueId: issue.id }, idempotencyKey: `ceo-fixture:${nonce}:${label}`,
    });
    const heartbeatId = wake.id ?? wake.runId ?? wake.run?.id ?? await waitFor(async () => {
      const runs = await data('GET', `/api/companies/${companyId}/heartbeat-runs`);
      return runs.find((item) => item.agentId === agent.id && item.issueId === issue.id)?.id;
    }, `${label} heartbeat creation`);
    const heartbeat = await waitFor(async () => {
      const current = await data('GET', `/api/heartbeat-runs/${heartbeatId}`);
      return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(current.status) ? current : null;
    }, `${label} heartbeat completion`, 120_000);
    assert.equal(heartbeat.companyId, companyId);
    assert.equal(heartbeat.agentId, agent.id);
    assert.equal(heartbeat.status, 'succeeded', `${label} process Agent failed: ${heartbeat.stderrExcerpt ?? ''}`);
    assert.equal(heartbeat.exitCode, 0);
    return { issueId: issue.id, heartbeatId };
  };

  const ceoRun = await runAgent(ceo, [
    { operation: 'route-intake', fields: { intakeId: intake.intake.id, outcome: 'assign', assigneeId: subordinateId },
      idempotencyKey: `ceo-fixture:${nonce}:route`, expect: 'ok' },
    { operation: 'create-plan', fields: { projectId, items: [{ id: `ceo-plan-${nonce}`, title: 'Synthetic delegated plan',
      packId: 'adlc', graphId: 'ui-ux-design', priority: 1, dependsOn: [], input: {} }] },
      idempotencyKey: `ceo-fixture:${nonce}:plan`, expect: 'ok' },
    { operation: 'set-goals', fields: { scope: 'agent', subjectId: subordinateId,
      goals: [{ id: `ceo-goal-${nonce}`, title: 'Complete one synthetic delegated task',
        keyResults: [{ id: 'completed', baseline: 0, target: 1, unit: 'task',
          source: 'local-process-fixture', window: 'synthetic-acceptance' }] }] },
      idempotencyKey: `ceo-fixture:${nonce}:goal`, expect: 'ok' },
    { operation: 'adjudicate', fields: { escalationId: ceoEscalation.id, outcome: 'coordinate',
      evidence: [{ kind: 'synthetic-intake', intakeId: intake.intake.id }] },
      idempotencyKey: `ceo-fixture:${nonce}:decision`, expect: 'ok' },
    { operation: 'adjudicate', fields: { escalationId: ownerEscalation.id, outcome: 'change',
      evidence: [{ kind: 'synthetic-fixture', projectId }] },
      idempotencyKey: `ceo-fixture:${nonce}:board-only`, expect: 'denied' },
    { operation: 'set-goals', fields: { scope: 'company', subjectId: companyId,
      goals: [{ id: `forbidden-${nonce}`, title: 'Unauthorized company goal', keyResults: [{ id: 'x', target: 1,
        unit: 'task', source: 'local-process-fixture', window: 'synthetic-acceptance' }] }] },
      idempotencyKey: `ceo-fixture:${nonce}:company-goal`, expect: 'denied' },
  ], 'ceo');
  const subordinateRun = await runAgent(subordinate, [
    { operation: 'create-plan', fields: { projectId, items: [{ id: `forbidden-plan-${nonce}`,
      packId: 'adlc', graphId: 'ui-ux-design', priority: 1, dependsOn: [] }] },
      idempotencyKey: `ceo-fixture:${nonce}:non-ceo-plan`, expect: 'denied' },
    { operation: 'adjudicate', fields: { escalationId: ownerEscalation.id, outcome: 'change',
      evidence: [{ kind: 'synthetic-fixture', projectId }] },
      idempotencyKey: `ceo-fixture:${nonce}:non-ceo-decision`, expect: 'denied' },
  ], 'non-ceo');
  const after = await read(companyId);
  assert.equal(after.control.intake.find((item) => item.id === intake.intake.id)?.assigneeId, subordinateId);
  assert.equal(after.control.escalations.find((item) => item.id === ceoEscalation.id)?.resolvedBy?.executionId, ceoRun.heartbeatId);
  assert.equal(after.control.escalations.find((item) => item.id === ownerEscalation.id)?.status, 'pending');
  assert.ok(after.control.plans.some((plan) => plan.items.some((item) => item.id === `ceo-plan-${nonce}`)));
  assert.ok(after.control.goalHistory.some((revision) => revision.scope === 'agent' && revision.subjectId === subordinateId &&
    revision.goals.some((goal) => goal.id === `ceo-goal-${nonce}`)));
  assert.ok(!after.control.goalHistory.some((revision) => revision.goals.some((goal) => goal.id === `forbidden-${nonce}`)));
  const proof = { companyId, ceoId, subordinateId, ceoRun, subordinateRun,
    intakeId: intake.intake.id, ceoEscalationId: ceoEscalation.id, ownerEscalationId: ownerEscalation.id };
  await record?.('Real CEO process Agent delegation and authority rejection', proof);
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = JSON.parse(await readFile(resolve(root, '.e2e/enhancement-checkpoint.json'), 'utf8'));
  const { data } = await client();
  const endpoint = `/api/plugins/${pluginId}/api/company`;
  const read = (companyId) => data('GET', `${endpoint}?companyId=${companyId}`);
  const command = (companyId, operation, fields, key) => data('POST', endpoint, {
    companyId, operation, reason: `Deterministic CEO authority E2E: ${operation}`,
    idempotencyKey: key ?? `ceo-fixture:${Date.now()}:${operation}`, ...fields,
  });
  console.log(JSON.stringify(await runCeoAuthorityCases({ state, command, read, data }), null, 2));
}
