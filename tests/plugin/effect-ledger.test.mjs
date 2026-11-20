import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { beginEffect, confirmEffect, reconcileEffectSuccess, retireUnsentEffect } from '../../src/plugin/effect-ledger.mjs';
import * as ledger from '../../src/plugin/effect-ledger.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

function database() {
  const rows = new Map();
  return { namespace: 'plugin_test',
    async execute(sql, args) {
      const key = `${args[0]}:${args[1]}`;
      if (sql.includes('DELETE FROM')) {
        assert.match(sql, /company_id=\$1 AND operation_id IN \(SELECT jsonb_array_elements_text\(\$2::jsonb\)\)/);
        assert.match(sql, /outcome='confirmed_failure' AND result=\$3::jsonb/);
        let rowCount = 0;
        assert.equal(typeof args[1], 'string');
        for (const id of JSON.parse(args[1])) {
          const candidate = `${args[0]}:${id}`, row = rows.get(candidate);
          if (row?.outcome === 'confirmed_failure' && JSON.stringify(row.result) === args[2]) {
            rows.delete(candidate); rowCount++;
          }
        }
        return { rowCount };
      }
      if (sql.includes('INSERT INTO')) {
        if (rows.has(key)) return { rowCount: 0 };
        rows.set(key, { request: JSON.parse(args[2]), outcome: args.length === 4 ? 'confirmed_failure' : 'unknown', result: args.length === 4 ? JSON.parse(args[3]) : null,
          created_at: '2026-11-19T00:00:00.000Z' });
        return { rowCount: 1 };
      }
      const row = rows.get(key);
      if (!row || row.outcome !== 'unknown') return { rowCount: 0 };
      row.outcome = args[2]; row.result = JSON.parse(args[3]); return { rowCount: 1 };
    },
    async query(_sql, args) { const row = rows.get(`${args[0]}:${args[1]}`); return row ? [structuredClone(row)] : []; },
  };
}

test('effect lookup returns creation time and scopes the operation to its company', async () => {
  const row = { request: {}, outcome: 'unknown', result: null, created_at: '2026-11-19T00:00:00.000Z' };
  const db = { namespace: 'plugin_test', query: async (sql, args) => {
    assert.match(sql, /SELECT request,outcome,result,created_at FROM plugin_test.graph_external_effect/);
    assert.match(sql, /WHERE company_id=\$1 AND operation_id=\$2/);
    assert.deepEqual(args, ['company', 'operation']);
    return [row];
  } };
  assert.deepEqual(await ledger.getEffect(db, 'company', 'operation'), row);
  db.query = async () => [];
  assert.equal(await ledger.getEffect(db, 'company', 'operation'), null);
});

test('absent effect settlement atomically checks the grace with the database clock', async () => {
  const result = { settledBy: 'owner-retry', lookup: 'absent' };
  const db = { namespace: 'plugin_test', execute: async (sql, args) => {
    assert.match(sql, /UPDATE plugin_test.graph_external_effect SET outcome='confirmed_failure',result=\$4::jsonb,updated_at=now\(\)/);
    assert.match(sql, /WHERE company_id=\$1 AND operation_id=\$2 AND outcome='unknown'/);
    assert.match(sql, /created_at <= now\(\) - \(\$3::bigint \* interval '1 millisecond'\)/);
    assert.deepEqual(args, ['company', 'operation', 60_000, JSON.stringify(result)]);
    return { rowCount: 1 };
  }, query: async () => assert.fail('A successful settlement needs no read') };
  assert.deepEqual(await ledger.settleAbsentEffect(db, 'company', 'operation', 60_000, result), { settled: true });
});

test('young absent effect reports its retry time from the database', async () => {
  const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }), query: async (sql, args) => {
    assert.match(sql, /SELECT outcome,result,created_at,created_at \+ \(\$3::bigint \* interval '1 millisecond'\) AS retry_at/);
    assert.match(sql, /WHERE company_id=\$1 AND operation_id=\$2/);
    assert.deepEqual(args, ['company', 'operation', 60_000]);
    return [{ outcome: 'unknown', result: null, created_at: '2026-11-19T00:00:00.000Z', retry_at: '2026-11-19T00:01:00.000Z' }];
  } };
  assert.deepEqual(await ledger.settleAbsentEffect(db, 'company', 'operation', 60_000, {}),
    { settled: false, outcome: 'unknown', retryAt: '2026-11-19T00:01:00.000Z' });
});

test('absent effect settlement accepts only an identical concurrent failure', async () => {
  const result = { settledBy: 'owner-retry', lookup: 'absent' };
  const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }) };
  for (const prior of [result, JSON.stringify({ lookup: 'absent', settledBy: 'owner-retry' })]) {
    db.query = async () => [{ outcome: 'confirmed_failure', result: prior }];
    assert.deepEqual(await ledger.settleAbsentEffect(db, 'company', 'operation', 60_000, result), { settled: true });
  }
  for (const row of [null, { outcome: 'confirmed_failure', result: { cancelled_before_send: true } }]) {
    db.query = async () => row ? [row] : [];
    await assert.rejects(ledger.settleAbsentEffect(db, 'company', 'operation', 60_000, result), /changed concurrently/);
  }
});

test('absent effect settlement returns a concurrent success without settling failure', async () => {
  const result = { issueId: 'issue' };
  for (const prior of [result, JSON.stringify(result)]) {
    const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }),
      query: async () => [{ outcome: 'confirmed_success', result: prior }] };
    assert.deepEqual(await ledger.settleAbsentEffect(db, 'company', 'operation', 60_000,
      { settledBy: 'owner-retry', lookup: 'absent' }), { settled: false, outcome: 'confirmed_success', result });
  }
});

test('effect authority survives a new caller and requires an exact request and outcome', async () => {
  const db = database(); const request = { parent: 'root', agent: 'a' };
  assert.equal((await beginEffect(db, 'company', 'operation', request)).owner, true);
  assert.deepEqual(await beginEffect(db, 'company', 'operation', request), { owner: false, outcome: 'unknown', result: null });
  await assert.rejects(beginEffect(db, 'company', 'operation', { ...request, agent: 'b' }), /different request/);
  await reconcileEffectSuccess(db, 'company', 'operation', { issueId: 'issue' });
  await confirmEffect(db, 'company', 'operation', 'confirmed_success', { issueId: 'issue' });
  assert.deepEqual(await beginEffect(db, 'company', 'operation', request), { owner: false, outcome: 'confirmed_success', result: { issueId: 'issue' } });
  await assert.rejects(confirmEffect(db, 'company', 'operation', 'confirmed_failure', { reason: 'failed' }), /conflicts/);
});


test('retirement and send claim have one durable winner', async () => {
  const request = { title: 'work' };
  const first = database();
  const retired = await retireUnsentEffect(first, 'company', 'operation');
  assert.equal(retired.inserted, true);
  assert.equal(retired.created_at, '2026-11-19T00:00:00.000Z');
  assert.equal((await retireUnsentEffect(first, 'company', 'operation')).inserted, false);
  await assert.rejects(beginEffect(first, 'company', 'operation', request), /different request/);
  const second = database();
  assert.equal((await beginEffect(second, 'company', 'operation', request)).owner, true);
  const outcome = await retireUnsentEffect(second, 'company', 'operation');
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.inserted, false);
  assert.deepEqual(outcome.request, request);
  assert.equal(outcome.created_at, '2026-11-19T00:00:00.000Z');
});

test('cancel retirement deletes only the named company tombstones with the exact cancellation marker', async () => {
  const db = database(), request = { title: 'work' };
  for (const id of ['cancel', 'keep']) await retireUnsentEffect(db, 'company', id);
  await retireUnsentEffect(db, 'other', 'cancel');
  for (const id of ['unknown', 'success', 'failure', 'other-marker']) await beginEffect(db, 'company', id, request);
  await confirmEffect(db, 'company', 'success', 'confirmed_success', { issueId: 'issue' });
  await confirmEffect(db, 'company', 'failure', 'confirmed_failure', { settledBy: 'owner-retry', lookup: 'absent' });
  await confirmEffect(db, 'company', 'other-marker', 'confirmed_failure', { cancelled_before_send: true, extra: true });
  assert.equal(await ledger.cancelUnsentEffects(db, 'company', ['cancel', 'unknown', 'success', 'failure', 'other-marker']), 1);
  assert.equal(await ledger.getEffect(db, 'company', 'cancel'), null);
  for (const id of ['keep', 'unknown', 'success', 'failure', 'other-marker']) assert.ok(await ledger.getEffect(db, 'company', id));
  assert.ok(await ledger.getEffect(db, 'other', 'cancel'));
  assert.equal((await beginEffect(db, 'company', 'cancel', request)).owner, true);
  assert.equal(await ledger.cancelUnsentEffects(db, 'company', []), 0);
});

test('PostgreSQL retirement reports insertion ownership and cancellation requires the exact marker',
  { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' },
  async (t) => {
    const { db, sql, namespace, companyId, otherCompanyId } = await createPostgresShadowDatabase(t);
    await sql.unsafe(`CREATE TABLE ${namespace}.issues (id uuid PRIMARY KEY)`);
    await sql.unsafe(`CREATE TABLE ${namespace}.agents (id uuid PRIMARY KEY)`);
    for (const migration of ['001_graph_state.sql', '017_dispatch_effects.sql']) {
      const source = await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
      await sql.unsafe(source.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
        .replaceAll('REFERENCES public.', `REFERENCES ${namespace}.`));
    }
    const request = { title: 'work' };
    for (const id of ['cancel', 'keep']) {
      assert.equal((await retireUnsentEffect(db, companyId, id)).inserted, true);
      assert.equal((await retireUnsentEffect(db, companyId, id)).inserted, false);
    }
    await retireUnsentEffect(db, otherCompanyId, 'cancel');
    for (const id of ['unknown', 'success', 'failure', 'other-marker']) await beginEffect(db, companyId, id, request);
    assert.equal((await retireUnsentEffect(db, companyId, 'unknown')).inserted, false);
    assert.equal((await ledger.getEffect(db, companyId, 'unknown')).outcome, 'unknown');
    await confirmEffect(db, companyId, 'success', 'confirmed_success', { cancelled_before_send: true });
    await confirmEffect(db, companyId, 'failure', 'confirmed_failure', { settledBy: 'owner-retry', lookup: 'absent' });
    await confirmEffect(db, companyId, 'other-marker', 'confirmed_failure', { cancelled_before_send: true, extra: true });
    assert.equal(await ledger.cancelUnsentEffects(db, companyId, ['cancel', 'unknown', 'success', 'failure', 'other-marker']), 1);
    assert.equal(await ledger.getEffect(db, companyId, 'cancel'), null);
    for (const id of ['keep', 'unknown', 'success', 'failure', 'other-marker']) assert.ok(await ledger.getEffect(db, companyId, id));
    assert.ok(await ledger.getEffect(db, otherCompanyId, 'cancel'));
    assert.equal(await ledger.cancelUnsentEffects(db, companyId, []), 0);
    const result = { settledBy: 'owner-retry', lookup: 'absent' }, graceMs = 600_000;
    await beginEffect(db, companyId, 'absent', request);
    const young = await ledger.settleAbsentEffect(db, companyId, 'absent', graceMs, result);
    assert.equal(young.settled, false);
    assert.equal(young.outcome, 'unknown');
    const created = await ledger.getEffect(db, companyId, 'absent');
    assert.equal(Date.parse(young.retryAt), Date.parse(created.created_at) + graceMs);
    await sql.unsafe(`UPDATE ${namespace}.graph_external_effect SET created_at=now() - interval '1 hour'
      WHERE company_id=$1 AND operation_id=$2`, [companyId, 'absent']);
    assert.deepEqual(await ledger.settleAbsentEffect(db, companyId, 'absent', graceMs, result), { settled: true });
    const settled = await ledger.getEffect(db, companyId, 'absent');
    assert.equal(settled.outcome, 'confirmed_failure');
    assert.deepEqual(settled.result, result);
  });
