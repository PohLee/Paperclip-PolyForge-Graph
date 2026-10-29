import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, recordIntervention, proposeInterventionImprovement, updateInterventionImprovement, interventionReport } from '../../src/core/index.mjs';

test('project-scoped interventions retain evidence and proposals do not auto-change policy', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', graphs: [{ id: 'g', version: '1', start: 'work',
    nodes: [{ id: 'work', type: 'task' }], edges: [] }] });
  const actor = { kind: 'human', id: 'owner', roles: ['human-owner'] };
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'g', actor,
    input: { context: 'Context manually carried between sessions' } });
  const observed = await recordIntervention(engine, { runId: run.id, actor, kind: 'carry',
    reason: 'Repeatedly carried the same context', outcomeSignal: 'Task finished after manual context transfer',
    evidence: [{ kind: 'run', sourceRef: { kind: 'run_input', key: 'context' } }] });
  const observedAgain = await recordIntervention(engine, { runId: run.id, actor, kind: 'carry',
    reason: 'The next task again required context transfer', outcomeSignal: 'Second transfer completed the task',
    evidence: [{ kind: 'run', sourceRef: { kind: 'run_input', key: 'context' } }] });
  assert.equal(observed.status, 'observed');
  const premature = await proposeInterventionImprovement(engine, { runId: run.id, actor,
    interventionIds: [observed.id], mechanism: 'Premature guard', expectedOutcome: 'Fewer transfers',
    evidence: [{ kind: 'intervention', sourceRef: { kind: 'decision', id: observed.id } }] });
  const proof = [
    { kind: 'enforcement_proof', level: 'check', mechanism: 'Durable handoff validator', sourceRef: { kind: 'external', url: 'https://example.test/guard/1' } },
    { kind: 'negative_control', command: 'node check-handoff.mjs fixture-missing-context', observedFailure: 'Missing context rejected', sourceRef: { kind: 'external', url: 'https://example.test/negative/1' } }
  ];
  await assert.rejects(updateInterventionImprovement(engine, { runId: run.id, actor,
    previousDecisionId: premature.id, status: 'graduated', reason: 'Insufficient repetition',
    outcomeSignal: 'Transfers fell', evidence: proof }), /two distinct recorded interventions/);
  const proposal = await proposeInterventionImprovement(engine, { runId: run.id, actor,
    interventionIds: [observed.id, observedAgain.id], mechanism: 'Add a durable handoff summary',
    expectedOutcome: 'Fewer repeated context transfers with unchanged task success',
    evidence: [{ kind: 'intervention', sourceRef: { kind: 'decision', id: observed.id } }] });
  const report = await interventionReport(engine, run.id);
  assert.equal(report.counts.carry, 2);
  assert.equal(report.proposals.at(-1).id, proposal.id);
  assert.equal(report.outcomeKnown, false);
  assert.equal((await engine.getRun(run.id)).status, 'running');
  await assert.rejects(updateInterventionImprovement(engine, { runId: run.id, actor,
    previousDecisionId: proposal.id, status: 'graduated', reason: 'Missing negative control',
    outcomeSignal: 'Transfers fell', evidence: [{ kind: 'experiment', sourceRef: { kind: 'external', url: 'https://example.test/eval/1' } }] }), /negative control/);
  const graduated = await updateInterventionImprovement(engine, { runId: run.id, actor,
    previousDecisionId: proposal.id, status: 'graduated', reason: 'Handoff proved useful in repeated trials',
    outcomeSignal: 'Task success held while manual transfers fell',
    evidence: [...proof, { kind: 'experiment', sourceRef: { kind: 'external', url: 'https://example.test/eval/1' } }] });
  assert.equal((await interventionReport(engine, run.id)).activeProposals.at(-1).id, graduated.id);
  await assert.rejects(updateInterventionImprovement(engine, { runId: run.id, actor,
    previousDecisionId: proposal.id, status: 'retired', reason: 'Stale', outcomeSignal: 'N/A',
    evidence: [{ kind: 'experiment', sourceRef: { kind: 'external', url: 'https://example.test/eval/2' } }] }), /stale/);
  const transition = status => ({ runId: run.id, actor, previousDecisionId: graduated.id,
    status, reason: `Outcome now ${status}`, outcomeSignal: `Observed ${status} evidence`,
    evidence: [{ kind: 'experiment', sourceRef: { kind: 'external', url: 'https://example.test/eval/3' } }],
    idempotencyKey: `transition-${status}` });
  const raced = await Promise.allSettled([
    updateInterventionImprovement(engine, transition('reopened')),
    updateInterventionImprovement(engine, transition('retired')),
  ]);
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  const winner = raced.find(item => item.status === 'fulfilled').value;
  assert.equal((await updateInterventionImprovement(engine, transition(winner.status))).id, winner.id);
  assert.equal((await interventionReport(engine, run.id)).activeProposals.length, 2);
  await engine.retryNode({ runId: run.id, nodeId: 'work', actor, reason: 'Recover a failed host attempt' });
  assert.equal((await interventionReport(engine, run.id)).counts.retry, 1);
  await assert.rejects(recordIntervention(engine, { runId: run.id, actor, kind: 'approve', reason: 'Release',
    evidence: [], outcomeSignal: 'Good' }), /sourced evidence/);
  await assert.rejects(recordIntervention(engine, { runId: run.id, actor, kind: 'carry', reason: 'Bad source',
    evidence: [{ kind: 'run', sourceRef: { kind: 'run_input', key: 'missing' } }], outcomeSignal: 'Unknown' }), /does not resolve/);
});
