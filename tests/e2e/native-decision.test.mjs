import test from 'node:test';
import assert from 'node:assert/strict';
import { syncGraphDecision } from '../../src/plugin/native-decisions.mjs';
import { GraphEngine } from '../../src/core/index.mjs';

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

test('Graph card replay reuses its identity and an untrusted resolver cannot change Core', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'test', version: '1', graphs: [{ id: 'route', version: '1',
    start: 'gate', nodes: [{ id: 'gate', type: 'decision', role: 'owner', outcomes: ['go', 'stop'] },
      { id: 'end', type: 'end' }], edges: [{ from: 'gate', to: 'end', when: 'go' }] }],
  decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['agent', 'human'],
    allowedRoles: ['owner'] }] });
  const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'] };
  const agent = { id: 'agent', kind: 'agent', roles: ['owner'], executionId: 'execution' };
  const started = await engine.startRun({ packId: 'test', packVersion: '1', graphId: 'route',
    mode: 'manual', actor: owner, input: { paperclipIssueId: 'issue' } });
  await engine.escalateNode({ runId: started.id, nodeId: 'gate', actor: agent, reason: 'Need owner' });
  const cards = [];
  const host = { issues: { listInteractions: async () => cards,
    askUserQuestions: async (_issueId, spec) => {
      assert.equal(spec.resolverPolicy, 'human_only');
      assert.equal(spec.continuationPolicy, 'none');
      const card = { id: 'card', status: 'pending', idempotencyKey: spec.idempotencyKey };
      cards.push(card); return card;
    } } };
  const args = { host, companyId: 'company', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => ({ actor: { id: 'intruder', kind: 'human', roles: [] } }),
    dispatchReady: async () => {} };
  await syncGraphDecision({ ...args, run: await engine.getRun(started.id) });
  await syncGraphDecision({ ...args, run: await engine.getRun(started.id) });
  assert.equal(cards.length, 1);
  assert.match(cards[0].idempotencyKey, new RegExp(`^polyforge-graph-decision:${started.id}:gate:gate:`));
  const before = await engine.listDecisions({ runId: started.id });
  cards[0].status = 'resolved'; cards[0].resolvedByUserId = 'intruder';
  cards[0].result = { answers: [{ questionId: 'choice', optionIds: ['go'] },
    { questionId: 'reason', otherText: 'Try to proceed' }] };
  const rejected = await syncGraphDecision({ ...args, run: await engine.getRun(started.id) });
  assert.match(rejected[0].syncError, /human-owner/);
  assert.equal((await engine.getRun(started.id)).status, 'paused');
  assert.deepEqual(await engine.listDecisions({ runId: started.id }), before);
  cards[0].resolvedByUserId = 'owner';
  const accepted = await syncGraphDecision({ ...args,
    trustedActor: async () => ({ actor: owner }), run: await engine.getRun(started.id) });
  assert.equal(accepted[0].syncError, null);
  assert.equal((await engine.listDecisions({ runId: started.id })).length, before.length + 1);
  assert.equal(cards.length, 1);
});
