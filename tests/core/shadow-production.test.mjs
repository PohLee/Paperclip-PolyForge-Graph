import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyControlPlane, MemoryStore, validateShadowReviewResult } from '../../src/core/index.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const agent = { id: 'maker', kind: 'agent', roles: ['reviewer'], executionId: 'parent-exec' };
const orchestrator = { id: 'host', kind: 'system', roles: ['shadow-orchestrator'] };
const reconciler = { id: 'host', kind: 'system', roles: ['shadow-reconciler'] };
const ref = { id: 'candidate', version: 'v1', digest: `sha256:${'a'.repeat(64)}` };
const policy = { enabled: true, allowSameAgent: true, allowAgentTrigger: true,
  allowGraphTrigger: true, maxDurationSeconds: 300, allowedAdapterTypes: ['process', 'codex_local'] };
const deadline = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

async function fixture({ declaration = true, runStatus = 'running' } = {}) {
  const store = new MemoryStore();
  const control = new CompanyControlPlane({ store, companyId: 'company',
    availableCapabilities: { 'shadow-review-execution': '1.0.0' } });
  const graph = { id: 'graph', nodes: [{ id: 'produce', type: 'task' },
    { id: 'review', type: 'task', role: 'reviewer', shadowAllowedActions: ['review'],
      ...(declaration && { shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } }) }],
    edges: [{ from: 'produce', to: 'review' }] };
  const run = { id: 'run', status: runStatus, graph, pack: { id: 'pack', version: '1' },
    nodeStates: { produce: { status: 'completed', artifacts: [ref] }, review: { status: 'pending' } },
    goalContext: { revisions: [{ id: 'goal-v1' }] } };
  await store.write({ revision: 1, packs: {}, runs: { run }, decisions: [], audit: [], idempotency: {} }, 0);
  const snapshot = await control.recordShadowContext({ parentRunId: 'run', parentTaskId: 'review',
    candidateRefs: [ref], payloadDigest: `sha256:${'b'.repeat(64)}`,
    actor: orchestrator, reason: 'Pinned packet' });
  const contextRef = { sourceRunId: 'run', sourceNodeId: 'review',
    snapshotId: snapshot.id, payloadDigest: snapshot.payloadDigest };
  const reserve = (changes = {}) => control.prepareShadow({ parentRunId: 'run', parentTaskId: 'review',
    role: 'independent-review', sessionId: 'session', contextRef,
    scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt: deadline(60) },
    actor: orchestrator, reason: 'Graph review', ...changes });
  return { store, control, snapshot, contextRef, reserve };
}

test('Shadow policy is disabled by default, owner-only, audited, validated and idempotent', async () => {
  const { control } = await fixture();
  assert.equal((await control.getShadowPolicy()).enabled, false);
  await assert.rejects(control.configureShadowPolicy({ policy, actor: agent, reason: 'No', idempotencyKey: 'policy' }), /human owner/);
  for (const invalid of [
    { ...policy, maxDurationSeconds: 0 }, { ...policy, maxDurationSeconds: 901 },
    { ...policy, maxDurationSeconds: 1.5 }, { ...policy, allowedAdapterTypes: [] },
    { ...policy, allowedAdapterTypes: ['unknown'] }, { ...policy, allowGraphTrigger: 'yes' },
  ]) await assert.rejects(control.configureShadowPolicy({ policy: invalid, actor: owner,
    reason: 'Invalid', idempotencyKey: `bad-${JSON.stringify(invalid)}` }), /Invalid Shadow policy/);
  const request = { policy, actor: owner, reason: 'Enable local review', idempotencyKey: 'policy' };
  assert.deepEqual(await control.configureShadowPolicy(request), policy);
  assert.deepEqual(await control.configureShadowPolicy(request), policy);
  assert.equal((await control.getAudit()).filter(event => event.kind === 'shadow.policy-configured').length, 1);
  await assert.rejects(control.configureShadowPolicy({ ...request, policy: { ...policy, enabled: false } }), /Idempotency key reused/);
});

test('Graph reservation requires declaration, running run, policy and exact bounded scope', async () => {
  const { control, reserve } = await fixture();
  await assert.rejects(reserve(), /authority|setup/);
  await control.configureShadowPolicy({ policy, actor: owner, reason: 'Enable', idempotencyKey: 'policy' });
  for (const changes of [
    { role: 'other' }, { scope: { allowedActions: ['review', 'draft'], maxTasks: 1, maxConcurrent: 1, deadlineAt: deadline(60) } },
    { scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt: deadline(301) } },
    { actor: { ...orchestrator, roles: ['shadow-orchestrator', 'other'] } },
  ]) await assert.rejects(reserve(changes));
  const reserved = await reserve();
  assert.equal(reserved.status, 'reserved');
  await assert.rejects(reserve({ sessionId: 'second' }), /already has a shadow/);
  const undeclared = await fixture({ declaration: false });
  await undeclared.control.configureShadowPolicy({ policy, actor: owner, reason: 'Enable', idempotencyKey: 'p' });
  await assert.rejects(undeclared.reserve(), /authority|setup/);
  const stopped = await fixture({ runStatus: 'completed' });
  await stopped.control.configureShadowPolicy({ policy, actor: owner, reason: 'Enable', idempotencyKey: 'p' });
  await assert.rejects(stopped.reserve(), /authority|setup/);
});

test('Shadow execution identity differs from parent and deadline is capped at 900 seconds', async () => {
  const { control, reserve, contextRef } = await fixture();
  await assert.rejects(reserve({ actor: agent, role: 'reviewer',
    scope: { allowedActions: ['review'], maxTasks: 1, maxConcurrent: 1, deadlineAt: deadline(901) } }), /deadline within policy/);
  const reserved = await reserve({ actor: agent, role: 'reviewer', parentExecutionId: 'parent-exec' });
  await assert.rejects(control.bindShadowExecution({ shadowId: reserved.id, executionId: 'parent-exec',
    actor: reconciler, reason: 'Unsafe bind' }), /distinct/);
  const bound = await control.bindShadowExecution({ shadowId: reserved.id, executionId: 'child-exec',
    actor: reconciler, reason: 'Independent bind' });
  assert.equal(bound.parentExecutionId, 'parent-exec');
  assert.deepEqual(bound.contextRef, contextRef);
});

test('reviewed result validates exact candidates, severities and accept resolution; zero findings is valid', async () => {
  const { control, reserve, snapshot } = await fixture();
  await control.configureShadowPolicy({ policy, actor: owner, reason: 'Enable', idempotencyKey: 'policy' });
  const reserved = await reserve();
  await control.bindShadowExecution({ shadowId: reserved.id, executionId: 'child-exec',
    actor: reconciler, reason: 'Independent bind' });
  const base = { status: 'reviewed', schemaVersion: 1, verdict: 'accept', candidateRefs: [ref],
    findings: [], outputDigest: `sha256:${'c'.repeat(64)}` };
  for (const reviewResult of [
    undefined,
    { ...base, schemaVersion: undefined },
    { ...base, candidateRefs: [] },
    { ...base, candidateRefs: [{ ...ref, version: 'stale' }] },
    { ...base, findings: [{ severity: 'P4', summary: 'Bad', sourceRef: ref }] },
    { ...base, findings: [{ severity: 'P0', summary: 'Critical', sourceRef: ref }] },
    { ...base, findings: [{ severity: 'P1', summary: 'Claims resolved without evidence', sourceRef: ref, resolved: true }] },
  ]) await assert.rejects(control.closeShadow({ shadowId: reserved.id, outcome: 'completed',
    reviewResult, actor: reconciler, reason: 'Validate' }));
  const completed = await control.closeShadow({ shadowId: reserved.id, outcome: 'completed',
    reviewResult: base, actor: reconciler, reason: 'Native terminal callback' });
  assert.deepEqual(completed.reviewResult, { ...base, snapshotId: snapshot.id });
  assert.deepEqual(validateShadowReviewResult({ ...base, verdict: 'rework', findings: [
    { severity: 'P1', summary: 'Fix needed', sourceRef: ref }] }, snapshot).verdict, 'rework');
});

test('stop request is audited without closing the native Shadow', async () => {
  const { control, reserve } = await fixture();
  const reserved = await reserve({ actor: agent, role: 'reviewer' });
  await assert.rejects(control.requestShadowStop({ shadowId: reserved.id,
    actor: { ...agent, executionId: 'imposter' }, reason: 'Stop', idempotencyKey: 'bad' }), /original Agent execution/);
  const request = { shadowId: reserved.id, actor: agent, reason: 'Stop this session', idempotencyKey: 'stop' };
  const stopped = await control.requestShadowStop(request);
  assert.equal(stopped.status, 'reserved');
  assert.ok(stopped.stopRequestedAt);
  assert.equal((await control.requestShadowStop(request)).stopRequestedAt, stopped.stopRequestedAt);
  assert.equal((await control.getAudit()).filter(event => event.kind === 'shadow.stop-requested').length, 1);
  await control.bindShadowExecution({ shadowId: reserved.id, executionId: 'child-exec',
    actor: reconciler, reason: 'Native session started' });
  const closed = await control.closeShadow({ shadowId: reserved.id, outcome: 'cancelled',
    actor: reconciler, reason: 'Native terminal event' });
  assert.equal(closed.status, 'closed');
});

test('late recovery binds only a native execution completed before its reserved deadline', async () => {
  const { store, reserve } = await fixture();
  const reserved = await reserve({ actor: agent, role: 'reviewer' });
  const recovered = new CompanyControlPlane({ store, companyId: 'company',
    now: () => new Date(Date.now() + 120_000).toISOString() });
  await assert.rejects(recovered.bindShadowExecution({ shadowId: reserved.id,
    executionId: 'child-exec', finishedAt: new Date(Date.now() + 90_000).toISOString(),
    actor: reconciler, reason: 'Late native completion' }), /expired/);
  const bound = await recovered.bindShadowExecution({ shadowId: reserved.id,
    executionId: 'child-exec', finishedAt: new Date(Date.now() + 30_000).toISOString(),
    actor: reconciler, reason: 'Verified native pre-deadline completion' });
  assert.equal(bound.status, 'active');
});

test('Core stop intent vetoes a stale successful terminal observation atomically', async () => {
  const { control, reserve } = await fixture();
  const reserved = await reserve({ actor: agent, role: 'reviewer' });
  await control.bindShadowExecution({ shadowId: reserved.id, executionId: 'child-exec',
    actor: reconciler, reason: 'Native session started' });
  await control.requestShadowStop({ shadowId: reserved.id, actor: agent,
    reason: 'Withdraw review acceptance', idempotencyKey: 'stop' });
  const closed = await control.closeShadow({ shadowId: reserved.id, outcome: 'completed',
    reviewResult: { status: 'reviewed', schemaVersion: 1, verdict: 'accept',
      candidateRefs: [ref], findings: [], outputDigest: `sha256:${'c'.repeat(64)}` },
    actor: reconciler, reason: 'Terminal observation raced with stop', idempotencyKey: 'close' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'cancelled');
  assert.equal(closed.reviewResult, undefined);
});
