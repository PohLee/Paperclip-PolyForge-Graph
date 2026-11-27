import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syncGraphDecision } from '../../src/plugin/native-decisions.mjs';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';

function gateCard(run, outcomes, generation = 'snapshot') {
  const key = `gate:${run.pendingHuman.nodeId}:${run.pendingHuman.escalationDecisionId}`;
  const options = outcomes.map((id) => ({ id, label: id }));
  const version = createHash('sha256').update(JSON.stringify({ key,
    ...(generation === 'released' ? {} : { runDigest: runValidationDigest(run) }),
    candidates: [], questions: [], ...(generation === 'projected' ? { options } : {}) })).digest('hex');
  return { id: `${generation}-card`, status: 'pending', idempotencyKey: `polyforge-graph-decision:${run.id}:${key}:${version}`,
    payload: { questionSet: { questions: [{ id: 'choice', options }] } } };
}

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
  assert.equal(resolved.expectedRunDigest, runValidationDigest(run));
});

const gateOutcomeCases = [
  { name: 'default rework', gate: {}, outcomes: ['go', 'ship', 'rework'], choice: 'rework', nextNode: 'work' },
  { name: 'named rework', gate: { reworkOutcome: 'revise' },
    outcomes: ['go', 'ship', 'revise'], choice: 'revise', nextNode: 'work' },
  { name: 'explicit outcome order', gate: { outcomes: ['ship', 'go'] },
    outcomes: ['ship', 'go'], choice: 'ship', nextNode: 'end' },
];

async function prepareGate(gate = {}) {
  const engine = new GraphEngine();
  const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'] };
  await engine.registerPack({ id: 'gate-options', version: '1', graphs: [{ id: 'flow', version: '1', start: 'work',
    nodes: [{ id: 'work', type: 'task' }, { id: 'gate', type: 'decision', role: 'owner', reworkTarget: 'work', ...gate },
      { id: 'end', type: 'end' }],
    edges: [{ from: 'work', to: 'gate' }, { from: 'gate', to: 'end', when: ['go', 'ship', 'go'] }] }],
    decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['owner'] }] });
  const { id: runId } = await engine.startRun({ packId: 'gate-options', packVersion: '1', graphId: 'flow',
    actor: owner, input: { paperclipIssueId: 'issue' } });
  await engine.submitNode({ runId, nodeId: 'work', actor: owner });
  return { engine, owner, runId };
}

for (const { name, gate, outcomes, choice, nextNode } of gateOutcomeCases) {
  test(`native gate options match Core Work Items for ${name}`, async () => {
    const { engine, owner, runId } = await prepareGate(gate);
    assert.deepEqual((await engine.getWorkItems(runId))[0].outcomes, outcomes);
    const escalation = await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
    const [workItem] = await engine.getWorkItems(runId);
    assert.equal(workItem.operation, 'resolve-human-gate');
    assert.deepEqual(workItem.outcomes, outcomes);

    const host = { issues: { listInteractions: async () => [], askUserQuestions: async (_issueId, spec) => {
      const question = spec.payload.questionSet.questions.find((item) => item.id === 'choice');
      assert.deepEqual(question.options, workItem.outcomes.map((id) => ({ id, label: id })));
      return { id: 'card', status: 'resolved', resolvedByUserId: 'owner', result: { answers: [
        { questionId: 'choice', optionIds: [choice] }, { questionId: 'reason', otherText: 'Owner decision' },
      ] } };
    } } };
    const result = await syncGraphDecision({ host, companyId: 'company', run: await engine.getRun(runId), engine,
      control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) }, config: {},
      trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} });
    assert.equal(result[0].syncError, null);
    assert.deepEqual((await engine.getReadyNodes(runId)).map(({ id }) => id), [nextNode]);
    const decision = (await engine.listDecisions({ runId })).find((item) => item.supersedes === escalation.decision.id);
    assert.equal(decision?.outcome, choice);
  });
}

test('native requires a fresh digest-bound answer when migrating a released-format card', async () => {
  const { engine, owner, runId } = await prepareGate();
  const escalation = await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
  const run = await engine.getRun(runId);
  const released = gateCard(run, ['go', 'ship'], 'released');
  Object.assign(released, { status: 'resolved', resolvedByUserId: owner.id,
    result: { answers: [{ questionId: 'choice', optionIds: ['go'] },
      { questionId: 'reason', otherText: 'Ship the current work' }] } });
  const cards = [released];
  const args = { run, engine, companyId: 'company', config: {},
    host: { issues: { listInteractions: async () => cards,
      askUserQuestions: async (_issue, spec) => {
        const card = { ...spec, id: 'current-card', status: 'pending' }; cards.push(card); return card;
      } } },
    control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
    trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} };
  const [pending] = await syncGraphDecision(args);
  assert.equal(pending.interactionId, 'current-card');
  assert.equal(pending.requestId, escalation.decision.id);
  assert.equal(pending.runDigest, runValidationDigest(run));
  assert.deepEqual(await engine.getRun(runId), run);
  Object.assign(cards[1], { status: 'resolved', resolvedByUserId: owner.id, result: released.result });
  const [result] = await syncGraphDecision(args);
  assert.equal(result.interactionId, cards[1].id);
  assert.equal(result.candidateVersion, cards[1].idempotencyKey.split(':').at(-1));
  assert.equal(result.syncError, null);
  assert.equal(cards.length, 2);
  assert.deepEqual((await engine.getReadyNodes(runId)).map(({ id }) => id), ['end']);
  const decision = (await engine.listDecisions({ runId })).find((item) => item.supersedes === escalation.decision.id);
  assert.equal(decision?.outcome, 'go');
  assert.equal(decision.evidence[0].interactionId, cards[1].id);
});

test('native replaces an unanswered released-format card whose options changed', async () => {
  const { engine, owner, runId } = await prepareGate();
  await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
  const run = await engine.getRun(runId);
  const released = gateCard(run, ['go', 'ship'], 'released');
  const projected = gateCard(run, ['go', 'ship', 'rework'], 'projected');
  let created = 0;
  const [result] = await syncGraphDecision({ run, engine, companyId: 'company', config: {},
    host: { issues: { listInteractions: async () => [released], askUserQuestions: async (_issue, spec) => {
      created++;
      assert.equal(spec.idempotencyKey, projected.idempotencyKey);
      assert.deepEqual(spec.payload.questionSet.questions[0].options, projected.payload.questionSet.questions[0].options);
      return { ...spec, id: 'replacement', status: 'pending' };
    } } },
    control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
    trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} });
  assert.equal(created, 1);
  assert.equal(result.interactionId, 'replacement');
  assert.equal(result.candidateVersion, projected.idempotencyKey.split(':').at(-1));
  assert.equal(result.syncError, null);
  assert.equal((await engine.getRun(runId)).status, 'paused');
});

test('native renders missing rework on a replacement and honors a snapshot-generation answer', async () => {
  const { engine, owner, runId } = await prepareGate();
  const escalation = await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
  const run = await engine.getRun(runId);
  const snapshot = gateCard(run, ['go', 'ship']);
  const cards = [snapshot];
  const host = { issues: { listInteractions: async () => cards,
    askUserQuestions: async (_issueId, spec) => {
      assert.notEqual(spec.idempotencyKey, snapshot.idempotencyKey);
      assert.deepEqual(spec.payload.questionSet.questions[0].options.map(({ id }) => id), ['go', 'ship', 'rework']);
      const card = { id: 'updated-card', status: 'pending', idempotencyKey: spec.idempotencyKey, payload: spec.payload };
      cards.push(card);
      return card;
    } } };
  const args = { host, companyId: 'company', run, engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) }, config: {},
    trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} };
  const [projected] = await syncGraphDecision(args);
  assert.equal(projected.interactionId, 'updated-card');
  assert.deepEqual(await syncGraphDecision(args), [projected]);
  assert.equal(cards.length, 2);

  snapshot.status = 'resolved'; snapshot.resolvedByUserId = 'owner';
  snapshot.result = { answers: [{ questionId: 'choice', optionIds: ['go'] },
    { questionId: 'reason', otherText: 'Ship the current work' }] };
  const [resolved] = await syncGraphDecision(args);
  assert.equal(resolved.interactionId, snapshot.id);
  assert.equal(resolved.syncError, null);
  const decision = (await engine.listDecisions({ runId })).find((item) => item.supersedes === escalation.decision.id);
  assert.equal(decision?.outcome, 'go');
  assert.equal(decision.evidence[0].interactionId, snapshot.id);
});

for (const generation of ['snapshot']) {
  test(`a rejected ${generation} answer leaves the owner one usable card with the complete options`, async () => {
    const { engine, owner, runId } = await prepareGate();
    await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
    const run = await engine.getRun(runId);
    const olderCard = gateCard(run, ['go', 'ship'], generation);
    const answer = (card, userId, option) => Object.assign(card, { status: 'resolved', resolvedByUserId: userId,
      result: { answers: [{ questionId: 'choice', optionIds: [option] }, { questionId: 'reason', otherText: 'Decision' }] } });
    answer(olderCard, 'outsider', 'go');
    const cards = [olderCard];
    const args = { engine, run, companyId: 'company', config: {}, dispatchReady: async () => {},
      control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
      trustedActor: async (_company, { userId }) => ({ actor: userId === owner.id ? owner : { id: userId, roles: [] } }),
      host: { issues: { listInteractions: async () => cards, askUserQuestions: async (_issue, spec) => {
        const card = { ...spec, id: 'replacement', status: 'pending' }; cards.push(card); return card;
      } } } };
    for (let i = 0; i < 2; i++) {
      const [pending] = await syncGraphDecision(args);
      assert.match(pending.syncError, /human-owner/);
      assert.equal(pending.interactionId, 'replacement');
      assert.equal(cards.length, 2);
    }
    answer(cards[1], owner.id, 'rework');
    assert.equal((await syncGraphDecision(args))[0].syncError, null);
    assert.deepEqual((await engine.getReadyNodes(runId)).map(node => node.id), ['work']);
  });
}

for (const { generations, answered, expected } of [
  { generations: ['released', 'snapshot', 'projected'], answered: ['released'], expected: 'projected' },
  { generations: ['released', 'snapshot', 'projected'], answered: ['released', 'snapshot'], expected: 'snapshot' },
  { generations: ['released', 'snapshot', 'projected'], answered: ['released', 'snapshot', 'projected'], expected: 'projected' },
  { generations: ['released', 'snapshot', 'projected'], answered: [], expected: 'projected' },
  { generations: ['released', 'snapshot'], answered: [], expected: 'snapshot' },
  { generations: ['released'], answered: [], expected: 'projected' },
]) {
  test(`native selects ${expected} with generations ${generations} and answers ${answered}`, async () => {
    const { engine, owner, runId } = await prepareGate();
    await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
    const run = await engine.getRun(runId);
    const cards = generations.map(generation => gateCard(run, ['go', 'ship', 'rework'], generation));
    for (const card of cards.filter(card => answered.includes(card.id.split('-')[0]))) {
      Object.assign(card, { status: 'resolved', resolvedByUserId: owner.id,
        result: { answers: [{ questionId: 'choice', optionIds: ['go'] },
          { questionId: 'reason', otherText: 'Approved' }] } });
    }
    const [result] = await syncGraphDecision({ run, engine, companyId: 'company', config: {},
      host: { issues: { listInteractions: async () => cards,
        askUserQuestions: async (_issue, spec) => {
          assert.deepEqual(generations, ['released']);
          const card = { ...spec, id: 'projected-card', status: 'pending' }; cards.push(card); return card;
        } } },
      control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
      trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} });
    const selected = cards.find(card => card.id === `${expected}-card`);
    assert.equal(result.interactionId, selected.id);
    assert.equal(result.candidateVersion, selected.idempotencyKey.split(':').at(-1));
    assert.equal(result.syncError, null);
    const decision = (await engine.listDecisions({ runId })).find(item => item.evidence?.some(e => e.interactionId === selected.id));
    assert.equal(Boolean(decision), answered.includes(expected));
  });
}

for (const generation of ['snapshot']) {
  for (const outcome of ['rework', 'retired']) {
    test(`native rejects ${generation} answer ${outcome} outside rendered or current options`, async () => {
      const { engine, owner, runId } = await prepareGate();
      await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
      const run = await engine.getRun(runId);
      const card = gateCard(run, ['go', 'ship', 'retired'], generation);
      Object.assign(card, { status: 'resolved', resolvedByUserId: owner.id,
        result: { answers: [{ questionId: 'choice', optionIds: [outcome] },
          { questionId: 'reason', otherText: 'Invalid choice' }] } });
      const before = await engine.listDecisions({ runId });
      const projected = gateCard(run, ['go', 'ship', 'rework'], 'projected');
      let created = 0;
      const [result] = await syncGraphDecision({ run, engine, companyId: 'company', config: {},
        host: { issues: { listInteractions: async () => [card], askUserQuestions: async (_issue, spec) => {
          created++;
          assert.equal(spec.idempotencyKey, projected.idempotencyKey);
          return { ...spec, id: 'replacement', status: 'pending' };
        } } },
        control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
        trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} });
      assert.match(result.syncError, /outcome is invalid/);
      assert.equal(created, 1);
      assert.equal(result.interactionId, 'replacement');
      assert.equal(result.candidateVersion, projected.idempotencyKey.split(':').at(-1));
      assert.deepEqual(await engine.getRun(runId), run);
      assert.deepEqual(await engine.listDecisions({ runId }), before);
    });
  }

  test(`native does not replace a ${generation} answer after the gate transition committed`, async () => {
    const { engine, owner, runId } = await prepareGate();
    await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
    const run = await engine.getRun(runId);
    const card = gateCard(run, ['go', 'ship'], generation);
    Object.assign(card, { status: 'resolved', resolvedByUserId: owner.id,
      result: { answers: [{ questionId: 'choice', optionIds: ['go'] },
        { questionId: 'reason', otherText: 'Approved' }] } });
    const [result] = await syncGraphDecision({ run, engine, companyId: 'company', config: {},
      host: { issues: { listInteractions: async () => [card],
        askUserQuestions: async () => assert.fail('A committed transition must not create a card') } },
      control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
      trustedActor: async () => ({ actor: owner }), dispatchReady: async () => { throw new Error('Dispatch failed'); } });
    assert.equal(result.syncError, 'Dispatch failed');
    assert.equal(result.interactionId, card.id);
    assert.equal(result.candidateVersion, card.idempotencyKey.split(':').at(-1));
    assert.deepEqual((await engine.getReadyNodes(runId)).map(({ id }) => id), ['end']);
  });
}

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
  const waiting = await engine.getRun(started.id);
  cards[0] = gateCard(waiting, ['go', 'stop']);
  const [reused] = await syncGraphDecision({ ...args, run: waiting });
  assert.equal(reused.interactionId, 'snapshot-card');
  assert.equal(cards.length, 1);
  const before = await engine.listDecisions({ runId: started.id });
  cards[0].status = 'resolved'; cards[0].resolvedByUserId = 'intruder';
  cards[0].result = { answers: [{ questionId: 'choice', optionIds: ['go'] },
    { questionId: 'reason', otherText: 'Try to proceed' }] };
  const rejected = await syncGraphDecision({ ...args, run: await engine.getRun(started.id) });
  assert.match(rejected[0].syncError, /human-owner/);
  assert.equal(cards.length, 2, 'rejected older answers get a current-generation replacement even with matching options');
  assert.equal(rejected[0].candidateVersion, cards[1].idempotencyKey.split(':').at(-1));
  assert.equal((await engine.getRun(started.id)).status, 'paused');
  assert.deepEqual(await engine.listDecisions({ runId: started.id }), before);
  cards[0].resolvedByUserId = 'owner';
  const accepted = await syncGraphDecision({ ...args,
    trustedActor: async () => ({ actor: owner }), run: await engine.getRun(started.id) });
  assert.equal(accepted[0].syncError, null);
  assert.equal((await engine.listDecisions({ runId: started.id })).length, before.length + 1);
  assert.equal(cards.length, 2);
});

test('native answer for an outdated run snapshot cannot consume the same pending gate', async () => {
  const engine = new GraphEngine();
  const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'] };
  await engine.registerPack({ id: 'stale-native', version: '1', graphs: [{ id: 'flow', version: '1', start: 'work',
    nodes: [{ id: 'work', type: 'task' }, { id: 'gate', type: 'decision', role: 'owner' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'work', to: 'gate' }, { from: 'gate', to: 'end', when: 'go' }] }],
    decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['owner'] }] });
  const run = await engine.startRun({ packId: 'stale-native', packVersion: '1', graphId: 'flow', actor: owner, input: { paperclipIssueId: 'issue' } });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: owner });
  await engine.escalateNode({ runId: run.id, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
  const snapshot = await engine.getRun(run.id);
  const host = { issues: { listInteractions: async () => [], askUserQuestions: async () => {
    await engine.invalidateEvidence({ runId: run.id, nodeId: 'work', actor: owner, reason: 'Source changed' });
    return { id: 'old-card', status: 'resolved', resolvedByUserId: 'owner', result: { answers: [
      { questionId: 'choice', optionIds: ['go'] }, { questionId: 'reason', otherText: 'Approve old version' }] } };
  } } };
  const args = { host, companyId: 'company', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) }, config: {},
    trustedActor: async () => ({ actor: owner }), dispatchReady: async () => {} };
  const result = await syncGraphDecision({ ...args, run: snapshot });
  assert.match(result[0].syncError, /Run changed since validation/);
  assert.equal(result[0].runDigest, runValidationDigest(snapshot));
  assert.equal(result[0].replacedInteractionId, null);
  const current = await engine.getRun(run.id);
  assert.equal(current.pendingHuman.escalationDecisionId, snapshot.pendingHuman.escalationDecisionId);

  const oldCard = gateCard(snapshot, ['go']);
  oldCard.status = 'resolved'; oldCard.resolvedByUserId = 'owner';
  oldCard.result = { answers: [{ questionId: 'choice', optionIds: ['go'] },
    { questionId: 'reason', otherText: 'Approve old version' }] };
  const cards = [oldCard];
  host.issues.listInteractions = async () => cards;
  host.issues.askUserQuestions = async (_issue, spec) => {
    const card = { ...spec, id: 'current-card', status: 'pending' };
    cards.push(card);
    return card;
  };
  const [fresh] = await syncGraphDecision({ ...args, run: current });
  assert.equal(fresh.interactionId, 'current-card');
  assert.equal(fresh.requestId, result[0].requestId);
  assert.equal(fresh.runDigest, runValidationDigest(current));
  assert.equal((await engine.getRun(run.id)).status, 'paused');

  Object.assign(cards[1], { status: 'answered', resolvedByUserId: owner.id,
    result: { answers: [{ questionId: 'choice', optionIds: ['go'] },
      { questionId: 'reason', otherText: 'Reviewed the current version' }] } });
  const [accepted] = await syncGraphDecision({ ...args, run: current });
  assert.equal(accepted.interactionId, 'current-card');
  assert.equal(accepted.syncError, null);
  assert.deepEqual(await syncGraphDecision({ ...args, run: await engine.getRun(run.id) }), []);
  const decisions = (await engine.listDecisions({ runId: run.id }))
    .filter(item => item.supersedes === current.pendingHuman.escalationDecisionId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, 'go');
  assert.equal(decisions[0].evidence[0].interactionId, 'current-card');
});

for (const answered of [false, true]) {
  test(`native replaces ${answered ? 'answered' : 'pending'} unbound legacy cards after source invalidation`, async () => {
    const { engine, owner, runId } = await prepareGate();
    await engine.escalateNode({ runId, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
    const snapshot = await engine.getRun(runId);
    const legacy = gateCard(snapshot, ['go', 'ship', 'rework'], 'released');
    if (answered) Object.assign(legacy, { status: 'resolved', resolvedByUserId: owner.id,
      result: { answers: [{ questionId: 'choice', optionIds: ['go'] },
        { questionId: 'reason', otherText: 'Approved the old source' }] } });
    await engine.invalidateEvidence({ runId, nodeId: 'work', actor: owner, reason: 'Source changed' });
    const current = await engine.getRun(runId);
    assert.equal(current.pendingHuman.escalationDecisionId, snapshot.pendingHuman.escalationDecisionId);
    assert.notEqual(runValidationDigest(current), runValidationDigest(snapshot));
    assert.equal(gateCard(current, ['go', 'ship', 'rework'], 'released').idempotencyKey, legacy.idempotencyKey);
    const cards = [legacy], before = await engine.listDecisions({ runId });
    const args = { engine, run: current, companyId: 'company', config: {}, dispatchReady: async () => {},
      control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
      trustedActor: async () => ({ actor: owner }),
      host: { issues: { listInteractions: async () => cards, askUserQuestions: async (_issue, spec) => {
        assert.equal(spec.idempotencyKey, gateCard(current, ['go', 'ship', 'rework'], 'projected').idempotencyKey);
        const card = { ...spec, id: 'current-card', status: 'pending' }; cards.push(card); return card;
      } } } };
    const [fresh] = await syncGraphDecision(args);
    assert.equal(fresh.interactionId, 'current-card');
    assert.deepEqual(await syncGraphDecision(args), [fresh]);
    assert.equal(cards.length, 2);
    assert.deepEqual(await engine.getRun(runId), current);
    assert.deepEqual(await engine.listDecisions({ runId }), before);
  });
}
