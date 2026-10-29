import { createHash } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export const shadowRequestFingerprint = (request) =>
  `sha256:${createHash('sha256').update(canonical(request)).digest('hex')}`;

function table(db) {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid plugin database namespace');
  return `${db.namespace}.graph_shadow_launch`;
}

const field = (row, snake, camel) => row?.[snake] ?? row?.[camel];
function dataObject(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function rowData(row) {
  const value = row?.data;
  return dataObject(typeof value === 'string' ? JSON.parse(value) : value, 'Shadow launch data');
}
const mapped = (row) => row ? ({
  companyId: field(row, 'company_id', 'companyId'), requestKey: field(row, 'request_key', 'requestKey'),
  fingerprint: row.fingerprint, agentId: field(row, 'agent_id', 'agentId'),
  parentRunId: field(row, 'parent_run_id', 'parentRunId'),
  parentTaskId: field(row, 'parent_task_id', 'parentTaskId'),
  sessionId: field(row, 'session_id', 'sessionId') ?? null,
  shadowId: field(row, 'shadow_id', 'shadowId') ?? null,
  executionId: field(row, 'execution_id', 'executionId') ?? null,
  deadlineAt: field(row, 'deadline_at', 'deadlineAt'), status: row.status,
  outcome: row.outcome ?? null,
  data: rowData(row), leaseOwner: field(row, 'lease_owner', 'leaseOwner') ?? null,
  leaseExpiresAt: field(row, 'lease_expires_at', 'leaseExpiresAt') ?? null,
}) : null;

export function createShadowLaunchStore(db) {
  return {
    async claim(input) {
      const result = await db.execute(`INSERT INTO ${table(db)}
        (company_id,request_key,fingerprint,agent_id,parent_run_id,parent_task_id,deadline_at,status,data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'claimed',$8::jsonb) ON CONFLICT DO NOTHING`,
      [input.companyId, input.requestKey, input.fingerprint, input.agentId,
        input.parentRunId, input.parentTaskId, input.deadlineAt,
        JSON.stringify(dataObject(input.data, 'Shadow launch data'))]);
      const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND request_key=$2`,
        [input.companyId, input.requestKey]);
      const record = mapped(rows[0]);
      if (!record) {
        const competing = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1
          AND parent_run_id=$2 AND parent_task_id=$3 AND status<>'closed'`,
        [input.companyId, input.parentRunId, input.parentTaskId]);
        if (competing.length) throw new Error('Parent task already has a Shadow launch');
        throw new Error('Shadow launch claim failed');
      }
      if (record.fingerprint !== input.fingerprint) {
        throw new Error('Shadow idempotency key reused with different request');
      }
      return { ...record, created: result.rowCount === 1 };
    },
    async get(companyId, requestKey) {
      const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND request_key=$2`,
        [companyId, requestKey]);
      return mapped(rows[0]);
    },
    async list(companyId) {
      const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1
        AND status<>'closed' ORDER BY created_at`, [companyId]);
      return rows.map(mapped);
    },
    async transition({ companyId, requestKey, from, to, sessionId = null, shadowId = null,
      executionId = null, outcome = null, data = {}, leaseOwner = null }) {
      const result = await db.execute(`UPDATE ${table(db)} SET status=$4,
        session_id=COALESCE($5,session_id),shadow_id=COALESCE($6,shadow_id),
        execution_id=COALESCE($7,execution_id),outcome=COALESCE($8,outcome),
        data=data || $9::jsonb,updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status=$3
        AND ($10::text IS NULL OR (lease_owner=$10 AND lease_expires_at>now()))`,
      [companyId, requestKey, from, to, sessionId, shadowId, executionId, outcome,
        JSON.stringify(dataObject(data, 'Shadow launch transition data')), leaseOwner]);
      if (result.rowCount !== 1) throw new Error(`Shadow launch state changed before ${to}`);
      return this.get(companyId, requestKey);
    },
    async patchData({ companyId, requestKey, patch, leaseOwner = null }) {
      const result = await db.execute(`UPDATE ${table(db)} SET data=data || $3::jsonb,
        updated_at=now() WHERE company_id=$1 AND request_key=$2 AND status<>'closed'
        AND ($4::text IS NULL OR (lease_owner=$4 AND lease_expires_at>now()))`,
      [companyId, requestKey, JSON.stringify(dataObject(patch, 'Shadow launch patch')), leaseOwner]);
      if (result.rowCount !== 1) throw new Error('Shadow launch data changed or lease expired');
      return this.get(companyId, requestKey);
    },
    async acquireLease({ companyId, requestKey, owner, ttlSeconds }) {
      if (typeof owner !== 'string' || !owner.trim() || !Number.isInteger(ttlSeconds) ||
          ttlSeconds < 1 || ttlSeconds > 300) throw new Error('Invalid Shadow launch lease');
      const result = await db.execute(`UPDATE ${table(db)} SET lease_owner=$3,
        lease_expires_at=now()+($4 * interval '1 second'),updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status<>'closed'
        AND (lease_expires_at IS NULL OR lease_expires_at<=now() OR lease_owner=$3)`,
      [companyId, requestKey, owner, ttlSeconds]);
      return result.rowCount === 1 ? this.get(companyId, requestKey) : null;
    },
    async releaseLease({ companyId, requestKey, owner }) {
      if (typeof owner !== 'string' || !owner.trim()) throw new Error('Invalid Shadow launch lease owner');
      const result = await db.execute(`UPDATE ${table(db)} SET lease_owner=NULL,
        lease_expires_at=NULL,updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND lease_owner=$3`,
      [companyId, requestKey, owner]);
      return result.rowCount === 1;
    },
  };
}
