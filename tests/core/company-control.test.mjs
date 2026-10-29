import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompanyControlPlane, GraphEngine, MemoryStore, preflightPackChange, satisfies, capabilityAvailable } from '../../src/core/index.mjs';

const owner = { id: 'board-1', kind: 'human', roles: ['human-owner'] };
const ceo = { id: 'ceo-1', kind: 'agent', roles: ['ceo'], executionId: 'exec-ceo' };
const head = { id: 'head-1', kind: 'agent', roles: ['marketing-head'], executionId: 'exec-head' };
const agent = { id: 'worker-1', kind: 'agent', roles: ['worker'], executionId: 'exec-worker' };
const organization = { board: { id: 'board-1' }, ceo: { id: 'ceo-1' }, domainHeads: [{ domain: 'marketing', agentId: 'head-1', subordinateIds: ['worker-1'] }] };
const graph = { id: 'task', version: '1', start: 'work', nodes: [{ id: 'work', type: 'task', role: 'worker' }, { id: 'end', type: 'end' }], edges: [{ from: 'work', to: 'end' }] };
const pack = { id: 'adlc', version: '1.0.0', graphs: [graph], compatibility: { coreRange: '>=0.8.0 <0.9.0', contracts: { graph: 1 }, requiredCapabilities: { 'goal-pinning': '>=1.0.0 <2.0.0' } } };

async function setup(store = new MemoryStore(), companyId = 'a') {
  const control = new CompanyControlPlane({ store, companyId, availableCapabilities: { 'shadow-review-execution': '1.0.0', 'sourced-metrics': '1.0.0' }, trustedProviders: ['test-provider'] });
  const engine = new GraphEngine({ store });
  await engine.registerPack(pack);
  await control.configureSetup({ organization, actor: owner, reason: 'Install company structure' });
  await control.enablePack({ packId: 'adlc', version: '1.0.0', actor: ceo, reason: 'Enable delivery' });
  return { control, engine, store };
}

test('terminal run notices use actual company state, respect preferences and queue once', async () => {
  const { control, store } = await setup();
  const state = await store.read();
  state.runs = Object.fromEntries(['completed', 'failed', 'running'].map(status => [status,
    { id: status, status, input: { paperclipCompanyId: 'a', projectId: 'p' }, packId: 'adlc', packVersion: '1.0.0', graph }]));
  state.runs.foreign = { ...state.runs.completed, id: 'foreign', input: { paperclipCompanyId: 'b' } };
  await store.write(state, state.revision);
  await control.setNotificationPreferences({ subjectId: organization.board.id, channels: ['paperclip'],
    events: ['run.failed'], actor: owner, reason: 'Only alert Board to failures' });
  const args = { actor: { id: 'observer', kind: 'system', roles: ['run-observer'] }, reason: 'Observe native run state' };
  assert.equal((await control.queueRunNotifications(args)).queued, 3);
  assert.equal((await control.queueRunNotifications(args)).queued, 0);
  const notices = await control.listNotifications();
  assert.equal(notices.filter(item => item.eventKind === 'run.failed').length, 2);
  assert.equal(notices.filter(item => item.ref.runId === 'foreign' || item.ref.runId === 'running').length, 0);
  await assert.rejects(control.queueRunNotifications({ ...args, actor: ceo }), /trusted observer/);
});

test('Pack preflight checks whole enabled set, active runs, contracts and capability versions', () => {
  const old = { ...pack, id: 'old', compatibility: { coreRange: '>=0.9.0 <1.0.0' } };
  const report = preflightPackChange({ catalog: [pack, old], enabled: [{ packId: 'adlc', version: '1.0.0' }, { packId: 'old', version: '1.0.0' }] });
  assert.equal(report.ok, false);
  assert.match(report.issues.join(' '), /old.*Core/);
  const active = preflightPackChange({ catalog: [pack], enabled: [{ packId: 'adlc', version: '1.0.0' }],
    activeRuns: [{ id: 'run-1', packId: 'old', packVersion: '1.0.0', graph, pack: old, status: 'running' }] });
  assert.match(active.issues.join(' '), /Active run run-1/);
  assert.equal(satisfies('0.9.0', '^0.8.0'), false);
  assert.equal(satisfies('0.8.1-beta.1', '>=0.8.0 <0.9.0'), false);
  assert.equal(capabilityAvailable({ compatibility: { optionalCapabilities: { 'sourced-metrics': '>=1.0.0 <2.0.0' } } }, null,
    'sourced-metrics', { availableCapabilities: { 'sourced-metrics': '0.1.0' } }), false);
  const gated = { ...pack, graphs: [{ ...graph, compatibility: { requiredCapabilities: { 'host-tool': '>=1.0.0' } } }] };
  const partial = preflightPackChange({ catalog: [gated], enabled: [{ packId: 'adlc', version: '1.0.0' }] });
  assert.equal(partial.ok, true);
  assert.equal(partial.unavailableGraphs[0].graphId, 'task');
});

test('configured company starts only its exact enabled Pack version while legacy engine remains supported', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store });
  const control = new CompanyControlPlane({ store, companyId: 'a' });
  await engine.registerPack(pack);
  await engine.registerPack({ ...pack, version: '1.1.0' });
  await engine.registerPack({ ...pack, id: 'marketing' });
  await control.configureSetup({ organization, actor: owner, reason: 'Setup' });
  const input = { paperclipCompanyId: 'a', projectId: 'p' };
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', input, actor: owner }), /not enabled/);
  await control.enablePack({ packId: 'adlc', version: '1.0.0', actor: ceo, reason: 'Enable v1' });
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.1.0', graphId: 'task', input, actor: owner }), /not enabled/);
  await assert.rejects(() => engine.startRun({ packId: 'marketing', packVersion: '1.0.0', graphId: 'task', input, actor: owner }), /not enabled/);
  const first = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', input, actor: owner });
  await control.enablePack({ packId: 'adlc', version: '1.1.0', actor: ceo, reason: 'Upgrade' });
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', input, actor: owner }), /not enabled/);
  assert.equal((await engine.getRun(first.id)).packVersion, '1.0.0');
  const next = await engine.startRun({ packId: 'adlc', packVersion: '1.1.0', graphId: 'task', input, actor: owner });
  assert.equal(next.packVersion, '1.1.0');
  const legacy = new GraphEngine();
  await legacy.registerPack(pack);
  assert.equal((await legacy.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner })).packVersion, '1.0.0');
});

test('Pack release digest authenticates the complete immutable registration payload', async () => {
  const engine = new GraphEngine();
  const payload = { ...pack, id: 'signed-pack' };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  await engine.registerPack({ ...payload, release: { digest, status: 'candidate' } });
  await assert.rejects(() => engine.registerPack({ ...payload, graphs: [{ ...graph, version: '2' }], release: { digest, status: 'candidate' } }), /release digest does not match/);
  await assert.rejects(() => engine.registerPack({ ...payload, release: { digest: `sha256:${'0'.repeat(64)}` } }), /release digest does not match/);
});

test('company store rejects another company and concurrent idempotent intake commits once', async () => {
  const { control, engine, store } = await setup();
  const second = new CompanyControlPlane({ store, companyId: 'b' });
  await assert.rejects(() => second.getSetup(), /isolation/);
  const request = { projectId: 'p', title: 'Request', actor: owner, reason: 'New request', idempotencyKey: 'message-1', source: { channel: 'email', senderId: 's', messageId: 'm' } };
  const [a, b] = await Promise.all([control.createIntake(request), control.createIntake(request)]);
  assert.equal(a.id, b.id);
  assert.equal((await control.getIntake()).length, 1);
  assert.equal((await engine.getAudit()).filter(event => event.kind === 'intake.created').length, 1);
  await assert.rejects(() => control.createIntake({ ...request, title: 'Changed' }), /Idempotency key reused/);
});

test('source message deduplication survives new request keys and later assignment', async () => {
  const { control, engine } = await setup();
  const request = { projectId: 'p', title: 'One incoming request', description: 'Original human text',
    source: { channel: 'telegram', senderId: 'sender', chatId: 'chat-a', messageId: '1' },
    actor: owner, reason: 'Bound human message' };
  const [first, replay] = await Promise.all([
    control.createIntake({ ...request, idempotencyKey: 'arrival-a' }),
    control.createIntake({ ...request, idempotencyKey: 'arrival-b' }),
  ]);
  assert.equal(first.id, replay.id);
  await control.routeIntake({ intakeId: first.id, outcome: 'assign', assigneeId: agent.id,
    actor: ceo, reason: 'CEO delegates' });
  assert.equal((await control.createIntake({ ...request, idempotencyKey: 'arrival-c' })).assigneeId, agent.id);
  await assert.rejects(() => control.createIntake({ ...request, projectId: 'different',
    idempotencyKey: 'changed-source' }), /source message reused/);
  const distinct = await control.createIntake({ ...request, source: { ...request.source, chatId: 'chat-b' },
    idempotencyKey: 'different-conversation' });
  assert.notEqual(distinct.id, first.id);
  assert.equal((await control.getIntake()).length, 2);
  assert.equal((await engine.getAudit()).filter(event => event.kind === 'intake.created').length, 2);
});

test('direct rejection forwards to CEO and preserves the rejection decision', async () => {
  const { control } = await setup();
  const item = await control.createIntake({ projectId: 'p', title: 'Needs another team', assigneeId: agent.id, actor: owner, reason: 'Direct message' });
  const rejected = await control.routeIntake({ intakeId: item.id, outcome: 'reject', actor: agent, reason: 'Out of role' });
  assert.equal(rejected.status, 'ceo-review');
  assert.equal(rejected.assigneeId, null);
  assert.equal(rejected.history.at(-1).reason, 'Out of role');
  const assigned = await control.routeIntake({ intakeId: item.id, outcome: 'assign', assigneeId: head.id, actor: ceo, reason: 'Route to marketing' });
  assert.equal(assigned.status, 'offered');
});

test('human cancellation is terminal and audited', async () => {
  const { control } = await setup();
  const item = await control.createIntake({ projectId: 'p', title: 'Withdrawn request', actor: owner, reason: 'Submitted' });
  const cancelled = await control.routeIntake({ intakeId: item.id, outcome: 'cancel', actor: owner, reason: 'Sender withdrew request' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.history.at(-1).reason, 'Sender withdrew request');
  await assert.rejects(() => control.routeIntake({ intakeId: item.id, outcome: 'assign', assigneeId: head.id, actor: ceo, reason: 'Restart' }), /already resolved/);
});

test('goal revisions apply to new runs; child, retry and old run retain the full snapshot', async () => {
  const { control, engine } = await setup();
  await assert.rejects(() => control.setGoals({ scope: 'agent', subjectId: 'a', goals: [], actor: ceo, reason: 'Overwrite' }), /cannot name the company/);
  await assert.rejects(() => control.setGoals({ scope: 'company', subjectId: 'other', goals: [], actor: owner, reason: 'Wrong company' }), /must name this company/);
  const company = await control.setGoals({ scope: 'company', subjectId: 'a', goals: [{ id: 'growth', title: 'Grow', keyResults: [{ id: 'k', target: 10, unit: 'customers', source: 'crm', window: 'month' }] }], actor: owner, reason: 'Board target' });
  const v1 = await control.setGoals({ scope: 'agent', subjectId: agent.id, goals: [{ id: 'acquire', title: 'Acquire', parentGoalId: 'growth', keyResults: [{ id: 'k2', target: 5, unit: 'customers', source: 'crm', window: 'month' }] }], actor: ceo, reason: 'Delegate' });
  const first = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { paperclipCompanyId: 'a', projectId: 'p', goalContext: { forged: true } } });
  assert.deepEqual(first.goalContext.revisions.map(item => item.id), [company.id, v1.id]);
  assert.deepEqual(first.input.goalContext, first.goalContext);
  await control.setGoals({ scope: 'agent', subjectId: agent.id, goals: [{ id: 'acquire', title: 'Acquire more', parentGoalId: 'growth', keyResults: [{ id: 'k2', target: 8, unit: 'customers', source: 'crm', window: 'month' }] }], actor: ceo, reason: 'New target' });
  const child = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { parentRunId: first.id, paperclipCompanyId: 'a', projectId: 'p' } });
  const next = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { paperclipCompanyId: 'a', projectId: 'p' } });
  assert.deepEqual(child.goalContext, first.goalContext);
  assert.equal(next.goalContext.revisions[1].version, 2);
  assert.equal((await engine.getRun(first.id)).goalContext.revisions[1].version, 1);
});

test('organization authority, plan dependencies, observed reviews and shadow bounds fail closed', async () => {
  const { control, engine } = await setup();
  await assert.rejects(() => control.setGoals({ scope: 'company', subjectId: 'a', goals: [], actor: ceo, reason: 'Change target' }), /human owner/);
  await assert.rejects(() => control.setGoals({ scope: 'agent', subjectId: 'worker-1', goals: [], actor: agent, reason: 'Self edit' }), /cannot set/);
  const plan = await control.createWorkPlan({ projectId: 'p', items: [
    { id: 'a', packId: 'adlc', graphId: 'task', priority: 1 },
    { id: 'b', packId: 'adlc', graphId: 'task', priority: 2, dependsOn: ['a'] },
  ], actor: ceo, reason: 'Sequence work' });
  await assert.rejects(() => control.updateWorkItem({ planId: plan.id, itemId: 'b', status: 'active', actor: ceo, reason: 'Start' }), /Dependencies incomplete/);
  await assert.rejects(() => control.updateWorkItem({ planId: plan.id, itemId: 'a', status: 'completed', actor: ceo, reason: 'Claimed done' }), /matching Graph run state/);
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner,
    input: { paperclipCompanyId: 'a', projectId: 'p', planId: plan.id, planItemId: 'b' } }), /dependencies are incomplete/);
  const planned = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner,
    input: { paperclipCompanyId: 'a', projectId: 'p', planId: plan.id, planItemId: 'a' } });
  await engine.submitNode({ runId: planned.id, nodeId: 'work', actor: agent });
  await engine.submitNode({ runId: planned.id, nodeId: 'end', actor: owner });
  const reconciled = await control.reconcileWorkPlan({ planId: plan.id,
    actor: { id: 'host-reconciler', kind: 'system', roles: ['work-plan-reconciler'] }, reason: 'Observed terminal run' });
  assert.deepEqual(reconciled.changes.map(change => change.itemId), ['a']);
  assert.equal((await control.getPlans())[0].items[0].status, 'completed');
  const plannedB = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner,
    input: { paperclipCompanyId: 'a', projectId: 'p', planId: plan.id, planItemId: 'b' } });
  assert.equal((await control.getPlans())[0].items[1].runId, plannedB.id);
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { paperclipCompanyId: 'a', projectId: 'p' } });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: agent, artifacts: [{ id: 'candidate', version: 'v1', digest: `sha256:${'b'.repeat(64)}`, kind: 'candidate' }] });
  const snapshot = await control.recordShadowContext({ parentRunId: run.id, parentTaskId: 'work', candidateRefs: [{ id: 'candidate', version: 'v1', digest: `sha256:${'b'.repeat(64)}` }],
    payloadDigest: `sha256:${'c'.repeat(64)}`, actor: { id: 'review-packet', kind: 'system', roles: [] }, reason: 'Verified review packet' });
  const contextRef = { sourceRunId: run.id, sourceNodeId: 'work', snapshotId: snapshot.id, payloadDigest: snapshot.payloadDigest };
  const shadowDeadline = new Date(Date.now() + 300_000).toISOString();
  await assert.rejects(() => control.openShadow({ parentRunId: run.id, parentTaskId: 'work', role: 'reviewer', executionId: 'shadow-x', sessionId: 's', contextRef, scope: { allowedActions: ['review'], maxTasks: 2, maxConcurrent: 1, deadlineAt: '2999-01-01' }, actor: ceo, reason: 'Review' }), /Bounded shadow/);
  const shadow = await control.openShadow({ parentRunId: run.id, parentTaskId: 'work', role: 'reviewer', executionId: 'shadow-x', sessionId: 's', contextRef, scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt: shadowDeadline }, actor: ceo, reason: 'Review' });
  assert.equal(shadow.status, 'active');
  await control.closeShadow({ shadowId: shadow.id, outcome: 'reviewed', actor: ceo, reason: 'Finished' });
  assert.equal((await control.getShadows())[0].status, 'closed');
  const reserved = await control.prepareShadow({ parentRunId: run.id, parentTaskId: 'work', role: 'reviewer', sessionId: 's2', contextRef,
    scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt: shadowDeadline }, actor: ceo, reason: 'Reserve review' });
  assert.equal(reserved.status, 'reserved');
  const bound = await control.bindShadowExecution({ shadowId: reserved.id, executionId: 'shadow-exec-2', actor: { id: 'host', kind: 'system', roles: [] }, reason: 'Session started' });
  assert.equal(bound.status, 'active');
  await assert.rejects(() => control.closeShadow({ shadowId: reserved.id, outcome: 'failed',
    actor: { id: 'other-system', kind: 'system', roles: [] }, reason: 'Unauthorized cleanup' }), /authority/);
  const reviewResult = { status: 'synthetic-fixture-reviewed', outputDigest: `sha256:${'d'.repeat(64)}`,
    findings: [{ severity: 'P3', summary: 'Synthetic fixture observation',
      sourceRef: { id: 'candidate', version: 'v1', digest: `sha256:${'b'.repeat(64)}` } }] };
  await assert.rejects(() => control.closeShadow({ shadowId: reserved.id, outcome: 'completed', reviewResult,
    actor: ceo, reason: 'Forged terminal result' }), /trusted terminal reconciliation/);
  await assert.rejects(() => control.closeShadow({ shadowId: reserved.id, outcome: 'completed',
    reviewResult: { ...reviewResult, findings: [{ ...reviewResult.findings[0], sourceRef: { id: 'other', version: 'v1' } }] },
    actor: { id: 'host-reaper', kind: 'system', roles: ['shadow-reconciler'] }, reason: 'Invalid source' }), /reserved candidate/);
  await control.closeShadow({ shadowId: reserved.id, outcome: 'completed',
    reviewResult, actor: { id: 'host-reaper', kind: 'system', roles: ['shadow-reconciler'] }, reason: 'Terminal callback' });
  const completedShadow = (await control.getShadows()).find(item => item.id === reserved.id);
  assert.equal(completedShadow.status, 'closed');
  assert.deepEqual(completedShadow.reviewResult.findings, reviewResult.findings);
});

test('work plan reconciliation validates exact run identity and is replay safe', async () => {
  const { control, engine } = await setup();
  const plan = await control.createWorkPlan({ projectId: 'p', items: [{ id: 'first', packId: 'adlc', graphId: 'task', priority: 1 }], actor: ceo, reason: 'Plan' });
  const base = { paperclipCompanyId: 'a', projectId: 'p', planId: plan.id, planItemId: 'first' };
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner,
    input: { ...base, projectId: 'other' } }), /does not authorize/);
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: base });
  await assert.rejects(() => engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: base }), /already started/);
  await assert.rejects(() => control.updateWorkItem({ planId: plan.id, itemId: 'first', status: 'completed', actor: ceo, reason: 'Too early' }), /matching Graph run state/);
  const noChange = await control.reconcileWorkPlan({ planId: plan.id, actor: { id: 'host', kind: 'system', roles: ['work-plan-reconciler'] }, reason: 'Poll' });
  assert.deepEqual(noChange.changes, []);
  const version = noChange.version;
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: agent });
  await engine.submitNode({ runId: run.id, nodeId: 'end', actor: owner });
  const request = { planId: plan.id, actor: { id: 'host', kind: 'system', roles: ['work-plan-reconciler'] }, reason: 'Completed run', idempotencyKey: 'complete-first' };
  const first = await control.reconcileWorkPlan(request);
  assert.equal(first.version, version + 1);
  assert.equal(first.changes[0].status, 'completed');
  assert.deepEqual(await control.reconcileWorkPlan(request), first);
  assert.deepEqual((await control.reconcileWorkPlan({ ...request, idempotencyKey: 'poll-again' })).changes, []);
  await assert.rejects(() => control.updateWorkItem({ planId: plan.id, itemId: 'first', status: 'pending', actor: ceo, reason: 'Reopen' }), /cannot be reopened/);
});

test('handoff binds a completed source event, declared route, digest and target project', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store, availableCapabilities: { 'verified-release-event': '1.0.0' } });
  const control = new CompanyControlPlane({ store, companyId: 'a', availableCapabilities: { 'verified-release-event': '1.0.0' }, trustedProviders: ['test-provider'] });
  const releaseGraph = { id: 'release', version: '1', start: 'work', nodes: [
    { id: 'work', type: 'task', role: 'worker', produces: ['release_execution_record'] }, { id: 'end', type: 'end', output: 'release_recorded' },
  ], edges: [{ from: 'work', to: 'end' }] };
  await engine.registerPack({ id: 'source', version: '1.0.0', graphs: [releaseGraph], handoffContracts: [
    { contract: 'release-to-target', version: 1, sourceGraphId: 'release', requiredStatus: 'release_recorded', targetPackId: 'target', targetGraphId: 'task', eventArtifactKind: 'release_execution_record', requiredCapability: 'verified-release-event' },
  ] });
  await engine.registerPack({ ...pack, id: 'target', incomingHandoffs: [
    { contract: 'release-to-target', contractVersion: 1, sourcePackId: 'source', sourceGraphId: 'release', targetGraphId: 'task', requiredCapability: 'verified-release-event' },
  ] });
  await control.configureSetup({ organization, actor: owner, reason: 'Setup' });
  await control.enablePack({ packId: 'source', version: '1.0.0', actor: ceo, reason: 'Enable' });
  await control.enablePack({ packId: 'target', version: '1.0.0', actor: ceo, reason: 'Enable' });
  const sourceInput = { projectId: 'p', paperclipCompanyId: 'a', release_execution_event: { id: 'exec', version: 'v1' },
    implementation_candidate: { id: 'candidate', version: 'v1' }, release_authorization_decision: { id: 'decision', version: 'v1' } };
  const run = await engine.startRun({ packId: 'source', packVersion: '1.0.0', graphId: 'release', actor: owner, input: sourceInput });
  const event = { id: 'release-event', version: 'v1', digest: `sha256:${'a'.repeat(64)}`, kind: 'release_execution_record', sourceRefs: [
    { kind: 'run_input', key: 'release_execution_event', ...sourceInput.release_execution_event },
    { kind: 'run_input', key: 'implementation_candidate', ...sourceInput.implementation_candidate },
    { kind: 'run_input', key: 'release_authorization_decision', ...sourceInput.release_authorization_decision },
  ] };
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: agent, artifacts: [event] });
  await assert.rejects(() => control.recordHandoff({ projectId: 'p', sourceRunId: run.id, targetPackId: 'target', targetGraphId: 'task', contract: 'release-to-target', contractVersion: 1, sourceEvent: event, artifacts: [event], actor: ceo, reason: 'Route' }), /not completed/);
  await engine.submitNode({ runId: run.id, nodeId: 'end', actor: owner });
  const receipt = { id: 'release-receipt', providerId: 'test-provider', companyId: 'a', projectId: 'p', kind: 'release',
    issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    subjectRefs: [sourceInput.release_execution_event, sourceInput.implementation_candidate, sourceInput.release_authorization_decision,
      { id: event.id, version: event.version, digest: event.digest }],
    data: { sourceRunId: run.id, releaseEvent: sourceInput.release_execution_event, candidate: sourceInput.implementation_candidate,
      authorizationDecisionId: sourceInput.release_authorization_decision.id } };
  await control.recordEvidenceReceipt({ receipt, actor: { id: 'host-verifier', kind: 'system', roles: ['evidence-provider:test-provider'] }, reason: 'HMAC verified' });
  await assert.rejects(() => control.recordHandoff({ projectId: 'p', sourceRunId: run.id, targetPackId: 'target', targetGraphId: 'task', contract: 'release-to-target', contractVersion: 1, sourceEvent: { ...event, digest: 'wrong' }, artifacts: [event], actor: ceo, reason: 'Route' }), /do not match/);
  await assert.rejects(() => control.recordHandoff({ projectId: 'p', sourceRunId: run.id, targetPackId: 'target', targetGraphId: 'task', contract: 'release-to-target', contractVersion: 1, sourceEvent: event, artifacts: [event], actor: ceo, reason: 'Unverified route' }), /evidence receipt/);
  const handoff = await control.recordHandoff({ projectId: 'p', sourceRunId: run.id, targetPackId: 'target', targetGraphId: 'task', contract: 'release-to-target', contractVersion: 1, sourceEvent: event, artifacts: [event], evidenceReceiptId: receipt.id, actor: ceo, reason: 'Route' });
  await assert.rejects(() => engine.startRun({ packId: 'target', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { projectId: 'other', handoffId: handoff.id, paperclipCompanyId: 'a' } }), /Handoff does not authorize/);
  const next = await engine.startRun({ packId: 'target', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { projectId: 'p', handoffId: handoff.id, paperclipCompanyId: 'a' } });
  assert.equal(next.input.handoffId, handoff.id);
  await engine.registerPack({ ...pack, id: 'target', version: '1.1.0', incomingHandoffs: [
    { contract: 'release-to-target', contractVersion: 1, sourcePackId: 'source', sourceGraphId: 'release', targetGraphId: 'task', requiredCapability: 'verified-release-event' },
  ] });
  await control.enablePack({ packId: 'target', version: '1.1.0', actor: ceo, reason: 'Upgrade target' });
  await assert.rejects(() => engine.startRun({ packId: 'target', packVersion: '1.1.0', graphId: 'task', actor: owner,
    input: { projectId: 'p', handoffId: handoff.id, paperclipCompanyId: 'a' } }), /Handoff does not authorize.*version/);
});

test('outcome review keeps unknown values and strategy only revises subordinate goals with observed proof', async () => {
  const { control } = await setup();
  const company = await control.setGoals({ scope: 'company', subjectId: 'a', goals: [{ id: 'growth', title: 'Grow', keyResults: [{ id: 'k', target: 10, unit: 'customers', source: 'crm', window: 'month' }] }], actor: owner, reason: 'Board target' });
  await control.setGoals({ scope: 'agent', subjectId: agent.id, goals: [{ id: 'acquire', title: 'Acquire', parentGoalId: 'growth', keyResults: [{ id: 'k2', target: 5, unit: 'customers', source: 'crm', window: 'month' }] }], actor: ceo, reason: 'Delegate' });
  const unknown = await control.reviewOutcome({ projectId: 'p', goalId: 'growth', goalRevisionId: company.id, observations: [{ keyResultId: 'k', value: 3, window: 'month' }], actor: ceo, reason: 'No source yet' });
  assert.equal(unknown.observations[0].status, 'unknown');
  await assert.rejects(() => control.adjustStrategy({ reviewId: unknown.id, changes: [], actor: ceo, reason: 'Pivot' }), /observed evidence/);
  const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  const metricReceipt = { id: 'metric-receipt', providerId: 'test-provider', companyId: 'a', projectId: 'p', kind: 'metric',
    issuedAt: iso(-3600000), expiresAt: iso(3600000), subjectRefs: [{ id: 'crm-report-1', version: 'v1' }],
    data: { goalRevisionId: company.id, goalId: 'growth', keyResultId: 'k', source: 'crm', window: 'month', value: 3, observedAt: iso(-43200000) } };
  await assert.rejects(() => control.recordEvidenceReceipt({ receipt: metricReceipt, actor: { id: 'forged', kind: 'system', roles: [] }, reason: 'Claimed proof' }), /authenticated evidence provider/);
  const proof = await control.recordEvidenceReceipt({ receipt: metricReceipt,
    actor: { id: 'metric-ingestor', kind: 'system', roles: ['evidence-provider:test-provider'] }, reason: 'HMAC verified CRM observation' });
  const observed = await control.reviewOutcome({ projectId: 'p', goalId: 'growth', goalRevisionId: company.id, observations: [{ keyResultId: 'k', evidenceReceiptId: proof.id, window: 'month' }], actor: ceo, reason: 'Observed' });
  const changed = await control.adjustStrategy({ reviewId: observed.id, changes: [{ subjectId: agent.id, goals: [{ id: 'acquire', title: 'Acquire', parentGoalId: 'growth', keyResults: [{ id: 'k2', target: 7, unit: 'customers', source: 'crm', window: 'month' }] }] }], actor: ceo, reason: 'Increase target from review' });
  assert.equal(changed.goalRevisionIds.length, 1);
  await assert.rejects(() => control.adjustStrategy({ reviewId: observed.id, changes: [], actor: ceo, reason: 'Duplicate' }), /already adjusted/);
});

test('outcome attribution uses a completed run and its original goal revision', async () => {
  const {control,engine}=await setup();
  const goals=[{id:'growth',title:'Grow',keyResults:[{id:'k',target:10,unit:'users',source:'crm',window:'month'}]}];
  const original=await control.setGoals({scope:'company',subjectId:'a',goals,actor:owner,reason:'Original company target'});
  const run=await engine.startRun({packId:'adlc',packVersion:'1.0.0',graphId:'task',input:{projectId:'p',paperclipCompanyId:'a'},actor:owner});
  const changed=await control.setGoals({scope:'company',subjectId:'a',goals:[{...goals[0],title:'Revised target'}],actor:owner,reason:'Target for future tasks'});
  const args={projectId:'p',goalId:'growth',sourceRunId:run.id,actor:owner,reason:'Review delivery'};
  await assert.rejects(control.reviewOutcome(args),/completed run/);
  await engine.submitNode({runId:run.id,nodeId:'work',actor:agent});
  await engine.submitNode({runId:run.id,nodeId:'end',actor:owner});
  await assert.rejects(control.reviewOutcome({...args,projectId:'foreign'}),/completed run/);
  await assert.rejects(control.reviewOutcome({...args,goalRevisionId:changed.id}),/snapshot/);
  const review=await control.reviewOutcome({...args,packId:'forged'});
  assert.equal(review.goalRevisionId,original.id);
  assert.equal(review.packId,'adlc');assert.equal(review.packVersion,'1.0.0');assert.equal(review.sourceRunId,run.id);
  assert.equal(review.observations[0].status,'unknown');
});

test('CEO adjudicates permitted subjects; human owner resolves strategy and delivery needs system proof', async () => {
  const { control } = await setup();
  const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  const intake = await control.escalateDecision({ subjectType: 'intake', subjectId: 'item-1', question: 'Route?', options, actor: agent, reason: 'Needs leader' });
  await control.adjudicate({ escalationId: intake.id, outcome: 'a', evidence: [{ id: 'context' }], actor: ceo, reason: 'CEO route' });
  const strategy = await control.escalateDecision({ subjectType: 'strategy', subjectId: 'p', question: 'Change strategy?', options, actor: ceo, reason: 'Beyond scope' });
  await assert.rejects(() => control.adjudicate({ escalationId: strategy.id, outcome: 'a', evidence: [{ id: 'context' }], actor: ceo, reason: 'Try' }), /Human owner/);
  await control.adjudicate({ escalationId: strategy.id, outcome: 'b', evidence: [{ id: 'board-note' }], actor: owner, reason: 'Board decision' });
  const item = await control.createIntake({ projectId: 'p', title: 'Request', actor: owner, reason: 'Intake' });
  const notification = (await control.listNotifications({ subjectId: ceo.id })).find(entry => entry.ref.intakeId === item.id);
  await assert.rejects(() => control.acknowledgeDelivery({ notificationId: notification.id, providerRef: 'provider-1', actor: ceo, reason: 'Delivered' }), /trusted system/);
  await control.acknowledgeDelivery({ notificationId: notification.id, providerRef: 'provider-1', actor: { id: 'notifier', kind: 'system', roles: [] }, reason: 'Provider receipt' });
  await control.markNotification({ notificationId: notification.id, actor: ceo, reason: 'Read' });
  const after = (await control.listNotifications({ subjectId: ceo.id })).find(entry => entry.id === notification.id);
  assert.equal(after.deliveryStatus, 'delivered');
  assert.ok(after.readAt);
});

test('human takeover pauses dispatch and only owner resolution reopens the pinned run', async () => {
  const { control, engine } = await setup();
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1.0.0', graphId: 'task', actor: owner, input: { projectId: 'p', paperclipCompanyId: 'a' } });
  await assert.rejects(() => control.takeOver({ runId: run.id, nodeId: 'work', actor: ceo, reason: 'Take over' }), /requires owner/);
  const takeover = await control.takeOver({ runId: run.id, nodeId: 'work', actor: owner, reason: 'Review agent output' });
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  assert.equal((await engine.getWorkItems(run.id))[0].operation, 'resolve-takeover');
  await assert.rejects(() => engine.resumeRun({ runId: run.id, actor: ceo, reason: 'Resume' }), /takeover must be resolved/);
  await assert.rejects(() => control.resolveTakeover({ runId: run.id, takeoverId: takeover.takeover.id, outcome: 'resume', actor: ceo, reason: 'Resume' }), /requires owner/);
  await control.resolveTakeover({ runId: run.id, takeoverId: takeover.takeover.id, outcome: 'resume', actor: owner, reason: 'Reviewed' });
  assert.equal((await engine.getRun(run.id)).status, 'running');
});

test('missing outcome capability leaves an explicit unknown route available', async () => {
  const engine = new GraphEngine();
  const decisionGraph = { id: 'metrics', version: '1', start: 'decide', nodes: [
    { id: 'decide', type: 'decision', role: 'human-owner', outcomeCapabilities: { adjust: 'sourced-metrics' } },
    { id: 'unknown', type: 'end' }, { id: 'adjusted', type: 'end' },
  ], edges: [{ from: 'decide', to: 'unknown', when: 'unknown' }, { from: 'decide', to: 'adjusted', when: 'adjust' }] };
  await engine.registerPack({ id: 'metrics', version: '1.0.0', graphs: [decisionGraph], decisionRules: [{ type: 'decide', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['human-owner'] }] });
  const run = await engine.startRun({ packId: 'metrics', packVersion: '1.0.0', graphId: 'metrics', actor: owner });
  await assert.rejects(() => engine.decideNode({ runId: run.id, nodeId: 'decide', actor: owner, outcome: 'adjust', reason: 'Adjust' }), /requires capability/);
  await engine.decideNode({ runId: run.id, nodeId: 'decide', actor: owner, outcome: 'unknown', reason: 'No sourced metrics' });
  assert.equal((await engine.getReadyNodes(run.id))[0].id, 'unknown');
});

test('due outcome reminders queue once without changing goals or creating reviews', async () => {
  const { control } = await setup();
  await control.setGoals({ scope: 'company', subjectId: 'a', goals: [{ id: 'renewal', title: 'Renew', keyResults: [
    { id: 'rate', target: 80, unit: 'percent', source: 'billing', window: 'month', windowEnd: new Date(Date.now() - 3600000).toISOString() },
  ] }], actor: owner, reason: 'Board target' });
  const system = { id: 'scheduler', kind: 'system', roles: [] };
  assert.equal((await control.queueOutcomeReviewReminders({ actor: system, reason: 'Due scan', idempotencyKey: 'scan-1' })).queued, 1);
  assert.equal((await control.queueOutcomeReviewReminders({ actor: system, reason: 'Due scan', idempotencyKey: 'scan-2' })).queued, 0);
  assert.equal((await control.listNotifications()).filter(item => item.eventKind === 'outcome-review.due').length, 1);
  assert.equal((await control.getReviews()).length, 0);
});
