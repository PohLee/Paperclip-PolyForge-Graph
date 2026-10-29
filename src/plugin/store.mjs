import { RevisionConflict } from '../core/index.mjs';
import { createHash, randomUUID } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function table(namespace, name) {
  if (!/^plugin_[a-z0-9_]+$/.test(namespace)) throw new Error('Invalid host database namespace');
  return `${namespace}.${name}`;
}

function field(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function dispatchRow(row) {
  if (!row) return null;
  return {
    issue_id: field(row, 'issue_id', 'issueId'),
    agent_id: field(row, 'agent_id', 'agentId'),
    agent_run_id: field(row, 'agent_run_id', 'agentRunId'),
    node_id: field(row, 'node_id', 'nodeId'),
    attempt: row.attempt,
    phase: row.phase,
    state: row.state,
    updated_at: field(row, 'updated_at', 'updatedAt'),
  };
}

function dispatchRequestRow(row) {
  if (!row) return null;
  const roles = field(row, 'actor_roles', 'actorRoles');
  return {
    id: row.id, at: field(row, 'created_at', 'createdAt'),
    type: 'paperclip_dispatch_recovery', status: 'approved', outcome: 'requested',
    actor: { id: field(row, 'actor_user_id', 'actorUserId'), kind: 'human',
      roles: typeof roles === 'string' ? JSON.parse(roles) : roles, executionId: null },
    reason: row.reason, feature: row.feature ?? null,
    runId: field(row, 'graph_run_id', 'graphRunId'), issueId: field(row, 'issue_id', 'issueId'), nodeId: null,
    packId: field(row, 'pack_id', 'packId'), packVersion: field(row, 'pack_version', 'packVersion'),
    graphId: field(row, 'graph_id', 'graphId'), graphVersion: field(row, 'graph_version', 'graphVersion'),
  };
}

export async function appendDispatchRequest(db, request) {
  const { companyId, runId, issueId, actor, reason, feature, packId, packVersion, graphId, graphVersion, idempotencyKey } = request;
  if (!companyId || !runId || !issueId || !reason || actor?.kind !== 'human' ||
      !actor.id || !actor.roles?.includes('human-owner') || !packId || !packVersion || !graphId || !graphVersion) {
    throw new Error('A company-scoped, authorized dispatch request is required');
  }
  const key = idempotencyKey ? `dispatch-recovery:${runId}:${idempotencyKey}` : null;
  const identity = { id: actor.id, kind: 'human', roles: [...actor.roles], executionId: null };
  const requestFingerprint = digest({ companyId, runId, issueId, actor: identity, reason, feature: feature ?? null,
    packId, packVersion, graphId, graphVersion });
  if (key) {
    const legacyRows = await db.query(
      `SELECT document #> ARRAY['idempotency', $2::text] AS saved FROM ${table(db.namespace, 'graph_state')} WHERE company_id=$1`,
      [companyId, `decision:${key}`],
    );
    const saved = legacyRows[0]?.saved;
    if (saved) {
      const old = typeof saved === 'string' ? JSON.parse(saved) : saved;
      const expected = { type: 'paperclip_dispatch_recovery', status: 'approved', outcome: 'requested', reason,
        actor: identity, question: null, options: [], evidence: [], artifacts: [], knownRisks: [], unresolved: [],
        supersedes: null, runId, nodeId: null, projectId: null, taskId: null, issueId, affectedRefs: [] };
      if (canonical(JSON.parse(old.fingerprint)) !== canonical(expected)) {
        throw new Error('Idempotency key reused with different request or actor');
      }
      return old.result;
    }
  }
  const id = randomUUID();
  const inserted = await db.execute(
    `INSERT INTO ${table(db.namespace, 'graph_dispatch_requests')}
     (id,company_id,graph_run_id,issue_id,actor_user_id,actor_roles,reason,feature,
       pack_id,pack_version,graph_id,graph_version,idempotency_key,request_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (company_id,idempotency_key) DO NOTHING`,
    [id, companyId, runId, issueId, actor.id, JSON.stringify(identity.roles), reason, feature ?? null,
      packId, packVersion, graphId, graphVersion, key, requestFingerprint],
  );
  const rows = await db.query(
    `SELECT * FROM ${table(db.namespace, 'graph_dispatch_requests')}
     WHERE company_id=$1 AND ${inserted.rowCount === 1 ? 'id=$2' : 'idempotency_key=$2'}`,
    [companyId, inserted.rowCount === 1 ? id : key],
  );
  const row = rows[0];
  if (!row || field(row, 'request_fingerprint', 'requestFingerprint') !== requestFingerprint) {
    throw new Error('Idempotency key reused with different request or actor');
  }
  return dispatchRequestRow(row);
}

export async function listDispatchRequests(db, companyId, runId = null) {
  const rows = await db.query(
    `SELECT * FROM ${table(db.namespace, 'graph_dispatch_requests')}
     WHERE company_id=$1${runId ? ' AND graph_run_id=$2' : ''} ORDER BY created_at DESC`,
    runId ? [companyId, runId] : [companyId],
  );
  return rows.map(dispatchRequestRow);
}

export class PaperclipStore {
  constructor(db, companyId) { this.db = db; this.companyId = companyId; }

  async read() {
    const rows = await this.db.query(
      `SELECT revision, document FROM ${table(this.db.namespace, 'graph_state')} WHERE company_id = $1`,
      [this.companyId],
    );
    const row = rows[0];
    if (!row) return null;
    const state = typeof row.document === 'string' ? JSON.parse(row.document) : row.document;
    if (Number(row.revision) !== state.revision) throw new Error('Graph state revision mismatch');
    return state;
  }

  async write(state, expectedRevision) {
    if (state.revision !== expectedRevision + 1) throw new Error('Graph state revision must advance by one');
    const payload = JSON.stringify(state);
    if (expectedRevision === 0) {
      const inserted = await this.db.execute(
        `INSERT INTO ${table(this.db.namespace, 'graph_state')} (company_id, revision, document)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id) DO NOTHING`,
        [this.companyId, state.revision, payload],
      );
      if (inserted.rowCount === 1) return;
    } else {
      const updated = await this.db.execute(
        `UPDATE ${table(this.db.namespace, 'graph_state')}
         SET revision = $2, document = $3::jsonb, updated_at = now()
         WHERE company_id = $1 AND revision = $4`,
        [this.companyId, state.revision, payload, expectedRevision],
      );
      if (updated.rowCount === 1) return;
    }
    throw new RevisionConflict();
  }
}

export async function listGraphCompanies(db) {
  const rows = await db.query(`SELECT company_id FROM ${table(db.namespace, 'graph_state')}`);
  return rows.map((row) => field(row, 'company_id', 'companyId')).filter((id) => typeof id === 'string' && id);
}

export async function getGraphConfig(db, companyId) {
  const rows = await db.query(
    `SELECT role_bindings, user_roles, default_mode FROM ${table(db.namespace, 'graph_config')} WHERE company_id = $1`,
    [companyId],
  );
  const row = rows[0];
  return row ? {
    roleBindings: typeof field(row, 'role_bindings', 'roleBindings') === 'string' ? JSON.parse(field(row, 'role_bindings', 'roleBindings')) : field(row, 'role_bindings', 'roleBindings'),
    userRoles: typeof field(row, 'user_roles', 'userRoles') === 'string' ? JSON.parse(field(row, 'user_roles', 'userRoles')) : field(row, 'user_roles', 'userRoles'),
    defaultMode: field(row, 'default_mode', 'defaultMode') ?? 'manual',
  } : { roleBindings: {}, userRoles: {}, defaultMode: 'manual' };
}

export async function setGraphConfig(db, companyId, config) {
  await db.execute(
    `INSERT INTO ${table(db.namespace, 'graph_config')} (company_id, role_bindings, user_roles, default_mode)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (company_id) DO UPDATE SET role_bindings = EXCLUDED.role_bindings,
       user_roles = EXCLUDED.user_roles, default_mode = EXCLUDED.default_mode, updated_at = now()`,
    [companyId, JSON.stringify(config.roleBindings), JSON.stringify(config.userRoles), config.defaultMode ?? 'manual'],
  );
}

export async function getChannelConfig(db, companyId) {
  const rows = await db.query(`SELECT settings FROM ${table(db.namespace, 'graph_channel_config')} WHERE company_id=$1`, [companyId]);
  const value = rows[0]?.settings;
  return typeof value === 'string' ? JSON.parse(value) : value ?? {};
}

export async function getEvidenceProviders(db, companyId) {
  const rows = await db.query(`SELECT providers FROM ${table(db.namespace, 'graph_evidence_config')} WHERE company_id=$1`, [companyId]);
  const value = rows[0]?.providers;
  return typeof value === 'string' ? JSON.parse(value) : value ?? [];
}

export async function setEvidenceProviders(db, companyId, providers) {
  await db.execute(`INSERT INTO ${table(db.namespace, 'graph_evidence_config')} (company_id,providers)
    VALUES ($1,$2::jsonb) ON CONFLICT (company_id) DO UPDATE SET providers=EXCLUDED.providers,updated_at=now()`,
  [companyId, JSON.stringify(providers)]);
}

export async function setChannelConfig(db, companyId, settings) {
  await db.execute(`INSERT INTO ${table(db.namespace, 'graph_channel_config')} (company_id,settings)
    VALUES ($1,$2::jsonb) ON CONFLICT (company_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()`,
  [companyId, JSON.stringify(settings)]);
}

export async function listChannelConfigs(db) {
  const rows = await db.query(`SELECT company_id,settings FROM ${table(db.namespace, 'graph_channel_config')}`);
  return rows.map((row) => ({ companyId: field(row, 'company_id', 'companyId'),
    settings: typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings }));
}

export async function claimNotificationDelivery(db, companyId, notificationId, channel) {
  const result = await db.execute(`INSERT INTO ${table(db.namespace, 'graph_notification_delivery')}
    (company_id,notification_id,channel,status) VALUES ($1,$2,$3,'claimed') ON CONFLICT DO NOTHING`,
  [companyId, notificationId, channel]);
  return result.rowCount === 1;
}

export async function finishNotificationDelivery(db, companyId, notificationId, channel, result) {
  await db.execute(`UPDATE ${table(db.namespace, 'graph_notification_delivery')}
    SET status=$4,receipt=$5::jsonb,reason=$6,updated_at=now()
    WHERE company_id=$1 AND notification_id=$2 AND channel=$3 AND status='claimed'`,
  [companyId, notificationId, channel, result.status, JSON.stringify(result.receipt ?? null), result.reason ?? null]);
}

export async function listNotificationDeliveries(db, companyId) {
  const rows = await db.query(`SELECT notification_id,channel,status,receipt,reason,updated_at
    FROM ${table(db.namespace, 'graph_notification_delivery')} WHERE company_id=$1 ORDER BY updated_at DESC`, [companyId]);
  return rows.map((row) => ({ notificationId: field(row, 'notification_id', 'notificationId'),
    channel: row.channel, status: row.status, receipt: row.receipt, reason: row.reason,
    updatedAt: field(row, 'updated_at', 'updatedAt') }));
}

export async function getDispatch(db, companyId, runId, nodeId, attempt, phase) {
  const rows = await db.query(
    `SELECT issue_id, agent_id, agent_run_id, state, updated_at FROM ${table(db.namespace, 'graph_dispatch')}
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5`,
    [companyId, runId, nodeId, attempt, phase],
  );
  return dispatchRow(rows[0]);
}

export async function claimDispatch(db, companyId, runId, nodeId, attempt, phase, agentId) {
  const inserted = await db.execute(
    `INSERT INTO ${table(db.namespace, 'graph_dispatch')}
     (company_id,graph_run_id,node_id,attempt,phase,agent_id,state)
     VALUES ($1,$2,$3,$4,$5,$6,'claimed') ON CONFLICT DO NOTHING`,
    [companyId,runId,nodeId,attempt,phase,agentId],
  );
  if (inserted.rowCount === 1) return true;
  const reclaimed = await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')}
     SET updated_at=now() WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3
       AND attempt=$4 AND phase=$5 AND state='claimed' AND issue_id IS NULL
       AND updated_at < now() - interval '30 seconds'`,
    [companyId,runId,nodeId,attempt,phase],
  );
  return reclaimed.rowCount === 1;
}

export async function claimDispatchWakeup(db, companyId, runId, nodeId, attempt, phase) {
  const claimed = await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET state='waking',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5
       AND state='issued' AND issue_id IS NOT NULL AND agent_run_id IS NULL`,
    [companyId,runId,nodeId,attempt,phase],
  );
  return claimed.rowCount === 1;
}

export async function bindDispatchRunFromCheckout(db, companyId, runId, nodeId, attempt, phase, issueId, agentId, agentRunId) {
  const bound = await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET agent_run_id=$8,state='woken',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5
       AND issue_id=$6 AND agent_id=$7 AND state='waking' AND agent_run_id IS NULL`,
    [companyId,runId,nodeId,attempt,phase,issueId,agentId,agentRunId],
  );
  return bound.rowCount === 1;
}

export async function updateDispatch(db, companyId, runId, nodeId, attempt, phase, patch) {
  if (patch.issueId) await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET issue_id=$6, state='issued',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5`,
    [companyId,runId,nodeId,attempt,phase,patch.issueId],
  );
  if (patch.state === 'woken') {
    if (!patch.agentRunId) throw new Error('A confirmed Paperclip run ID is required to complete dispatch wakeup');
    const updated = await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET agent_run_id=$6,state='woken',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5
       AND state='waking' AND agent_run_id IS NULL`,
    [companyId,runId,nodeId,attempt,phase,patch.agentRunId],
    );
    if (updated.rowCount !== 1) {
      const current = await getDispatch(db, companyId, runId, nodeId, attempt, phase);
      if (current?.state !== 'woken' || current.agent_run_id !== patch.agentRunId) throw new RevisionConflict();
    }
  }
}

export async function getDispatchForIssue(db, companyId, issueId, runId, nodeId) {
  const rows = await db.query(
    `SELECT issue_id,agent_id,agent_run_id,attempt,phase,state FROM ${table(db.namespace, 'graph_dispatch')}
     WHERE company_id=$1 AND issue_id=$2 AND graph_run_id=$3 AND node_id=$4
     ORDER BY attempt DESC LIMIT 1`,
    [companyId,issueId,runId,nodeId],
  );
  return dispatchRow(rows[0]);
}

export async function getDispatchForRunIssue(db, companyId, issueId, runId) {
  const rows = await db.query(
    `SELECT issue_id,agent_id,agent_run_id,node_id,attempt,phase,state FROM ${table(db.namespace, 'graph_dispatch')}
     WHERE company_id=$1 AND issue_id=$2 AND graph_run_id=$3 LIMIT 1`,
    [companyId,issueId,runId],
  );
  return dispatchRow(rows[0]);
}
