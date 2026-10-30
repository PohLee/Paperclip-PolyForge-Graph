import { createHash } from 'node:crypto';

const states = Object.freeze({
  claimed: ['creating', 'closing'], creating: ['created', 'needs-repair'],
  created: ['sending', 'closing'], sending: ['active', 'needs-repair'],
  active: ['stopping', 'closing'], stopping: ['closing'],
  'needs-repair': ['created', 'active', 'closing'], closing: ['closed'],
});
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const temporaryAgentFingerprint = (value) =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
export const temporaryAgentTaskKey = (pluginId, companyId, requestKey) =>
  `plugin:${pluginId}:session:temporary:${createHash('sha256').update(`${companyId}:${requestKey}`).digest('hex')}`;

const table = (db) => {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid plugin database namespace');
  return `${db.namespace}.graph_temporary_agent_launch`;
};
const val = (row, snake, camel) => row?.[snake] ?? row?.[camel];
const object = (value) => {
  if (value == null) return {};
  if (typeof value === 'string') return object(JSON.parse(value));
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Launch data must be an object');
  return value;
};
const map = (row) => row ? ({
  companyId: val(row, 'company_id', 'companyId'),
  requestKey: val(row, 'request_key', 'requestKey'),
  id: val(row, 'temporary_agent_id', 'id'), fingerprint: row.fingerprint,
  parentAgentId: val(row, 'parent_agent_id', 'parentAgentId'),
  parentExecutionId: val(row, 'parent_execution_id', 'parentExecutionId'),
  agentId: val(row, 'agent_id', 'agentId'),
  sessionId: val(row, 'session_id', 'sessionId') ?? null,
  executionId: val(row, 'execution_id', 'executionId') ?? null,
  deadlineAt: val(row, 'deadline_at', 'deadlineAt'),
  status: row.status, outcome: row.outcome ?? null,
  data: object(row.data),
}) : null;

export function createTemporaryAgentLaunchStore(db) {
  const api = {
    async get(companyId, requestKey) {
      return map((await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND request_key=$2`,
        [companyId, requestKey]))[0]);
    },
    async getById(companyId, id) {
      return map((await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND temporary_agent_id=$2`,
        [companyId, id]))[0]);
    },
    async list(companyId, { activeOnly = false, parentAgentId = null,
      parentExecutionId = null } = {}) {
      const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1
        AND ($2::boolean=false OR status<>'closed')
        AND ($3::uuid IS NULL OR parent_agent_id=$3)
        AND ($4::text IS NULL OR parent_execution_id=$4)
        ORDER BY created_at`, [companyId, activeOnly, parentAgentId, parentExecutionId]);
      return rows.map(map);
    },
    async claim(input) {
      if (!Number.isInteger(input.maxConcurrentChildren) ||
          input.maxConcurrentChildren < 1 || input.maxConcurrentChildren > 16) {
        throw new Error('Invalid Temporary Agent concurrency limit');
      }
      const inserted = await db.execute(`INSERT INTO ${table(db)}
        (company_id,request_key,fingerprint,parent_agent_id,parent_execution_id,
          agent_id,parent_slot,deadline_at,status,data)
        SELECT $1,$2,$3,$4,$5,$6,slot,$7,'claimed',$8::jsonb
        FROM generate_series(1,$9::integer) AS slots(slot)
        WHERE NOT EXISTS (SELECT 1 FROM ${table(db)} active
          WHERE active.company_id=$1 AND active.parent_agent_id=$4
            AND active.parent_execution_id=$5 AND active.parent_slot=slot
            AND active.status<>'closed')
        ORDER BY slot LIMIT 1 ON CONFLICT DO NOTHING`,
      [input.companyId, input.requestKey, input.fingerprint, input.parentAgentId,
        input.parentExecutionId, input.agentId, input.deadlineAt,
        JSON.stringify(object(input.data)), input.maxConcurrentChildren]);
      const row = await api.get(input.companyId, input.requestKey);
      if (!row) throw new Error('Temporary Agent concurrency limit or claim race; retry');
      if (row.fingerprint !== input.fingerprint) {
        throw new Error('Temporary Agent idempotency key reused with different request');
      }
      return { ...row, created: inserted.rowCount === 1 };
    },
    async acquireLease({ companyId, requestKey, owner, ttlSeconds = 120 }) {
      if (!owner || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
        throw new Error('Invalid Temporary Agent lease');
      }
      const result = await db.execute(`UPDATE ${table(db)} SET lease_owner=$3,
        lease_expires_at=now()+($4 * interval '1 second'),updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status<>'closed'
        AND (lease_expires_at IS NULL OR lease_expires_at<=now() OR lease_owner=$3)`,
      [companyId, requestKey, owner, ttlSeconds]);
      return result.rowCount === 1 ? api.get(companyId, requestKey) : null;
    },
    async releaseLease({ companyId, requestKey, owner }) {
      await db.execute(`UPDATE ${table(db)} SET lease_owner=NULL,lease_expires_at=NULL,
        updated_at=now() WHERE company_id=$1 AND request_key=$2 AND lease_owner=$3`,
      [companyId, requestKey, owner]);
    },
    async transition({ companyId, requestKey, from, to, owner, sessionId = null,
      executionId = null, outcome = null, data = {} }) {
      if (!states[from]?.includes(to)) throw new Error(`Illegal Temporary Agent transition: ${from} -> ${to}`);
      const result = await db.execute(`UPDATE ${table(db)} SET status=$4,
        session_id=COALESCE($5,session_id),execution_id=COALESCE($6,execution_id),
        outcome=COALESCE($7,outcome),
        data=jsonb_set(data || $8::jsonb, '{events}',
          COALESCE(data->'events','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('from',$3::text,'to',$4::text,
            'at',now(),'outcome',$7::text)), true),updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status=$3
        AND lease_owner=$9 AND lease_expires_at>now()`,
      [companyId, requestKey, from, to, sessionId, executionId, outcome,
        JSON.stringify(object(data)), owner]);
      if (result.rowCount !== 1) throw new Error('Temporary Agent state changed or lease expired');
      return api.get(companyId, requestKey);
    },
    async patch({ companyId, requestKey, owner, data }) {
      const result = await db.execute(`UPDATE ${table(db)} SET data=data || $3::jsonb,updated_at=now()
        WHERE company_id=$1 AND request_key=$2 AND status<>'closed'
        AND lease_owner=$4 AND lease_expires_at>now()`,
      [companyId, requestKey, JSON.stringify(object(data)), owner]);
      if (result.rowCount !== 1) throw new Error('Temporary Agent state changed or lease expired');
      return api.get(companyId, requestKey);
    },
    async recordDecision({ companyId, requestKey, owner, decision, data = {} }) {
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
        throw new Error('Invalid Temporary Agent decision event');
      }
      const result = await db.execute(`UPDATE ${table(db)} SET
        data=jsonb_set(data || $3::jsonb, '{events}',
          COALESCE(data->'events','[]'::jsonb) || jsonb_build_array($4::jsonb), true),
        updated_at=now() WHERE company_id=$1 AND request_key=$2 AND status<>'closed'
        AND lease_owner=$5 AND lease_expires_at>now()`,
      [companyId, requestKey, JSON.stringify(object(data)), JSON.stringify(decision), owner]);
      if (result.rowCount !== 1) throw new Error('Temporary Agent state changed or lease expired');
      return api.get(companyId, requestKey);
    },
  };
  return api;
}
