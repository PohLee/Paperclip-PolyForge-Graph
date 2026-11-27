import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { GraphEngine } from '../../src/core/index.mjs';
import { adapterBundleDigest, trustedPackAdapters } from '../../src/plugin/trusted-pack-adapters.mjs';
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

test('worker approves a run-bound product card only for the project owner', async () => {
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
  state.control = { organization: { board } };
  const cards = [];
  const read = await decisionWorker(state, {
    listInteractions: async () => cards,
    askUserQuestions: async (_issue, request) => {
      const card = { ...request, id: 'product-card', status: 'pending' };
      cards.push(card);
      return card;
    },
  });
  await read();
  assert.equal(cards.length, 1);
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

test('worker consumes G2 confirmation for a project owner with ordinary membership', async () => {
  const graph = adlcPack.graphs.find(item => item.id === 'requirements-baseline' && item.version === '0.1.2');
  const completed = new Set(['classify-scope', 'scope-route', 'draft-requirements', 'challenge-requirements', 'prepare-g2']);
  const deliverables = ['prd', 'acceptance.feature'].map(key => ({ key, revisionId: 'rev-' + key, digest: 'a'.repeat(64) }));
  const payloads = {
    'prepare-g2': ['approval_manifest', { id: 'manifest', version: 'one', egmReportRef: 'egm',
      assumptions: [], supersedes: null, unresolvedEscalations: [], deliverables }],
    'challenge-requirements': ['egm_report', { id: 'egm', version: 'one', scope: 'small', complianceRelevant: false,
      rounds: [{ reviewers: { 'naive-reader': 'ran', 'bdd-testability': 'ran' }, findings: [] }], deliverables }],
  };
  const run = { id: 'g2-run', packId: adlcPack.id, packVersion: adlcPack.version, pack: adlcPack,
    graph, mode: 'manual', status: 'paused', input: runInput, conflicts: [],
    pendingHuman: { kind: 'decision', nodeId: 'requirements-gate', escalationDecisionId: 'waiting' },
    nodeStates: Object.fromEntries(graph.nodes.map(({ id }) => {
      const [kind, payload] = payloads[id] ?? [];
      return [id, {
        status: completed.has(id) ? 'completed' : 'pending', outcome: id === 'scope-route' ? 'small' : undefined,
        attempts: payload ? [{ output: { adlcProductMethods: { [kind]: payload } } }] : [],
        artifacts: payload ? [{ id: payload.id, version: payload.version, kind }] : [],
      }];
    })) };
  const state = { revision: 1, runs: { [run.id]: run }, decisions: [], packs: {}, audit: [], idempotency: {} };
  const cards = [];
  const read = await decisionWorker(state, {
    documents: { get: async () => ({ id: 'manifest', latestRevisionId: 'one' }) },
    listInteractions: async () => cards,
    requestConfirmation: async (_issue, request) => {
      const card = { ...request, id: 'confirmation', kind: 'request_confirmation', status: 'pending' };
      cards.push(card);
      return card;
    },
  });
  await read(run.id);
  assert.equal(cards[0]?.addresseeUserId, 'project-owner');
  Object.assign(cards[0], { status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: board.id });
  assert.equal((await read(run.id))[0].status, 'unauthorized');
  assert.equal(state.decisions.length, 0);
  cards[0].resolvedByUserId = 'project-owner';
  assert.equal((await read(run.id))[0].consumed, true);
  assert.equal(state.runs[run.id].nodeStates['requirements-gate'].outcome, 'accept');
  assert.equal(state.decisions[0].actor.id, 'project-owner');
});

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
  });
}
