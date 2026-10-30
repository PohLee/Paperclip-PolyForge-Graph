import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPORARY_AGENT_DEFAULT_POLICY, normalizeTemporaryAgentPolicy,
  validateTemporaryAgentRequest, validateTemporaryAgentContextReceipt,
  validateTemporaryAgentResult,
} from '../../src/core/temporary-agent-contract.mjs';

const now = '2026-10-30T00:00:00.000Z';
const policy = { enabled: true };
const authority = { agentId: 'lead', canDelegate: true,
  allowedActions: ['review', 'research', 'analyze', 'implement'] };
const request = {
  id: 'child-1', kind: 'sub-agent', purpose: 'review',
  parent: { agentId: 'lead', executionId: 'parent-exec' },
  context: { mode: 'fresh', parentSessionRef: 'parent-session' },
  brief: { objective: 'Check the candidate', scope: 'Only candidate v1', outputFormat: 'Findings and verdict',
    boundaries: ['No writes'], inputRefs: [{ kind: 'artifact', id: 'candidate', version: 'v1' }],
    acceptanceCriteria: ['Cite each finding'], allowedActions: ['review'],
    deadlineAt: '2026-10-30T00:05:00.000Z' },
};
const options = { policy, parentAuthority: authority, now };

test('policy starts disabled and normalization retains bounded defaults', () => {
  assert.equal(TEMPORARY_AGENT_DEFAULT_POLICY.enabled, false);
  assert.equal(normalizeTemporaryAgentPolicy(policy).maxConcurrentChildren, 3);
  assert.throws(() => validateTemporaryAgentRequest(request, { ...options, policy: {} }), /disabled/);
  assert.throws(() => normalizeTemporaryAgentPolicy({ maxConcurrentChildren: 17 }), /policy/);
  assert.throws(() => normalizeTemporaryAgentPolicy({ maxDepth: 2 }), /policy/);
  assert.throws(() => normalizeTemporaryAgentPolicy({ maxDurationSeconds: 3601 }), /policy/);
});

test('fresh independent review requires a complete bounded brief and parent authority', () => {
  const valid = validateTemporaryAgentRequest(request, options);
  assert.deepEqual(valid.limits, { maxTasks: 1, maxConcurrent: 1 });
  assert.deepEqual(valid.workspace, { mode: 'shared', writeAccess: 'none' });
  for (const brief of [
    { ...request.brief, inputRefs: [] },
    { ...request.brief, acceptanceCriteria: [] },
    { ...request.brief, boundaries: [] },
    { ...request.brief, deadlineAt: '2026-10-30T00:16:00.000Z' },
  ]) assert.throws(() => validateTemporaryAgentRequest({ ...request, brief }, options));
  assert.throws(() => validateTemporaryAgentRequest({ ...request,
    brief: { ...request.brief, allowedActions: ['review', 'deploy'] } }, options), /authority/);
  assert.throws(() => validateTemporaryAgentRequest(request, { ...options,
    parentAuthority: { ...authority, canDelegate: false } }), /authority/);
  assert.throws(() => validateTemporaryAgentRequest({ ...request, depth: 2 }, options), /depth/);
  assert.throws(() => validateTemporaryAgentRequest({ ...request,
    limits: { maxTasks: 2 } }, options), /limits/);
});

test('Shadow-Agent requires snapshot context and cannot act as an independent reviewer', () => {
  const shadow = { ...request, kind: 'shadow-agent', purpose: 'research',
    context: { ...request.context, mode: 'snapshot', snapshot: {
      objective: 'Research current question', currentState: 'Work is pending',
      conclusions: [], openQuestions: ['What is source A?'],
      evidenceRefs: [{ kind: 'document', id: 'source-a' }],
    } },
    brief: { ...request.brief, allowedActions: ['research'] } };
  assert.equal(validateTemporaryAgentRequest(shadow, options).context.mode, 'snapshot');
  assert.throws(() => validateTemporaryAgentRequest({ ...shadow, purpose: 'review',
    brief: { ...shadow.brief, allowedActions: ['review'] } }, options), /fresh Sub-Agent/);
  assert.throws(() => validateTemporaryAgentRequest({ ...shadow,
    context: { ...shadow.context, mode: 'fresh' } }, options), /context mode/);
  assert.throws(() => validateTemporaryAgentRequest({ ...shadow,
    context: { ...shadow.context, mode: 'fork' } }, options), /context mode/);
});

test('only one shared writer is admitted with a matching lease; read-only children may parallel', () => {
  const implementation = { ...request, purpose: 'implement',
    brief: { ...request.brief, allowedActions: ['implement'] },
    workspace: { mode: 'shared', writeAccess: 'exclusive', writerLeaseRef: 'lease-1' } };
  const writable = { ...options, policy: { ...policy, allowSharedWorkspaceWrites: true },
    parentAuthority: { ...authority, workspace: { allowSharedWrite: true, writerLeaseRef: 'lease-1' } } };
  assert.equal(validateTemporaryAgentRequest(implementation, writable).workspace.writerLeaseRef, 'lease-1');
  assert.throws(() => validateTemporaryAgentRequest(implementation, options), /writer lease/);
  assert.throws(() => validateTemporaryAgentRequest({ ...request, workspace: implementation.workspace }, writable), /read-only/);
  assert.throws(() => validateTemporaryAgentRequest(implementation, { ...writable,
    activeChildren: [{ status: 'active', workspace: implementation.workspace }] }), /concurrency/);
  const activeChildren = [1, 2].map(() => ({ status: 'active', workspace: { mode: 'shared', writeAccess: 'none' } }));
  assert.equal(validateTemporaryAgentRequest(request, { ...options, activeChildren }).purpose, 'review');
  assert.throws(() => validateTemporaryAgentRequest(request, { ...options,
    activeChildren: [...activeChildren, activeChildren[0]] }), /concurrency/);
});

test('host receipt attests a new session with frozen snapshot provenance', () => {
  const base = { requestId: request.id, mode: 'fresh', parentSessionRef: 'parent-session',
    sessionRef: 'child-session', executionId: 'child-exec', creationMethod: 'new-session' };
  assert.deepEqual(validateTemporaryAgentContextReceipt(base, request), base);
  assert.throws(() => validateTemporaryAgentContextReceipt({ ...base, sessionRef: 'parent-session' }, request), /receipt/);
  assert.throws(() => validateTemporaryAgentContextReceipt({ ...base, creationMethod: 'native-fork' }, request), /fresh/);
  const shadow = { ...request, kind: 'shadow-agent', purpose: 'research',
    context: { ...request.context, mode: 'snapshot' } };
  const snapshot = { ...base, mode: 'snapshot', snapshotDigest: `sha256:${'a'.repeat(64)}`,
    snapshotCapturedAt: now };
  assert.deepEqual(validateTemporaryAgentContextReceipt(snapshot, shadow), snapshot);
  assert.throws(() => validateTemporaryAgentContextReceipt({ ...snapshot, creationMethod: 'native-fork' }, shadow), /snapshot provenance/);
  assert.throws(() => validateTemporaryAgentContextReceipt({ ...snapshot, forkRef: 'invented' }, shadow), /snapshot provenance/);
});

test('completed reports carry output and evidence; terminal failures retain a reason', () => {
  const result = { status: 'completed', summary: 'Accepted with no findings',
    executionId: 'child-exec', sessionRef: 'child-session', finishedAt: now,
    output: { verdict: 'accept' }, evidenceRefs: [{ kind: 'artifact', id: 'candidate', version: 'v1' }] };
  assert.deepEqual(validateTemporaryAgentResult(result, request), result);
  assert.throws(() => validateTemporaryAgentResult({ ...result, evidenceRefs: [] }, request), /evidence/);
  assert.throws(() => validateTemporaryAgentResult({ ...result, output: undefined }, request), /output/);
  assert.throws(() => validateTemporaryAgentResult({ ...result, executionId: 'parent-exec' }, request), /result/);
  assert.equal(validateTemporaryAgentResult({ ...result, status: 'failed', summary: 'Host stopped',
    output: undefined, evidenceRefs: [] }, request).status, 'failed');
});
