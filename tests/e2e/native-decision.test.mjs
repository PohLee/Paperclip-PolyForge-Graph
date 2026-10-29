import test from 'node:test';
import assert from 'node:assert/strict';
import { syncGraphDecision } from '../../src/plugin/native-decisions.mjs';

test('native Decision gathers candidate-bound human exception evidence', async () => {
  const run = { id: 'run-a', status: 'paused', pack: { decisionRules: [{ type: 'acceptance', mode: 'manual',
    requiredEvidence: ['verification_proof'] }] }, mode: 'manual',
  input: { paperclipIssueId: 'issue-a' }, pendingHuman: { kind: 'decision', nodeId: 'acceptance',
    escalationDecisionId: 'escalation-a' }, conflicts: [],
  graph: { id: 'verification', nodes: [{ id: 'acceptance', type: 'decision', decisionType: 'acceptance',
    outcomes: ['accept', 'rework'], candidateNodes: ['matrix'],
    decisionContract: { type: 'acceptance-proof', sourceNode: 'matrix' } }], edges: [] },
  nodeStates: { matrix: { status: 'completed', output: { criteria: [{ id: 'criterion-a', result: 'unverified' }] },
    artifacts: [{ id: 'matrix-a', version: 'v2', kind: 'acceptance_matrix' }] } } };
  let questions, resolved;
  const host = { issues: { listInteractions: async () => [], askUserQuestions: async (_issue, card) => {
    questions = card.payload.questionSet.questions;
    return { id: 'interaction-a', status: 'resolved', resolvedByUserId: 'owner-a',
      result: { answers: [
        { questionId: 'choice', optionIds: ['accept'] }, { questionId: 'reason', otherText: 'Accepted with risk' },
        { questionId: 'evidence-0', otherText: 'Matrix was reviewed' },
        { questionId: 'exception-reason-0', otherText: 'No instrument available' },
        { questionId: 'exception-risk-0', otherText: 'May miss an edge case' },
      ] } };
  } } };
  const engine = { listDecisions: async () => [{ id: 'escalation-a', evidence: [] }],
    resolveHumanGate: async (args) => { resolved = args; },
    getRun: async () => ({ status: 'paused' }) };
  const result = await syncGraphDecision({ host, companyId: 'company-a', run, engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner-a' } } }) }, config: {},
    trustedActor: async () => ({ actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'] } }),
    dispatchReady: async () => {} });
  assert.equal(result[0].syncError, null);
  assert.ok(questions.some((item) => item.id === 'exception-risk-0'));
  assert.deepEqual(resolved.evidence.find((item) => item.kind === 'verification_proof').subjectRefs,
    [{ artifactId: 'matrix-a', version: 'v2' }]);
  assert.equal(resolved.evidence.find((item) => item.kind === 'acceptance_exception').risk, 'May miss an edge case');
});

test('native conflict Decision cites a recorded side decision as sourced evidence', async () => {
  const run = { id: 'run-b', status: 'paused', input: { paperclipIssueId: 'issue-b' },
    graph: { id: 'delivery', nodes: [], edges: [] }, conflicts: [{ id: 'conflict-b',
      status: 'waiting_human', protocolVersion: 2, nodeId: 'gate',
      positionDecisionIds: { cpo: 'decision-cpo', cto: 'decision-cto' },
      options: [{ id: 'continue', label: 'Continue', disposition: 'continue' }] }] };
  let resolved;
  await syncGraphDecision({ host: { issues: { listInteractions: async () => [],
    askUserQuestions: async () => ({ id: 'interaction-b', status: 'resolved', resolvedByUserId: 'owner-b',
      result: { answers: [{ questionId: 'choice', optionIds: ['continue'] },
        { questionId: 'reason', otherText: 'CPO evidence is stronger' }] } }) } },
  companyId: 'company-b', run, engine: { resolveConflict: async (args) => { resolved = args; },
    getRun: async () => ({ status: 'paused' }) },
  control: { getSetup: async () => ({ organization: { board: { id: 'owner-b' } } }) }, config: {},
  trustedActor: async () => ({ actor: { id: 'owner-b', kind: 'human', roles: ['human-owner'] } }),
  dispatchReady: async () => {} });
  assert.equal(resolved.evidence[0].summary, 'CPO evidence is stronger');
  assert.deepEqual(resolved.evidence[0].sourceRef, { kind: 'decision', id: 'decision-cpo' });
});
