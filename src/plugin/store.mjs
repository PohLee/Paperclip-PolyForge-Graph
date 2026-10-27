import { RevisionConflict } from '../core/index.mjs';

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

export async function updateDispatch(db, companyId, runId, nodeId, attempt, phase, patch) {
  if (patch.issueId) await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET issue_id=$6, state='issued',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5`,
    [companyId,runId,nodeId,attempt,phase,patch.issueId],
  );
  if (patch.state === 'woken') await db.execute(
    `UPDATE ${table(db.namespace, 'graph_dispatch')} SET agent_run_id=$6,state='woken',updated_at=now()
     WHERE company_id=$1 AND graph_run_id=$2 AND node_id=$3 AND attempt=$4 AND phase=$5`,
    [companyId,runId,nodeId,attempt,phase,patch.agentRunId ?? null],
  );
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
