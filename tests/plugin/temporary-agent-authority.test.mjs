import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAgentParentResolver } from '../../src/plugin/temporary-agent-authority.mjs';

const companyId = 'company-a';
const actor = { id: 'lead-agent', kind: 'agent', executionId: 'native-run', roles: ['adlc:lead'] };
const request = { kind: 'sub-agent', parent: { agentId: actor.id,
  executionId: actor.executionId, taskId: 'issue-1' },
  context: { mode: 'fresh', parentSessionRef: 'native-session' } };
const checkout = { issueId: 'issue-1', assigneeAgentId: actor.id,
  checkoutRunId: actor.executionId };

function fixture({ heartbeat = { status: 'running', session_before_id: 'native-session' },
  issue = { id: 'issue-1', companyId, assigneeAgentId: actor.id },
  graphBacked = false, graphDispatch = null, graphRun = null,
  binding = 'adlc:lead', checkoutResult = checkout, afterCheckout = () => {},
  decisions = [], control = { companyId, escalations: [], knowledge: [],
    feedback: [], plans: [] } } = {}) {
  const calls = { checkout: [], callback: [] };
  const host = { db: { namespace: 'plugin_test', query: async (sql, params) => {
    if (sql.includes('public.heartbeat_runs')) return heartbeat ? [heartbeat] : [];
    if (sql.includes('SELECT 1 FROM') && sql.includes('graph_dispatch')) return graphBacked ? [{ '?column?': 1 }] : [];
    if (sql.includes('SELECT issue_id,agent_id,agent_run_id,node_id')) return graphDispatch ? [graphDispatch] : [];
    throw new Error(`Unexpected query: ${sql} / ${params}`);
  } },
  agents: { get: async () => ({ id: actor.id, companyId }) },
  issues: { get: async () => issue,
    assertCheckoutOwner: async (input) => { calls.checkout.push(input); afterCheckout(state); return checkoutResult; } } };
  const state = { packs: { 'adlc@1': { id: 'adlc', version: '1', roles: { lead: {} } } },
    runs: graphRun ? { [graphRun.id]: structuredClone(graphRun) } : {}, decisions, control };
  const engineFor = async () => ({ engine: { getRun: async () => graphRun },
    control: { getSetup: async () => ({ companyId,
      enabledPacks: [{ packId: 'adlc', version: '1' }], organization: { ceo: { id: 'ceo-agent' } } }) },
    store: { read: async () => structuredClone(state) } });
  const dispatch = { assertAgentCallback: async (input) => { calls.callback.push(input); } };
  const resolve = createTemporaryAgentParentResolver({ host, engineFor,
    getConfig: async () => ({ roleBindings: { [binding]: actor.id } }), dispatch });
  return { resolve, calls };
}

test('trusts only a running, bound, checked-out native parent execution', async () => {
  const { resolve, calls } = fixture();
  assert.deepEqual(await resolve({ companyId, actor, request }), {
    agentId: actor.id, canDelegate: true,
    allowedActions: ['read', 'review', 'research', 'analyze'],
    parentSessionRef: 'native-session', workspace: { allowSharedWrite: false },
  });
  assert.deepEqual(calls.checkout[0], { issueId: 'issue-1', companyId,
    actorAgentId: actor.id, actorRunId: actor.executionId });
  await assert.rejects(resolve({ companyId, actor: { ...actor, executionId: 'other' }, request }), /Authenticated parent/);
  await assert.rejects(fixture({ heartbeat: { status: 'succeeded' } }).resolve({ companyId, actor, request }), /running parent/);
  await assert.rejects(fixture({ binding: 'disabled:lead' }).resolve({ companyId, actor, request }), /Pack role binding/);
  await assert.rejects(fixture({ checkoutResult: { ...checkout, checkoutRunId: 'other' } }).resolve({ companyId, actor, request }), /checkout/);
});

test('rejects child heartbeat task keys and caller-chosen context', async () => {
  for (const task_key of ['plugin:graph:session:temporary:abc', 'plugin:graph:session:shadow:abc']) {
    await assert.rejects(fixture({ heartbeat: { status: 'running', task_key } }).resolve({
      companyId, actor, request: { ...request, context: { ...request.context,
        parentSessionRef: 'native-execution:native-run' } },
    }), /cannot delegate/);
  }
  const { resolve } = fixture();
  assert.equal((await resolve({ companyId, actor, request: {
    ...request, context: { mode: 'fresh' },
  } })).parentSessionRef, 'native-session');
  await assert.rejects(resolve({ companyId, actor, request: { ...request,
    context: { ...request.context, parentSessionRef: 'invented' } } }), /trusted heartbeat/);
  const fallback = { ...request, context: { ...request.context,
    parentSessionRef: 'native-execution:native-run' } };
  assert.equal((await fixture({ heartbeat: { status: 'running' } }).resolve({
    companyId, actor, request: fallback })).parentSessionRef, fallback.context.parentSessionRef);
  await assert.rejects(fixture({ heartbeat: { status: 'running' } }).resolve({
    companyId, actor, request: { ...fallback, kind: 'shadow-agent' } }), /snapshot source/);
});

test('Graph child requires the exact active dispatch, pinned run and callback authority', async () => {
  const graphRequest = { ...request, parent: { ...request.parent, runId: 'graph-1', nodeId: 'work' } };
  const graphDispatch = { issue_id: 'issue-1', agent_id: actor.id,
    agent_run_id: actor.executionId, node_id: 'work', attempt: 1,
    phase: 'work', state: 'woken' };
  const graphRun = { id: 'graph-1', status: 'running', packId: 'adlc', packVersion: '1',
    input: { paperclipCompanyId: companyId }, graph: { nodes: [{ id: 'work' }] },
    nodeStates: { work: { status: 'pending' } } };
  const valid = fixture({ graphBacked: true, graphDispatch, graphRun });
  await valid.resolve({ companyId, actor, request: graphRequest });
  assert.equal(valid.calls.callback.length, 1);
  assert.equal(valid.calls.callback[0].operation, 'submit');
  await assert.rejects(fixture({ graphBacked: true, graphDispatch, graphRun }).resolve({
    companyId, actor, request }), /Graph run/);
  await assert.rejects(fixture({ graphBacked: true, graphDispatch: { ...graphDispatch,
    agent_run_id: 'old-run' }, graphRun }).resolve({ companyId, actor,
    request: graphRequest }), /Current Graph dispatch/);
  await assert.rejects(fixture({ graphBacked: true, graphDispatch,
    graphRun: { ...graphRun, status: 'completed' } }).resolve({ companyId, actor,
    request: graphRequest }), /Active pinned/);
  const supervisorDispatch = { ...graphDispatch, phase: 'supervisor' };
  const reviewRun = { ...graphRun, nodeStates: {
    work: { status: 'awaiting_supervisor_review' } }, pack: {
    id: 'adlc', roles: { lead: {} },
  } };
  const supervisor = fixture({ graphBacked: true, graphDispatch: supervisorDispatch,
    graphRun: reviewRun });
  await supervisor.resolve({ companyId, actor, request: graphRequest });
  assert.equal(supervisor.calls.callback[0].operation, 'review');
  assert.ok(supervisor.calls.callback[0].actor.roles.includes('lead'));
});

test('snapshot authority is sourced from trusted Graph and company state', async () => {
  const graphDispatch = { issue_id: 'issue-1', agent_id: actor.id,
    agent_run_id: actor.executionId, node_id: 'work', attempt: 1,
    phase: 'work', state: 'woken' };
  const graphRun = { id: 'graph-1', status: 'running', packId: 'adlc', packVersion: '1',
    input: { paperclipCompanyId: companyId, feature: 'calculator', projectId: 'project-1' },
    graph: { nodes: [{ id: 'work' }] }, nodeStates: { work: { status: 'pending' } } };
  const shadow = { ...request, kind: 'shadow-agent',
    parent: { ...request.parent, runId: 'graph-1' },
    context: { mode: 'snapshot', parentSessionRef: 'native-session', snapshot: {
      objective: 'Check arithmetic', currentState: 'Parent wants floating point',
      conclusions: ['Floating point is preferred'], openQuestions: [],
      evidenceRefs: [{ kind: 'issue', id: 'issue-1' }],
    } } };
  const inputs = { graphBacked: true, graphDispatch, graphRun,
    decisions: [
      { id: 'approved', type: 'product', feature: 'calculator', status: 'approved', outcome: 'Exact arithmetic' },
      { id: 'rejected', type: 'product', feature: 'calculator', status: 'rejected', outcome: 'Floating point' },
      { id: 'other', type: 'product', feature: 'shipping', status: 'approved' },
    ] };
  const { resolve } = fixture(inputs);
  const authority = await resolve({ companyId, actor, request: shadow });
  assert.equal(authority.parentNodeId, 'work');
  assert.equal(authority.contextSnapshot.source.nodeId, 'work');
  assert.equal(authority.contextSnapshot.authority.feature, 'calculator');
  assert.deepEqual(authority.contextSnapshot.authority.activeProductDecisionIds, ['approved']);
  assert.deepEqual(authority.contextSnapshot.authority.decisions.map((item) => item.id),
    ['approved', 'rejected']);
  const changed = fixture({ ...inputs, afterCheckout: state => {
    state.decisions.push({ id: 'late-rejection', type: 'product', feature: 'calculator',
      status: 'rejected', outcome: 'A newly rejected change' });
  } });
  const refreshed = await changed.resolve({ companyId, actor, request: shadow });
  assert.ok(refreshed.contextSnapshot.authority.decisions.some(item => item.id === 'late-rejection'));
  const stopped = fixture({ ...inputs, afterCheckout: state => { state.runs['graph-1'].status = 'stopped'; } });
  await assert.rejects(stopped.resolve({ companyId, actor, request: shadow }), /changed before snapshot/);
});
