import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';
import { syncProductDecisionCards } from '../../src/plugin/product-decisions.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const agent = { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'execution' };

test('agent proposal creates one Board card, whose answer records the product decision', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'adlc', version: '1', graphs: [{ id: 'work', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker', requiredInputs: ['product_decision_refs'] }], edges: [] }],
  decisionRules: [{ type: 'product-decision-replacement', mode: 'assisted', allowedKinds: ['human'],
    requiresHuman: true, requiredEvidence: ['superseded_decision_id'] }] });
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'work', mode: 'assisted',
    actor: owner, input: { feature: 'calculator', product_decision_refs: [old.id], paperclipIssueId: 'issue-1' } });
  const proposal = await engine.recordProductDecision({ runId: run.id, nodeId: 'make', feature: 'calculator', actor: agent,
    status: 'proposed', outcome: 'Subtract returns a+b', reason: 'User requested addition',
    supersedes: old.id, changeScope: ['/api/subtract semantics'],
    evidence: [{ kind: 'superseded_decision_id', id: old.id }] });
  const cards = [];
  const host = { manifest: { id: 'pohlee.polyforge-graph' }, issues: {
    listInteractions: async () => cards,
    askUserQuestions: async (issueId, payload) => {
      assert.equal(issueId, 'issue-1');
      assert.equal(payload.addresseeUserId, 'owner');
      assert.equal(payload.resolverPolicy, 'human_only');
      const card = { id: 'card-1', status: 'pending', idempotencyKey: payload.idempotencyKey };
      cards.push(card);
      return card;
    },
  } };
  const args = { host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => ({ actor: owner }) };
  const first = await syncProductDecisionCards(args);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'pending');
  assert.equal(cards.length, 1);
  await syncProductDecisionCards(args);
  assert.equal(cards.length, 1);
  assert.equal((await engine.getProductMemory('calculator')).active[0].id, old.id);
  cards[0].status = 'resolved';
  cards[0].resolvedByUserId = 'owner';
  cards[0].result = { answers: [
    { questionId: 'choice', optionIds: ['approve'] },
    { questionId: 'reason', otherText: 'Board approves this exact change' },
  ] };
  const resolved = await syncProductDecisionCards(args);
  assert.equal(resolved[0].status, 'resolved');
  assert.equal(resolved[0].syncError, null);
  const decision = (await engine.listDecisions({ feature: 'calculator' }))
    .find((item) => item.proposalId === proposal.id);
  assert.equal(decision.status, 'approved');
  assert.equal(decision.evidence.find((item) => item.kind === 'paperclip_decision').interactionId, 'card-1');
  assert.equal((await engine.getRun(run.id)).status, 'running');
  await syncProductDecisionCards(args);
  assert.equal(cards.length, 1);
  assert.equal((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id).length, 1);
});

test('standalone agent proposal cannot be approved by a resolver without human-owner authority', async () => {
  const engine = new GraphEngine();
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  const proposal = await engine.recordProductDecision({ feature: 'calculator', actor: agent,
    issueId: 'issue-2', status: 'proposed', outcome: 'Subtract returns a+b',
    reason: 'User requested addition', supersedes: old.id, changeScope: ['/api/subtract semantics'] });
  const host = { manifest: { id: 'pohlee.polyforge-graph' }, issues: {
    listInteractions: async () => [],
    askUserQuestions: async (_issue, payload) => ({ id: 'card-2', status: 'resolved',
      idempotencyKey: payload.idempotencyKey, resolvedByUserId: 'other-user',
      result: { answers: [{ questionId: 'choice', optionIds: ['approve'] },
        { questionId: 'reason', otherText: 'I approve' }] } }),
  } };
  const cards = await syncProductDecisionCards({ host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => ({ actor: { id: 'other-user', kind: 'human', roles: [] } }) });
  assert.match(cards[0].syncError, /human-owner/);
  assert.equal(cards[0].proposalId, proposal.id);
  assert.deepEqual((await engine.getProductMemory('calculator')).active.map((item) => item.id), [old.id]);
});

test('a company without plugin organization setup routes its product card to its native owner', async () => {
  const engine = new GraphEngine();
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  await engine.recordProductDecision({ feature: 'calculator', actor: agent,
    issueId: 'issue-4', status: 'proposed', outcome: 'Subtract returns a+b',
    reason: 'Changed behavior requested', supersedes: old.id,
    changeScope: ['/api/subtract semantics'] });
  let addressee;
  const host = { access: { members: { list: async () => [{ principalType: 'user',
    principalId: 'owner', membershipRole: 'owner', status: 'active' }] } },
  issues: { listInteractions: async () => [], askUserQuestions: async (_issue, card) => {
    addressee = card.addresseeUserId;
    return { id: 'card-4', status: 'pending' };
  } } };
  const cards = await syncProductDecisionCards({ host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: null }) },
    config: {}, trustedActor: async () => ({ actor: owner }) });
  assert.equal(addressee, 'owner');
  assert.equal(cards[0].status, 'pending');
});

test('stale proposals are invalidated without creating an actionable approval card', async () => {
  const engine = new GraphEngine();
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  await engine.recordProductDecision({ feature: 'calculator', actor: agent, issueId: 'issue-3',
    status: 'proposed', outcome: 'Subtract returns a+b', reason: 'Old request',
    supersedes: old.id, changeScope: ['/api/subtract semantics'] });
  await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b and add accepts arrays', reason: 'Later approved change',
    supersedes: old.id, changeScope: ['/api/add input contract'] });
  let created = 0;
  const cards = await syncProductDecisionCards({ host: { issues: {
    listInteractions: async () => [], askUserQuestions: async () => { created++; },
  } }, companyId: 'company-1', engine,
  control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
  config: {}, trustedActor: async () => ({ actor: owner }) });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'stale');
  assert.equal(created, 0);
  assert.equal((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.status === 'invalidated').length, 1);
});

test('a proposal stale after its card is answered cannot approve and stops its paused run', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'adlc', version: '1', graphs: [{ id: 'work', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker', requiredInputs: ['product_decision_refs'] }], edges: [] }],
  decisionRules: [{ type: 'product-decision-replacement', mode: 'assisted', allowedKinds: ['human'],
    requiresHuman: true, requiredEvidence: ['superseded_decision_id'] }] });
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'work', mode: 'assisted',
    actor: owner, input: { feature: 'calculator', product_decision_refs: [old.id], paperclipIssueId: 'issue-5' } });
  const proposal = await engine.recordProductDecision({ runId: run.id, nodeId: 'make', feature: 'calculator',
    actor: agent, status: 'proposed', outcome: 'Subtract returns a+b', reason: 'Changed request',
    supersedes: old.id, changeScope: ['/api/subtract semantics'],
    evidence: [{ kind: 'superseded_decision_id', id: old.id }] });
  const cards = [];
  const host = { issues: {
    listInteractions: async () => cards,
    askUserQuestions: async (_issue, payload) => {
      const card = { id: 'card-5', status: 'pending', idempotencyKey: payload.idempotencyKey };
      cards.push(card);
      return card;
    },
  } };
  const args = { host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => ({ actor: owner }) };
  await syncProductDecisionCards(args);
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract now has a third accepted behavior', reason: 'Separate later decision',
    supersedes: old.id, changeScope: ['/api/subtract semantics'] });
  cards[0].status = 'resolved';
  cards[0].resolvedByUserId = 'owner';
  cards[0].result = { answers: [
    { questionId: 'choice', optionIds: ['approve'] },
    { questionId: 'reason', otherText: 'Late approval' },
  ] };
  const synced = await syncProductDecisionCards(args);
  assert.equal(synced[0].status, 'stale');
  assert.match(synced[0].warning, /cannot approve/);
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  const decisions = (await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id);
  assert.deepEqual(decisions.map((item) => item.status), ['invalidated']);
  assert.equal((await engine.getProductMemory('calculator')).active[0].outcome,
    'Subtract now has a third accepted behavior');
  await syncProductDecisionCards(args);
  assert.equal((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id).length, 1);
});

test('deferral leaves proposal open and creates one successor card before a final answer', async () => {
  const engine = new GraphEngine();
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  const proposal = await engine.recordProductDecision({ feature: 'calculator', actor: agent,
    issueId: 'issue-6', status: 'proposed', outcome: 'Subtract returns a+b',
    reason: 'Changed request', supersedes: old.id, changeScope: ['/api/subtract semantics'] });
  const cards = [];
  const host = { issues: {
    listInteractions: async () => cards,
    askUserQuestions: async (_issue, payload) => {
      const card = { id: `card-${cards.length + 1}`, status: 'pending',
        idempotencyKey: payload.idempotencyKey };
      cards.push(card);
      return card;
    },
  } };
  const args = { host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => ({ actor: owner }) };
  await syncProductDecisionCards(args);
  cards[0].status = 'resolved';
  cards[0].resolvedByUserId = 'owner';
  cards[0].result = { answers: [
    { questionId: 'choice', optionIds: ['defer'] },
    { questionId: 'reason', otherText: 'Need more information' },
  ] };
  await syncProductDecisionCards(args);
  assert.equal(cards.length, 2);
  assert.equal(cards[1].idempotencyKey, `polyforge-product-decision:${proposal.id}:1`);
  await syncProductDecisionCards(args);
  assert.equal(cards.length, 2);
  assert.deepEqual((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id).map((item) => item.status), ['deferred']);
  cards[1].status = 'resolved';
  cards[1].resolvedByUserId = 'owner';
  cards[1].result = { answers: [
    { questionId: 'choice', optionIds: ['reject'] },
    { questionId: 'reason', otherText: 'Keep subtraction' },
  ] };
  await syncProductDecisionCards(args);
  assert.deepEqual((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id).map((item) => item.status),
    ['deferred', 'rejected']);
  assert.equal(cards.length, 2);
});

test('a baseline superseded while reconciling an answer is invalidated in the same pass', async () => {
  const engine = new GraphEngine();
  const old = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted brief' });
  const proposal = await engine.recordProductDecision({ feature: 'calculator', actor: agent,
    issueId: 'issue-7', status: 'proposed', outcome: 'Subtract returns a+b',
    reason: 'Changed request', supersedes: old.id, changeScope: ['/api/subtract semantics'] });
  const host = { issues: {
    listInteractions: async () => [],
    askUserQuestions: async (_issue, payload) => ({ id: 'card-7', status: 'resolved',
      idempotencyKey: payload.idempotencyKey, resolvedByUserId: 'owner',
      result: { answers: [
        { questionId: 'choice', optionIds: ['approve'] },
        { questionId: 'reason', otherText: 'Approve changed behavior' },
      ] } }),
  } };
  const cards = await syncProductDecisionCards({ host, companyId: 'company-1', engine,
    control: { getSetup: async () => ({ organization: { board: { id: 'owner' } } }) },
    config: {}, trustedActor: async () => {
      await engine.recordProductDecision({ feature: 'calculator', actor: owner,
        outcome: 'Separate accepted behavior', reason: 'Superseded during reconciliation',
        supersedes: old.id, changeScope: ['/api/subtract semantics'] });
      return { actor: owner };
    } });
  assert.equal(cards[0].status, 'stale');
  assert.equal(cards[0].syncError, null);
  assert.deepEqual((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id).map((item) => item.status), ['invalidated']);
});
