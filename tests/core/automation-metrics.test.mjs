import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';

const actor = { kind: 'system', id: 'host', roles: [] };
const owner = { kind: 'human', id: 'owner', roles: ['human-owner'] };
const asOf = '2026-11-26T10:00:00.000Z';
const headSha = 'a'.repeat(40), mergeCommitSha = 'b'.repeat(40), revertSha = 'c'.repeat(40);

test('computes project baselines with a real gate transition, CI retries and merge reverts', async () => {
  let now = '2026-11-26T09:00:00.000Z';
  const store = new MemoryStore();
  const engine = new GraphEngine({ store, now: () => now });
  const pack = { id: 'metrics', version: '1', decisionRules: [
    { type: 'approval', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['human-owner'] },
  ], graphs: [{ id: 'graph', version: '1', start: 'gate',
    nodes: [{ id: 'gate', type: 'decision', role: 'human-owner', decisionType: 'approval',
      reworkTarget: 'gate' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'gate', to: 'end', when: 'accept' }] }] };
  await engine.registerPack(pack);
  const run = await engine.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'graph',
    actor: owner, input: { projectId: 'project' } });
  const runId = run.id;
  now = '2026-11-26T09:01:00.000Z';
  await engine.decideNode({ runId, nodeId: 'gate', outcome: 'rework', reason: 'Revise', actor: owner });
  now = '2026-11-26T09:03:00.000Z';
  await engine.decideNode({ runId, nodeId: 'gate', outcome: 'accept', reason: 'Approved', actor: owner });
  const ci = { runId, repository: 'org/repo', pullNumber: 1, headSha, actor, executionId: 'first', result: 'fail' };
  await assert.rejects(engine.recordCIResult({ ...ci, actor: owner }), /Trusted Host/);
  assert.deepEqual(await engine.recordCIResult(ci), await engine.recordCIResult(ci));
  now = '2026-11-26T09:05:00.000Z';
  await engine.recordCIResult({ ...ci, executionId: 'retry', result: 'pass' });
  await engine.recordCIResult({ ...ci, pullNumber: 2, result: 'pass' });
  await engine.recordImplementationMerge(runId, { repository: ci.repository, pullNumber: 1, mergeCommitSha, autoMerged: true });
  await engine.recordImplementationMerge(runId, { repository: ci.repository, pullNumber: 2, mergeCommitSha: headSha, autoMerged: false });
  now = '2026-11-26T09:10:00.000Z';
  const revert = { runId, mergeCommitSha, revertSha, actor };
  assert.deepEqual(await engine.recordRevert(revert), await engine.recordRevert(revert));
  const window = { projectId: 'project', from: '2026-11-26T09:00:00.000Z', to: asOf };
  const result = await engine.getAutomationMetrics(window);
  assert.deepEqual(result.gateWaitTime, { count: 2, averageMilliseconds: 90000 });
  assert.deepEqual(result.reworkRate.byNode.find(row => row.nodeId === 'gate'),
    { graphId: 'graph', nodeId: 'gate', reworks: 1, completions: 1, count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(result.firstCIPassRate, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(result.autoMergeRevertRate, { count: 1, total: 1, rate: 1 });
  assert.equal((await engine.getAutomationMetrics({ ...window, to: now })).autoMergeRevertRate.rate, 0);
  assert.equal((await engine.getAutomationMetrics({ ...window, projectId: 'other' })).firstCIPassRate.rate, null);
});
