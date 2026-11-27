import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import { createHash } from 'node:crypto';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { syncConfirmationGate } from '../../src/plugin/confirmation-gate.mjs';
import { adapterBundleDigest, mergeProducers, trustedPackAdapters } from '../../src/plugin/trusted-pack-adapters.mjs';
import { pack as adlcPack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';

test('agent cannot omit Graph run ID for a dispatched child issue', async () => {
  let state;
  const childIssueId = 'graph-child';
  const host = {
    manifest,
    logger: { warn() {} },
    db: {
      namespace: 'plugin_test',
      async query(sql, args = []) {
        if (sql.includes('graph_dispatch')) return args[1] === childIssueId
          ? [{ graph_run_id: 'graph-run', node_id: 'make', issue_id: childIssueId,
            agent_id: 'maker', agent_run_id: 'paperclip-run', state: 'woken' }] : [];
        if (sql.includes('graph_state')) return state
          ? [{ revision: state.revision, document: structuredClone(state) }] : [];
        return [];
      },
      async execute(sql, args) {
        if (!sql.includes('graph_state')) throw new Error(`Unexpected write: ${sql}`);
        if (sql.includes('INSERT') && !state || sql.includes('UPDATE') && state?.revision === args[3]) {
          state = JSON.parse(args[2]);
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    issues: {
      get: async (id) => ({ id }),
      assertCheckoutOwner: async () => ({ checkoutRunId: 'paperclip-run', assigneeAgentId: 'maker' }),
    },
    access: { members: { list: async () => [] } },
    events: { on() {} },
    jobs: { register() {} },
    actions: { register() {} },
    tools: { register() {} },
  };
  await plugin.definition.setup(host);
  const result = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
    params: { issueId: childIssueId }, actor: { actorType: 'agent', agentId: 'maker', runId: 'paperclip-run' },
    body: { operation: 'product-decision', status: 'proposed', feature: 'calculator',
      outcome: 'Change behavior', reason: 'Requested', changeScope: ['/api'] } });
  assert.match(result.body.error, /Graph runId is required for a dispatched child issue/);
  assert.equal(state.decisions.length, 0);

  const standalone = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
    params: { issueId: 'standalone' }, actor: { actorType: 'agent', agentId: 'maker', runId: 'paperclip-run' },
    body: { operation: 'product-decision', status: 'proposed', feature: 'calculator',
      outcome: 'Change behavior', reason: 'Requested', changeScope: ['/api'] } });
  assert.equal(standalone.body.result.status, 'proposed', JSON.stringify(standalone));
  assert.equal(standalone.body.result.issueId, 'standalone');
});

async function decisionWorker(state, issues, ownerId = 'project-owner') {
  await plugin.definition.setup({
    manifest, logger: { warn() {} },
    config: { get: async () => ({ adlcProjects: { project: { ownerId } } }) },
    db: {
      namespace: 'plugin_test',
      async query(sql) {
        if (sql.includes('graph_state')) return [{ revision: state.revision, document: structuredClone(state) }];
        if (sql.includes('SELECT pack_id,pack_version,pack_digest')) return [{ ...trustedPackAdapters[0], adapterBundleDigest }];
        return [];
      },
      async execute(sql, args) {
        if (sql.includes('UPDATE') && state.revision === args[3]) {
          Object.assign(state, JSON.parse(args[2]));
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    issues: { get: async id => ({ id }), ...issues },
    agents: { list: async () => [] },
    access: { members: { list: async () => ['other-admin', 'project-owner'].map(principalId => ({
      principalType: 'user', principalId, status: 'active', membershipRole: principalId === 'other-admin' ? 'admin' : 'member',
    })) } },
    events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} },
  });
  return async (runId) => {
    const { body } = await plugin.definition.onApiRequest({ routeKey: 'graph-read', companyId: 'company',
      params: { issueId: 'issue' }, query: { runId }, actor: { actorType: 'user', userId: 'project-owner' } });
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.nativeDecisionError, null, JSON.stringify(body.nativeDecisionError));
    return body.nativeDecisions;
  };
}

const board = { id: 'other-admin', kind: 'human', roles: ['human-owner'] };
const runInput = { projectId: 'project', paperclipIssueId: 'issue' };

async function runBoundProposal(organization) {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'fixture', version: '1', graphs: [{
    id: 'work', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
  }], decisionRules: [{ type: 'product-decision-replacement', mode: 'manual',
    allowedKinds: ['human'], requiresHuman: true, requiredEvidence: ['superseded_decision_id'] }] });
  const run = await engine.startRun({ packId: 'fixture', packVersion: '1', graphId: 'work', input: { ...runInput, feature: 'calculator' }, actor: board, mode: 'manual' });
  const baseline = await engine.recordProductDecision({ feature: 'calculator', actor: board,
    outcome: 'Subtract numbers', reason: 'Baseline' });
  const proposal = await engine.recordProductDecision({ supersedes: baseline.id, changeScope: ['/api'], runId: run.id, nodeId: 'make', issueId: 'issue',
    feature: 'calculator', status: 'proposed', outcome: 'Add numbers', reason: 'Requested',
    evidence: [{ kind: 'superseded_decision_id', id: baseline.id }],
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'agent-run' } });
  const state = await engine.store.read();
  state.control = { organization };
  const cards = [];
  const issues = {
    listInteractions: async () => cards,
    askUserQuestions: async (_issue, request) => {
      const card = { ...request, id: 'product-card-' + cards.length, status: 'pending' };
      cards.push(card);
      return card;
    },
  };
  return { proposal, state, cards, issues };
}

test('worker approves a run-bound product card only for the project owner', async () => {
  const { proposal, state, cards, issues } = await runBoundProposal({ board });
  const read = await decisionWorker(state, issues);
  await read();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].addresseeUserId, 'project-owner');
  Object.assign(cards[0], { status: 'resolved', resolvedByUserId: board.id, result: { answers: [
    { questionId: 'choice', optionIds: ['approve'] }, { questionId: 'reason', text: 'Reviewed' },
  ] } });
  const [denied] = await read();
  assert.match(denied.syncError, /human-owner/);
  assert.equal(state.decisions.some(decision => decision.proposalId === proposal.id), false);
  cards[0].resolvedByUserId = 'project-owner';
  await read();
  const approval = state.decisions.find(decision => decision.proposalId === proposal.id);
  assert.equal(approval?.status, 'approved');
  assert.equal(approval.actor.id, 'project-owner');
});

test('worker sends a run-bound product card to the project owner without a board or sole company owner', async () => {
  const { proposal, state, cards, issues } = await runBoundProposal(null);
  const read = await decisionWorker(state, issues);
  await read();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].addresseeUserId, 'project-owner');
  Object.assign(cards[0], { status: 'resolved', resolvedByUserId: 'project-owner', result: { answers: [
    { questionId: 'choice', optionIds: ['approve'] }, { questionId: 'reason', text: 'Reviewed' },
  ] } });
  await read();
  assert.equal(state.decisions.find(decision => decision.proposalId === proposal.id)?.status, 'approved');
});

test('worker does not reuse a product card addressed to a previous project owner', async () => {
  const { state, cards, issues } = await runBoundProposal({ board });
  await (await decisionWorker(state, issues, 'former-owner'))();
  assert.deepEqual(cards.map(card => card.addresseeUserId), ['former-owner']);
  await (await decisionWorker(state, issues, 'project-owner'))();
  assert.deepEqual(cards.map(card => card.addresseeUserId), ['former-owner', 'project-owner']);
  assert.notEqual(cards[0].idempotencyKey, cards[1].idempotencyKey);
});

for (const escalated of [false, true]) {
  test(`G2 confirmation freezes the project owner's approved document (escalated: ${escalated})`, async () => {
    await confirmG2(escalated);
  });
}

for (const [label, editBody, accepted] of [
  ['matching document identity', (id, version) => ({ id, version }), true],
  ['mismatched document ID', () => ({ id: 'different-id' }), false],
  ['mismatched document version', () => ({ version: 'different-version' }), false],
  ['changed manifest field', () => ({ assumptions: ['Different assumption'] }), false],
]) {
  test(`non-escalated G2 confirmation checks ${label}`, async () => {
    await confirmG2(false, editBody, accepted);
  });
}

async function confirmG2(escalated, editBody, accepted = true) {
  const graph = adlcPack.graphs.find(item => item.id === 'requirements-baseline' && item.version === '0.1.2');
  const completed = new Set(['classify-scope', 'scope-route', 'draft-requirements', 'challenge-requirements', 'prepare-g2']);
  const deliverables = ['prd', 'acceptance.feature'].map(key => ({ key, revisionId: 'rev-' + key, digest: 'a'.repeat(64) }));
  const manifestPayload = { egmReportRef: 'egm', assumptions: [], supersedes: null, unresolvedEscalations: [], deliverables };
  const harness = createTestHarness({ manifest, capabilities: ['issue.documents.read', 'issue.documents.write'] });
  harness.seed({ issues: [{ id: runInput.paperclipIssueId, companyId: 'company' }] });
  const key = 'approval-manifest';
  const documents = harness.ctx.issues.documents;
  const rawBody = JSON.stringify(manifestPayload);
  const document = await documents.upsert({ companyId: 'company', issueId: runInput.paperclipIssueId, key, body: rawBody });
  const body = editBody ? JSON.stringify({ ...manifestPayload, ...editBody(document.id, document.latestRevisionId) }) : rawBody;
  const payloads = {
    'prepare-g2': ['approval_manifest', { ...manifestPayload, id: document.id, version: document.latestRevisionId }],
    'challenge-requirements': ['egm_report', { id: 'egm', version: 'one', scope: 'small', complianceRelevant: false,
      rounds: [{ reviewers: { 'naive-reader': 'ran', 'bdd-testability': 'ran' }, findings: [] }], deliverables }],
  };
  const run = { id: 'g2-run', packId: adlcPack.id, packVersion: adlcPack.version, pack: adlcPack,
    graph, mode: 'manual', status: escalated ? 'paused' : 'running', conflicts: [],
    input: { ...runInput, requirements_draft: 'draft', readiness_report: 'reviewed' },
    ...(escalated ? { pendingHuman: { kind: 'decision', nodeId: 'requirements-gate', escalationDecisionId: 'waiting' } } : {}),
    nodeStates: Object.fromEntries(graph.nodes.map(({ id }) => {
      const [kind, payload] = payloads[id] ?? [];
      return [id, {
        status: completed.has(id) ? 'completed' : 'pending', outcome: id === 'scope-route' ? 'small' : undefined,
        attempts: payload ? [{ artifacts: [{ id: payload.id, version: payload.version, kind }],
          output: { adlcProductMethods: { [kind]: payload } } }] : [],
        artifacts: payload ? [{ id: payload.id, version: payload.version, kind }] : [],
      }];
    })) };
  const state = { revision: 1, runs: { [run.id]: run }, decisions: [], packs: {}, audit: [], idempotency: {} };
  const cards = [];
  const issues = {
    // Supply the body variant at the test host boundary while keeping the generated revision.
    documents: editBody ? { get: async (...args) => ({ ...await documents.get(...args), body }) } : documents,
    listInteractions: async () => cards,
    requestConfirmation: async (_issue, request) => {
      const card = { ...request, id: 'confirmation', kind: 'request_confirmation', status: 'pending' };
      cards.push(card);
      return card;
    },
  };
  let read, getState;
  if (escalated) {
    read = await decisionWorker(state, issues);
    getState = async () => state;
  } else {
    const store = new MemoryStore();
    await store.write(state, 0);
    const engine = new GraphEngine({ store, mergeProducers, candidatePayload: trustedPackAdapters[0].candidatePayload });
    getState = () => store.read();
    const node = graph.nodes.find(item => item.id === 'requirements-gate');
    read = async () => [await syncConfirmationGate({
      host: { issues }, companyId: 'company', run: await engine.getRun(run.id), node, engine,
      confirmation: { ownerId: 'project-owner', requireManifestCandidate: true },
      trustedActor: async (_companyId, { userId }) => ({ actor: { ...board, id: userId } }),
    })];
  }
  await read(run.id);
  assert.equal(cards[0]?.addresseeUserId, 'project-owner');
  Object.assign(cards[0], { status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: board.id });
  assert.equal((await read(run.id))[0].status, 'unauthorized');
  assert.equal((await getState()).decisions.length, 0);
  cards[0].resolvedByUserId = 'project-owner';
  if (!accepted) {
    await assert.rejects(read(run.id), /Confirmation document body does not match the approved candidate payload/);
    const saved = await getState();
    assert.equal(saved.decisions.length, 0);
    assert.equal(saved.runs[run.id].nodeStates['requirements-gate'].status, 'pending');
    return;
  }
  assert.equal((await read(run.id))[0].consumed, true);
  const saved = await getState();
  const [decision] = saved.decisions;
  assert.equal(saved.runs[run.id].nodeStates['requirements-gate'].outcome, 'accept');
  assert.equal(decision.actor.id, 'project-owner');
  assert.equal(decision.supersedes, escalated ? 'waiting' : null);
  assert.deepEqual(decision.candidateBinding.document, {
    issueId: runInput.paperclipIssueId, key, documentId: document.id, revisionId: document.latestRevisionId,
    bodyDigest: createHash('sha256').update(body).digest('hex'),
  });
}

for (const { ownerId, boardId, expected } of [
  { ownerId: 'project-owner', boardId: 'other-admin', expected: 'project-owner' },
  { ownerId: 'project-owner', boardId: null, expected: 'project-owner' },
  { ownerId: null, boardId: 'other-admin', expected: 'other-admin' },
]) {
  test(`worker addresses an escalated Graph card to ${expected} with board ${boardId} and owner ${ownerId}`, async () => {
    const engine = new GraphEngine();
    await engine.registerPack({ id: 'fixture', version: '1', graphs: [{
      id: 'work', version: '1', start: 'gate', nodes: [
        { id: 'gate', type: 'decision', decisionType: 'approval' }, { id: 'end', type: 'end' },
      ], edges: [{ from: 'gate', to: 'end', when: 'accept' }],
    }], decisionRules: [{ type: 'approval', mode: 'manual', allowedKinds: ['human'],
      allowedRoles: ['human-owner'], requiresHuman: true }] });
    const run = await engine.startRun({ packId: 'fixture', packVersion: '1', graphId: 'work',
      mode: 'manual', input: runInput, actor: board });
    const state = await engine.store.read();
    state.control = { organization: boardId ? { board: { ...board, id: boardId } } : null };
    Object.assign(state.runs[run.id], { status: 'paused',
      pendingHuman: { kind: 'decision', nodeId: 'gate', escalationDecisionId: 'waiting' } });
    const cards = [];
    const read = await decisionWorker(state, {
      listInteractions: async () => cards,
      askUserQuestions: async (_issue, request) => {
        const card = { ...request, id: 'gate-card', status: 'pending' };
        cards.push(card);
        return card;
      },
    }, ownerId);
    assert.equal((await read(run.id)).length, 1);
    assert.equal(cards[0]?.addresseeUserId, expected);
    if (!ownerId) return;
    // A new project owner gets a new card instead of the one addressed to the previous owner.
    const reread = await decisionWorker(state, {
      listInteractions: async () => cards,
      askUserQuestions: async (_issue, request) => {
        const card = { ...request, id: 'gate-card-' + cards.length, status: 'pending' };
        cards.push(card);
        return card;
      },
    }, 'new-owner');
    await reread(run.id);
    assert.deepEqual(cards.map(card => card.addresseeUserId), [expected, 'new-owner']);
  });
}
