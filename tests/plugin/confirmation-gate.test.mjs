import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
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


const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };

async function gateFixture(graphId, version, nodeId, completed, candidates, input = {}) {
  const graph = pack.graphs.find(item => item.id === graphId && item.version === version);
  const node = graph.nodes.find(item => item.id === nodeId);
  const run = {
    id: 'run', packId: pack.id, status: 'running', mode: 'manual', conflicts: [], pack, graph,
    input: { projectId: 'project', paperclipIssueId: 'issue', ...input },
    nodeStates: Object.fromEntries(graph.nodes.map(({ id }) => [id, {
      status: Object.hasOwn(completed, id) ? 'completed' : 'pending',
      outcome: completed[id], attempts: [], artifacts: candidates[id] ?? [],
    }])),
  };
  const store = new MemoryStore();
  await store.write({ revision: 1, packs: {}, runs: { run }, audit: [], idempotency: {}, decisions: [] }, 0);
  return { engine: new GraphEngine({ store }), node, run, store };
}

function g2Fixture() {
  return gateFixture('requirements-baseline', '0.1.2', 'requirements-gate', {
    'classify-scope': null, 'scope-route': 'small', 'draft-requirements': null,
    'challenge-requirements': null, 'prepare-g2': null,
  }, { 'prepare-g2': [{ id: 'manifest', version: 'one', kind: 'approval_manifest' }] },
  { requirements_draft: 'draft', readiness_report: 'report' });
}

function evidenceFor(run, node, refs) {
  return run.pack.decisionRules.find(rule => rule.type === node.decisionType && rule.mode === run.mode)
    .requiredEvidence.map(kind => ({ kind, summary: 'Reviewed', subjectRefs: refs }));
}

test('owner-only G2 decision works directly and through confirmation', async () => {
  const { engine, node, run } = await g2Fixture();
  const refs = [{ artifactId: 'manifest', version: 'one' }];
  const args = { runId: run.id, nodeId: node.id, actor: owner, outcome: 'accept', reason: 'Reviewed' };
  assert.equal((await engine.decideNode({ ...args, evidence: evidenceFor(run, node, refs) })).decision.outcome, 'accept');

  const fixture = await g2Fixture();
  const host = { issues: {
    documents: { get: async () => ({ id: 'manifest', latestRevisionId: 'one' }) },
    listInteractions: async () => [],
    requestConfirmation: async (_issueId, request) => ({ ...request, id: 'card', kind: 'request_confirmation',
      status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: 'owner' }),
  } };
  const confirm = () => syncConfirmationGate({ host, companyId: 'company', run: fixture.run, node,
    engine: fixture.engine, trustedActor: async () => ({ actor: owner }),
    confirmation: { ownerId: 'owner', requireManifestCandidate: true } });
  assert.equal((await confirm()).consumed, true);
  assert.equal((await fixture.engine.listDecisions({ runId: run.id }))[0].outcome, 'accept');

  const stale = await g2Fixture();
  const state = await stale.store.read();
  state.runs.run.nodeStates['prepare-g2'].artifacts.push({ id: 'manifest', version: 'two', kind: 'approval_manifest' });
  await stale.store.write({ ...state, revision: state.revision + 1 }, state.revision);
  await assert.rejects(syncConfirmationGate({ host, companyId: 'company', run: stale.run, node,
    engine: stale.engine, trustedActor: async () => ({ actor: owner }),
    confirmation: { ownerId: 'owner', requireManifestCandidate: true } }), /Run changed since validation/);
});

test('owner-only actor can decide the manual G5 gate', async () => {
  const { engine, node, run } = await gateFixture('verification', '0.1.8', 'g5', {
    modernize: null, 'modernize-route': 'MODERNIZE', 'review-head': null, 'review-route': 'pass',
    'verify-head': null, 'acceptance-gate': 'accept', 'prepare-g5': null,
  }, { 'verify-head': [{ id: 'qa', version: '1', kind: 'verification_manifest' }],
    'prepare-g5': [{ id: 'head', version: '1', kind: 'merge_pr_head' }] }, { merge_context: 'ready' });
  const evidence = evidenceFor(run, node, [{ artifactId: 'qa', version: '1' }, { artifactId: 'head', version: '1' }]);
  const result = await engine.decideNode({ runId: run.id, nodeId: node.id, actor: owner,
    outcome: 'accept', reason: 'Reviewed', evidence });
  assert.equal(result.decision.outcome, 'accept');
});
