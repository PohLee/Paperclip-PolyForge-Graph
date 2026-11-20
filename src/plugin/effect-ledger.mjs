import { canonical } from '../core/canonical.mjs';

function effectTable(db) {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid host database namespace');
  return `${db.namespace}.graph_external_effect`;
}

// The insertion is the exclusive right to send. An existing unknown outcome is
// never reclaimed by time: the caller must reconcile with the external system.
export async function beginEffect(db, companyId, operationId, request) {
  const table = effectTable(db);
  const inserted = await db.execute(`INSERT INTO ${table} (company_id,operation_id,request,outcome)
    VALUES ($1,$2,$3::jsonb,'unknown') ON CONFLICT DO NOTHING`,
  [companyId, operationId, JSON.stringify(request)]);
  const rows = await db.query(`SELECT request,outcome,result FROM ${table} WHERE company_id=$1 AND operation_id=$2`,
    [companyId, operationId]);
  const row = rows[0];
  if (!row || canonical(typeof row.request === 'string' ? JSON.parse(row.request) : row.request) !== canonical(request)) {
    throw new Error('External effect operation ID reused with a different request');
  }
  return { owner: inserted.rowCount === 1, outcome: row.outcome,
    result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result };
}

export async function confirmEffect(db, companyId, operationId, outcome, result) {
  if (!['confirmed_success', 'confirmed_failure'].includes(outcome)) throw new Error('Invalid confirmed effect outcome');
  const table = effectTable(db);
  const updated = await db.execute(`UPDATE ${table} SET outcome=$3,result=$4::jsonb,updated_at=now()
    WHERE company_id=$1 AND operation_id=$2 AND outcome='unknown'`,
  [companyId, operationId, outcome, JSON.stringify(result)]);
  if (updated.rowCount === 1) return;
  const rows = await db.query(`SELECT outcome,result FROM ${table} WHERE company_id=$1 AND operation_id=$2`, [companyId, operationId]);
  const current = rows[0];
  const prior = typeof current?.result === 'string' ? JSON.parse(current.result) : current?.result;
  if (!current || current.outcome !== outcome || canonical(prior) !== canonical(result)) {
    throw new Error('External effect outcome conflicts with existing confirmation');
  }
}

export async function settleAbsentEffect(db, companyId, operationId, graceMs, result) {
  const table = effectTable(db);
  const updated = await db.execute(`UPDATE ${table} SET outcome='confirmed_failure',result=$4::jsonb,updated_at=now()
    WHERE company_id=$1 AND operation_id=$2 AND outcome='unknown' AND created_at <= now() - ($3::bigint * interval '1 millisecond')`,
  [companyId, operationId, graceMs, JSON.stringify(result)]);
  if (updated.rowCount === 1) return { settled: true };
  const rows = await db.query(`SELECT outcome,result,created_at,created_at + ($3::bigint * interval '1 millisecond') AS retry_at
    FROM ${table} WHERE company_id=$1 AND operation_id=$2`, [companyId, operationId, graceMs]);
  const current = rows[0];
  if (current?.outcome === 'unknown') return { settled: false, outcome: current.outcome,
    retryAt: current.retry_at == null ? null : new Date(current.retry_at).toISOString() };
  const prior = typeof current?.result === 'string' ? JSON.parse(current.result) : current?.result;
  if (current?.outcome === 'confirmed_success') return { settled: false, outcome: current.outcome, result: prior };
  if (current?.outcome === 'confirmed_failure' && canonical(prior) === canonical(result)) return { settled: true };
  throw new Error('External effect outcome changed concurrently during absent settlement');
}

// A host origin lookup may prove a previously ambiguous creation succeeded.
export async function reconcileEffectSuccess(db, companyId, operationId, result) {
  const table = effectTable(db);
  const rows = await db.query(`SELECT outcome,result FROM ${table} WHERE company_id=$1 AND operation_id=$2`, [companyId,operationId]);
  if (!rows.length) return; // legacy issue predating the ledger
  await confirmEffect(db, companyId, operationId, 'confirmed_success', result);
}

export async function getEffect(db, companyId, operationId) {
  const rows = await db.query(`SELECT request,outcome,result,created_at FROM ${effectTable(db)} WHERE company_id=$1 AND operation_id=$2`, [companyId, operationId]);
  return rows[0] ?? null;
}

// Competes atomically with beginEffect. A losing sender must never send.
export async function retireUnsentEffect(db, companyId, operationId) {
  const table = effectTable(db);
  const inserted = await db.execute(`INSERT INTO ${table} (company_id,operation_id,request,outcome,result)
    VALUES ($1,$2,$3::jsonb,'confirmed_failure',$4::jsonb) ON CONFLICT DO NOTHING`,
  [companyId, operationId, JSON.stringify({ cancelled_before_send: true }), JSON.stringify({ cancelled_before_send: true })]);
  return { ...await getEffect(db, companyId, operationId), inserted: inserted.rowCount === 1 };
}

// Compensation is restricted to this retry's insertions, never sent effects or
// owner-settled failures. Exact JSON equality excludes other failure markers.
export async function cancelUnsentEffects(db, companyId, operationIds) {
  if (!operationIds.length) return 0;
  const deleted = await db.execute(`DELETE FROM ${effectTable(db)}
    WHERE company_id=$1 AND operation_id IN (SELECT jsonb_array_elements_text($2::jsonb))
      AND outcome='confirmed_failure' AND result=$3::jsonb`,
  [companyId, JSON.stringify(operationIds), JSON.stringify({ cancelled_before_send: true })]);
  return deleted.rowCount;
}
