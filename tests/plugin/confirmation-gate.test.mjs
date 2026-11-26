import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { confirmationGateConfig, syncConfirmationGate } from '../../src/plugin/confirmation-gate.mjs';

test('requests the current manifest revision and consumes only the configured owner response', async () => {
  const node = { id: 'requirements-gate', type: 'decision', role: 'cpo', candidateNodes: ['prepare-g2'], candidateKinds: ['approval_manifest'], decisionType: 'requirements-acceptance' };
  const run = { id: 'run', status: 'running', mode: 'manual', input: { projectId: 'project', paperclipIssueId: 'issue' },
    graph: { id: 'requirements-baseline', version: '0.1.2', nodes: [node], edges: [
      { from: node.id, to: 'yes', when: 'accept' },
      { from: node.id, to: 'hold', when: 'hold' },
    ] }, pack: { decisionRules: [] }, nodeStates: { "prepare-g2": { status: "completed", artifacts: [] } } };
  const cards = [], applied = new Map();
  let revision = 'one';
  const host = { config: { get: async () => ({ adlcProjects: { project: { ownerId: 'owner' } } }) },
    issues: {
      documents: { get: async () => ({ id: 'manifest', latestRevisionId: revision }) },
      listInteractions: async () => cards,
      requestConfirmation: async (_issue, input) => {
        assert.equal(input.resolverPolicy, 'human_only');
        assert.equal(input.payload.target.revisionId, revision);
        const card = { ...input, id: revision, kind: 'request_confirmation', status: 'pending' };
        cards.push(card);
        return card;
      },
    } };
  const confirmation = await confirmationGateConfig(host, 'company', run, node);
  const engine = { decideNode: async args => applied.set(args.idempotencyKey, args) };
  const sync = () => syncConfirmationGate({ host, companyId: 'company', run, node, engine, confirmation,
    trustedActor: async (_company, { userId }) => ({ actor: { kind: 'human', id: userId, roles: ['human-owner'] } }) });
  const accept = (card, resolvedByUserId) => Object.assign(card, { status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId });
  assert.equal((await sync()).status, 'waiting_manifest_candidate');
  assert.equal(cards.length, 0);
  const candidate = () => ({ kind: 'approval_manifest', id: 'manifest', version: revision });
  run.nodeStates['prepare-g2'].artifacts.push(candidate());
  await sync();
  accept(cards[0], 'owner');
  revision = 'two';
  run.nodeStates['prepare-g2'].artifacts.push(candidate());
  await sync();
  assert.equal(applied.size, 0);
  accept(cards[1], 'other');
  assert.equal((await sync()).status, 'unauthorized');
  accept(cards[1], 'owner');
  cards[1].revokedAt = 'earlier';
  await sync();
  assert.equal(applied.size, 0);
  delete cards[1].revokedAt;
  assert.equal((await sync()).consumed, true);
  await sync();
  assert.equal(applied.size, 1);
  assert.deepEqual(applied.get('confirmation:two').evidence[0].subjectRefs, [{ artifactId: 'manifest', version: 'two' }, { artifactId: 'manifest', version: 'two' }]);
});

test('the owner-only actor can complete the CPO G2 gate through confirmation', async () => {
  const node = {
    id: 'requirements-gate', type: 'decision', role: 'cpo', decisionType: 'requirements-acceptance',
    outcomes: ['accept', 'rework', 'hold'], requiredInputs: ['approval_manifest', 'requirements_draft', 'readiness_report'],
    candidateNodes: ['prepare-g2'], candidateKinds: ['approval_manifest'],
    reworkTarget: 'draft-requirements', reworkOutcome: 'rework', maxReworks: 3,
  };
  const artifact = { id: 'manifest', version: 'one', kind: 'approval_manifest' };
  const run = {
    id: 'run', packId: 'adlc', status: 'running', mode: 'manual', conflicts: [],
    input: { projectId: 'project', paperclipIssueId: 'issue', requirements_draft: 'draft', readiness_report: 'report' },
    graph: { id: 'requirements-baseline', version: '0.1.2', start: 'prepare-g2',
      nodes: [{ id: 'prepare-g2', type: 'task' }, node, { id: 'publish-baseline', type: 'task' },
        { id: 'requirements-held', type: 'end' }],
      edges: [{ from: 'prepare-g2', to: node.id }, { from: node.id, to: 'publish-baseline', when: 'accept' },
        { from: node.id, to: 'requirements-held', when: 'hold' }],
    },
    pack: { decisionRules: [{ type: node.decisionType, mode: 'manual', requiresHuman: true,
      allowedRoles: ['human-owner'], allowedKinds: ['human'],
      requiredEvidence: ['requirements_draft', 'readiness_report', 'accepted_intent'] }] },
    nodeStates: { 'prepare-g2': { status: 'completed', artifacts: [artifact], attempts: [] },
      [node.id]: { status: 'pending', attempts: [] }, 'publish-baseline': { status: 'pending', attempts: [] },
      'requirements-held': { status: 'pending', attempts: [] } },
  };
  const store = new MemoryStore();
  await store.write({ revision: 1, packs: {}, runs: { run }, audit: [], idempotency: {}, decisions: [] }, 0);
  const engine = new GraphEngine({ store });
  const host = { issues: {
    documents: { get: async () => ({ id: artifact.id, latestRevisionId: artifact.version }) },
    listInteractions: async () => [],
    requestConfirmation: async (_issueId, request) => ({ ...request, id: 'card', kind: 'request_confirmation',
      status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: 'owner' }),
  } };
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  await assert.rejects(engine.decideNode({ runId: run.id, nodeId: node.id, actor: owner,
    outcome: 'accept', reason: 'reviewed' }), /required role/);
  const result = await syncConfirmationGate({ host, companyId: 'company', run: await engine.getRun(run.id), node, engine,
    trustedActor: async () => ({ actor: owner }), confirmation: { ownerId: 'owner', requireManifestCandidate: true } });
  assert.equal(result.consumed, true);
  const [decision] = await engine.listDecisions({ runId: run.id });
  assert.deepEqual(decision.actor.roles, ['human-owner']);
  assert.equal(decision.outcome, 'accept');
});
