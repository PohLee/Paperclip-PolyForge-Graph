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
const mapped = (row) => row && ({
  companyId: field(row, 'company_id', 'companyId'), requestKey: field(row, 'request_key', 'requestKey'),
  fingerprint: row.fingerprint, agentId: field(row, 'agent_id', 'agentId'),
  parentRunId: field(row, 'parent_run_id', 'parentRunId'),
  parentTaskId: field(row, 'parent_task_id', 'parentTaskId'),
  sessionId: field(row, 'session_id', 'sessionId') ?? null,
  shadowId: field(row, 'shadow_id', 'shadowId') ?? null,
  executionId: field(row, 'execution_id', 'executionId') ?? null,
  deadlineAt: field(row, 'deadline_at', 'deadlineAt'), status: row.status,
  outcome: row.outcome ?? null,
});

export function createShadowLaunchStore(db) {
  return {
    async claim(input) {
      const result = await db.execute(`INSERT INTO ${table(db)}
        (company_id,request_key,fingerprint,agent_id,parent_run_id,parent_task_id,deadline_at,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'claimed') ON CONFLICT DO NOTHING`,
      [input.companyId, input.requestKey, input.fingerprint, input.agentId,
        input.parentRunId, input.parentTaskId, input.deadlineAt]);
      const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND request_key=$2`,
        [input.companyId, input.requestKey]);
      const record = mapped(rows[0]);
      if (!record || record.fingerprint !== input.fingerprint) {
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
      executionId = null, outcome = null }) {
      const result = await db.execute(`UPDATE ${table(db)} SET status=$4,
        session_id=COALESCE($5,session_id),shadow_id=COALESCE($6,shadow_id),
        execution_id=COALESCE($7,execution_id),outcome=COALESCE($8,outcome),updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status=$3`,
      [companyId, requestKey, from, to, sessionId, shadowId, executionId, outcome]);
      if (result.rowCount !== 1) throw new Error(`Shadow launch state changed before ${to}`);
      return this.get(companyId, requestKey);
    },
  };
}
