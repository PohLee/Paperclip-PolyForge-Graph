import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDispatchRequest, listDispatchRequests } from '../../src/plugin/store.mjs';
import { createOwnerDispatchSingleflight } from '../../src/plugin/dispatch-control.mjs';

const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

function database() {
  const rows = [];
  const legacy = new Map();
  return {
    namespace: 'plugin_polyforge_graph_ff7d84e8bb', rows, legacy,
    async execute(sql, values) {
      if (!sql.includes('INSERT INTO') || !sql.includes('graph_dispatch_requests')) throw new Error(sql);
      const [id, company_id, graph_run_id, issue_id, actor_user_id, actor_roles, reason, feature,
        pack_id, pack_version, graph_id, graph_version, idempotency_key, request_fingerprint] = values;
      if (idempotency_key && rows.some((row) => row.company_id === company_id && row.idempotency_key === idempotency_key)) {
        return { rowCount: 0 };
      }
      rows.push({ id, company_id, graph_run_id, issue_id, actor_user_id, actor_roles, reason, feature,
        pack_id, pack_version, graph_id, graph_version, idempotency_key, request_fingerprint,
        created_at: new Date().toISOString() });
      return { rowCount: 1 };
    },
    async query(sql, values) {
      if (sql.includes('document #>')) return [{ saved: legacy.get(`${values[0]}:${values[1]}`) ?? null }];
      if (!sql.includes('graph_dispatch_requests')) throw new Error(sql);
      let selected = rows.filter((row) => row.company_id === values[0]);
      if (sql.includes('idempotency_key=$2')) selected = selected.filter((row) => row.idempotency_key === values[1]);
      else if (sql.includes('graph_run_id=$2')) selected = selected.filter((row) => row.graph_run_id === values[1]);
      else if (sql.includes(' AND id=$2')) selected = selected.filter((row) => row.id === values[1]);
      return selected;
    },
  };
}

const base = { companyId: 'company-a', runId: 'run-a', issueId: 'issue-a',
  actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'], executionId: null },
  reason: 'Owner requested ready work recovery', feature: 'feature-a', packId: 'adlc', packVersion: '0.1.6',
  graphId: 'ui-ux-design', graphVersion: '0.1.2' };

test('twelve concurrent owner dispatch requests stay distinct, scoped, and queryable', async () => {
  const db = database();
  const records = await Promise.all(Array.from({ length: 12 }, (_, i) => appendDispatchRequest(db,
    { ...base, idempotencyKey: `request-${i}` })));
  assert.equal(new Set(records.map((record) => record.id)).size, 12);
  assert.equal(db.rows.length, 12);
  assert.equal((await listDispatchRequests(db, 'company-a', 'run-a')).length, 12);
  assert.equal((await listDispatchRequests(db, 'company-b')).length, 0);
  assert.equal(records[0].actor.id, 'owner-a');
  assert.equal(records[0].feature, 'feature-a');
  assert.equal(records[0].graphVersion, '0.1.2');
  assert.equal(db.rows.every((row) => row.company_id === 'company-a'), true);
});

test('dispatch idempotency replays exact request and rejects altered actor or payload', async () => {
  const db = database();
  const first = await appendDispatchRequest(db, { ...base, idempotencyKey: 'same' });
  assert.equal((await appendDispatchRequest(db, { ...base, idempotencyKey: 'same' })).id, first.id);
  await assert.rejects(appendDispatchRequest(db, { ...base, reason: 'Different reason', idempotencyKey: 'same' }),
    /Idempotency key reused/);
  await assert.rejects(appendDispatchRequest(db, { ...base,
    actor: { ...base.actor, id: 'other-owner' }, idempotencyKey: 'same' }), /Idempotency key reused/);
  const otherCompany = await appendDispatchRequest(db,
    { ...base, companyId: 'company-b', idempotencyKey: 'same' });
  assert.notEqual(otherCompany.id, first.id);
  assert.equal((await listDispatchRequests(db, 'company-b')).length, 1);
  assert.equal(db.rows.length, 2);
});

test('an old core idempotency key returns the original decision without a new row', async () => {
  const db = database();
  const key = 'old';
  const oldRecord = { id: 'old-decision', type: 'paperclip_dispatch_recovery', runId: base.runId,
    reason: base.reason };
  const oldRequest = { type: 'paperclip_dispatch_recovery', status: 'approved', outcome: 'requested',
    reason: base.reason, actor: base.actor, question: null, options: [], evidence: [], artifacts: [],
    knownRisks: [], unresolved: [], supersedes: null, runId: base.runId, nodeId: null,
    projectId: null, taskId: null, issueId: base.issueId, affectedRefs: [] };
  db.legacy.set(`${base.companyId}:decision:dispatch-recovery:${base.runId}:${key}`,
    { fingerprint: canonical(oldRequest), result: oldRecord });
  const replay = await appendDispatchRequest(db, { ...base, idempotencyKey: key });
  assert.equal(replay.id, oldRecord.id);
  assert.equal(db.rows.length, 0);
  await assert.rejects(appendDispatchRequest(db, { ...base, reason: 'New reason', idempotencyKey: key }),
    /Idempotency key reused/);
  assert.equal(db.rows.length, 0);
});

test('owner requests keep distinct audit rows while same-run dispatch executes once', async () => {
  const db = database();
  const control = createOwnerDispatchSingleflight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = Array.from({ length: 12 }, (_, i) => (async () => {
    const decision = await appendDispatchRequest(db, { ...base, idempotencyKey: `parallel-${i}` });
    const dispatched = await control.run(base.companyId, base.runId, async () => { calls++; await gate; return ['claimed']; });
    return { decision, dispatched };
  })());
  for (let i = 0; i < 20 && calls === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(requests);
  assert.equal(results.length, 12);
  assert.equal(new Set(results.map((item) => item.decision.id)).size, 12);
  assert.equal(calls, 1);
  assert.equal(db.rows.length, 12);
});
