import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planModelSeats, seatUnavailable } from '../../src/plugin/model-seats.mjs';
import { createSeatDispatch } from '../../src/plugin/seat-dispatch.mjs';
import { reconcileSeatRuntime } from '../../src/plugin/seat-runtime.mjs';

const agents = [
  { id: 'claude', adapterType: 'claude_local', adapterConfig: { model: 'default-claude' } },
  { id: 'codex', adapterType: 'codex_local', adapterConfig: { model: 'default-codex' } },
  { id: 'open', adapterType: 'opencode_local', adapterConfig: { model: 'default-open' } },
];
const rules = {
  resolveSeatOrder(layers) {
    return Object.assign({}, layers.paperclipAgent, layers.companyProfile, layers.projectProfile,
      layers.projectNodeSeat, layers.runOverride);
  },
  checkSeatConstraints(assignments, declaration) {
    assert.ok(assignments.length >= declaration.minSeats);
    if (declaration.distinctVendor) assert.equal(new Set(assignments.map(seat => seat.vendor)).size, assignments.length);
  },
};
const declaration = name => ({ name, minSeats: 2, distinctVendor: true });
const seats = [
  { name: 'a', declaration: declaration('a'), boundAgentId: 'claude', layers: {
    companyProfile: { model: 'company', reasoning: 'high' }, projectProfile: { model: 'project' },
    projectNodeSeat: { model: 'node' }, runOverride: { model: 'run' },
  } },
  { name: 'b', declaration: declaration('b'), boundAgentId: 'codex', roleAgentIds: ['codex', 'open'], layers: {
    projectProfile: { harness: 'codex_local', fallback: [
      { harness: 'claude_local', model: 'claude-model' },
      { harness: 'opencode_local', model: 'open-model' },
    ] },
  } },
];
const input = { seats, agents, rules, project: { modelVendors: { 'open-model': 'provider-open' } } };

test('seat overrides use the highest layer and preserve Agent defaults when no override was requested', () => {
  const [a, b] = planModelSeats(input);
  assert.deepEqual(a.adapterConfig, { model: 'run', effort: 'high' });
  assert.equal(b.agentId, 'codex');
  assert.equal(b.requested.model, 'default-codex');
  assert.deepEqual(b.adapterConfig, {});
  assert.deepEqual(b.actual, { harness: 'unverified', model: 'unverified' });
});

test('fallback requires infrastructure failure and rechecks vendors with existing seats pinned', () => {
  const [a, b] = planModelSeats(input);
  const pinned = { a, b };
  assert.equal(planModelSeats({ ...input, pinned, failureBySeat: { b: { code: 'tests_failed' } } }), null);
  assert.equal(planModelSeats({ ...input, pinned, failureBySeat: { b: { code: 'ETIMEDOUT' } } }), null);
  const [, fallback] = planModelSeats({ ...input, pinned, failureBySeat: { b: { status: 429 } } });
  assert.equal(fallback.agentId, 'open');
  assert.equal(fallback.fallbackReason, 'http_429');
  assert.equal(fallback.fallbackIndex, 1);
  assert.equal(planModelSeats({ ...input, pinned, seats: [seats[0], { ...seats[1], roleAgentIds: ['codex'] }],
    failureBySeat: { b: { status: 429 } } }), null);
  assert.equal(seatUnavailable({ onUnavailable: 'wait', waitDeadlineMs: 100 }, 1, 100), 'waiting_seats');
  assert.equal(seatUnavailable({ onUnavailable: 'wait', waitDeadlineMs: 100 }, 1, 101), 'escalate');
  assert.equal(seatUnavailable({ onUnavailable: 'block' }, 1, 101), 'blocked');
});

test('a timeout without confirmed retry safety records runtime provenance and leaves the attempt in place', async () => {
  const records = [];
  const selection = planModelSeats(input)[0];
  await reconcileSeatRuntime({
    event: { companyId: 'company', entityId: 'agent-run', eventType: 'agent.run.failed',
      payload: { adapterType: 'claude_local', error: { code: 'ETIMEDOUT' } } },
    host: { manifest: { id: 'plugin' }, issues: { get: async () => ({ status: 'done' }) } },
    engine: { recordDecision: async input => { records.push(input); return input; } },
    runs: { run: { id: 'run', status: 'running', input: {}, nodeStates: { node: { status: 'pending', attempts: [] } } } },
    decisions: [{ type: 'model-seat-dispatch', runId: 'run', nodeId: 'node', evidence: [{ attempt: 1, selection }] }],
    getDispatch: async () => ({ agent_run_id: 'agent-run', issue_id: 'issue' }),
    dispatch: { retryNode: () => assert.fail('Unexpected retry') },
  });
  assert.deepEqual(records[0].evidence[0].actual, { harness: 'claude_local', model: 'unverified' });
  assert.equal(records[0].evidence[0].fallback, false);
});

test('declared seats require configuration and a resumed seat wait uses new keys', async () => {
  const node = { id: 'goldfish', role: 'internal-product-analyst', seat: { name: 'goldfish' } };
  const config = { adlcProjects: { project: {} } };
  const resolve = createSeatDispatch({ manifest: { id: 'plugin' }, config: { get: async () => config },
    agents: { list: async () => [] } }, rules);
  const keys = [];
  const engine = { listDecisions: async () => [],
    recordDecision: async ({ idempotencyKey }) => { keys.push(idempotencyKey); return { at: '2000-01-01T00:00:00Z' }; },
    pauseRun: async ({ idempotencyKey }) => keys.push(idempotencyKey) };
  const run = { id: 'run', packId: 'adlc', graph: { id: 'requirements-baseline', nodes: [node] }, input: { projectId: 'project' } };
  const args = { companyId: 'company', engine, run, node, config: {}, attempt: 1 };
  assert.equal((await resolve(args)).status, 'blocked');
  config.adlcProjects.project.seatGroups = { 'requirements-baseline': [{ goldfish: { ...node.seat, onUnavailable: 'wait' } }] };
  assert.equal((await resolve(args)).status, 'waiting_human');
  run.resumeCount = 1;
  assert.equal((await resolve(args)).status, 'waiting_human');
  assert.equal(new Set(keys).size, 4);
});
