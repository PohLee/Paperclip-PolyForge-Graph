import { table } from './store.mjs';

const missingFacts = new Set(['merge-sha-not-persisted', 'main-ancestry-unproven', 'github-observation-unavailable']);
const graceSeconds = 90;
const subject = row => [row.company_id, row.run_id, row.node_id, row.attempt_index, row.kind];
const operation = row => [row.repository_node_id, String(row.fence), row.operation_key];
const ownership = row => [...operation(row), row.claim_id];
const binding = row => [row.repository_node_id, row.repository_id, row.app_id, row.installation_id];
const occurrence = row => [...subject(row), row.pull_number, row.operation_key];

function decode(row) {
  for (const key of ['repository_id', 'app_id', 'installation_id', 'fence', 'authorization_revision']) {
    if (row[key] != null) row[key] = String(row[key]);
  }
  for (const key of ['publication_json', 'receipt_json']) {
    if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
  }
  return row;
}

export function createGitHubMergeJournal(db) {
  const journal = table(db.namespace, 'github_merge_journal');
  const receipts = table(db.namespace, 'github_merge_receipts');
  const queue = table(db.namespace, 'adlc_merge_requests');
  const graph = table(db.namespace, 'graph_state');
  const read = async (sql, params) => {
    try {
      return (await db.query(sql, params)).map(row => decode({ ...row }));
    } catch {
      throw new Error('github-journal-read-failed');
    }
  };
  const one = async (sql, params) => (await read(sql, params))[0];
  const cas = async (sql, params) => {
    try {
      const { rowCount } = await db.execute(sql, params);
      if (rowCount === 1) return true;
      if (rowCount === 0) return false;
    } catch {
      // Only an exact acknowledgment can grant ownership or allow a send.
    }
    throw new Error('github-journal-cas-unknown');
  };

  return {
    byRepository: repo => one(`SELECT * FROM ${journal} WHERE repository_node_id=$1`, [repo]),
    byRepositoryId: id => one(`SELECT * FROM ${journal} WHERE repository_id=$1`, [id]),
    bySubject: row => read(`SELECT * FROM ${journal}
      WHERE company_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_index=$4 AND kind=$5`, subject(row)),
    receipt: (repo, pull) => one(`SELECT * FROM ${receipts} WHERE repository_node_id=$1 AND pull_number=$2`, [repo, pull]),
    receiptByOperation: op => one(`SELECT * FROM ${receipts} WHERE operation_key=$1`, [op]),
    due: (state, limit) => read(`SELECT *,updated_at::text AS rotation FROM ${journal}
      WHERE state=$1 AND (state IN ('patched','recorded','unresolved') OR (state='intent' AND observe_after<=now()))
      ORDER BY updated_at,repository_node_id LIMIT $2`, [state, limit]),
    rotateDue: row => cas(`UPDATE ${journal} SET updated_at=clock_timestamp()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state=$4 AND updated_at=$5::timestamptz
        AND state IN ('intent','patched','recorded','unresolved')`, [...operation(row), row.state, row.rotation]),
    observationDue: row => one(`SELECT repository_node_id FROM ${journal}
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state='intent' AND observe_after<=now()`, operation(row)),

    claim: (row, leaseSeconds) => cas(`INSERT INTO ${journal}
      (repository_node_id,repository_id,app_id,installation_id,company_id,run_id,node_id,
       attempt_index,kind,pull_number,operation_key,fence,claim_id,claim_until,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,now()+$13 * interval '1 second','claimed')
      ON CONFLICT DO NOTHING`, [...binding(row), ...occurrence(row), row.claim_id, leaseSeconds]),
    takeover: (row, old, leaseSeconds) => cas(`UPDATE ${journal}
      SET company_id=$5,run_id=$6,node_id=$7,attempt_index=$8,kind=$9,pull_number=$10,operation_key=$11,
          fence=$12,claim_id=$13,claim_until=now()+$14 * interval '1 second',state='claimed',
          base_sha=NULL,head_sha=NULL,temp_ref=NULL,merge_sha=NULL,publication_json=NULL,
          authorization_revision=NULL,observe_after=NULL,missing_fact=NULL,updated_at=now()
      WHERE repository_node_id=$1 AND repository_id=$2 AND app_id=$3 AND installation_id=$4
        AND fence=$15 AND state=$16 AND (state='acked' OR (state='claimed' AND claim_until<=now()))`,
    [...binding(row), ...occurrence(row), String(BigInt(old.fence) + 1n), row.claim_id, leaseSeconds, old.fence, old.state]),
    abandon: row => cas(`UPDATE ${journal} SET claim_until=now(),updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND claim_id=$4 AND state='claimed'`, ownership(row)),
    intent: (row, publication, revision, tempRef, fingerprint) => cas(`UPDATE ${journal} AS j
      SET state='intent',base_sha=$5,head_sha=$6,temp_ref=$7,publication_json=$8::jsonb,
          authorization_revision=$9,observe_after=now()+$10 * interval '1 second',updated_at=now()
      WHERE j.repository_node_id=$1 AND j.fence=$2 AND j.operation_key=$3 AND j.claim_id=$4
        AND j.state='claimed' AND j.claim_until>now()
        AND NOT EXISTS (SELECT 1 FROM ${receipts} AS r
                        WHERE r.repository_node_id=j.repository_node_id AND r.pull_number=j.pull_number)
      ${fingerprint === undefined ? '' : `AND EXISTS (SELECT 1 FROM ${graph} AS g
        WHERE g.company_id=j.company_id AND g.revision=$9 FOR SHARE)
      AND EXISTS (SELECT 1 FROM ${queue} AS q WHERE q.company_id=j.company_id AND q.run_id=j.run_id
        AND q.node_id=j.node_id AND q.attempt_index=j.attempt_index AND q.kind=j.kind
        AND q.disposition='admitted' AND q.fingerprint=$11 FOR SHARE)`}`,
    [...ownership(row), publication.baseSha, publication.headSha, tempRef, JSON.stringify(publication), String(revision), graceSeconds,
      ...(fingerprint === undefined ? [] : [fingerprint])]),
    mergeSha: (row, sha) => cas(`UPDATE ${journal} SET merge_sha=$5,updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND claim_id=$4
        AND state='intent' AND merge_sha IS NULL`, [...ownership(row), sha]),
    patched: row => cas(`UPDATE ${journal} SET state='patched',missing_fact=NULL,updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3
        AND state=$4 AND state IN ('intent','unresolved') AND merge_sha=$5`,
    [...operation(row), row.state, row.merge_sha]),
    unresolved: (row, fact) => {
      if (!missingFacts.has(fact)) throw new Error('Invalid journal diagnostic');
      return cas(`UPDATE ${journal} SET state='unresolved',missing_fact=$4,updated_at=now()
        WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state='intent'
          AND merge_sha IS NOT DISTINCT FROM $5::text`, [...operation(row), fact, row.merge_sha]);
    },
    observedUnresolved: row => cas(`UPDATE ${journal} SET updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state='unresolved'`, operation(row)),
    insertReceipt: (row, receipt) => cas(`INSERT INTO ${receipts}
      (repository_node_id,pull_number,operation_key,company_id,run_id,receipt_json,temp_ref)
      SELECT j.repository_node_id,j.pull_number,j.operation_key,j.company_id,j.run_id,$4::jsonb,j.temp_ref
      FROM ${journal} AS j WHERE j.repository_node_id=$1 AND j.fence=$2
        AND j.operation_key=$3 AND j.state='patched' AND j.merge_sha=$5
      FOR SHARE ON CONFLICT DO NOTHING`, [...operation(row), JSON.stringify(receipt), row.merge_sha]),
    recorded: (row, receipt) => cas(`UPDATE ${journal} SET state='recorded',updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state='patched'
        AND EXISTS (SELECT 1 FROM ${receipts} AS r WHERE r.repository_node_id=$1
                    AND r.pull_number=$4 AND r.operation_key=$3 AND r.receipt_json=$5::jsonb)`,
    [...operation(row), row.pull_number, JSON.stringify(receipt)]),
    acked: (row, receipt) => cas(`UPDATE ${journal} SET state='acked',updated_at=now()
      WHERE repository_node_id=$1 AND fence=$2 AND operation_key=$3 AND state='recorded'
        AND EXISTS (SELECT 1 FROM ${queue} AS q WHERE q.company_id=$4 AND q.run_id=$5 AND q.node_id=$6
                    AND q.attempt_index=$7 AND q.kind=$8 AND q.operation_key=$3
                    AND q.execution_state='recorded' AND q.receipt_json=$9::jsonb FOR SHARE)`,
    [...operation(row), ...subject(row), JSON.stringify(receipt)]),
    pendingCleanup: limit => read(`SELECT *,cleanup_attempt_at::text AS rotation FROM ${receipts} WHERE cleanup_state='pending'
      ORDER BY cleanup_attempt_at NULLS FIRST,created_at,operation_key LIMIT $1`, [limit]),
    rotateCleanup: row => cas(`UPDATE ${receipts} SET cleanup_attempt_at=clock_timestamp()
      WHERE repository_node_id=$1 AND pull_number=$2 AND operation_key=$3 AND cleanup_state='pending'
        AND cleanup_attempt_at IS NOT DISTINCT FROM $4::timestamptz`,
    [row.repository_node_id, row.pull_number, row.operation_key, row.rotation]),
    cleanup: (row, result) => {
      if (!['complete', 'ref-changed'].includes(result)) throw new Error('Invalid cleanup result');
      return cas(`UPDATE ${receipts} SET cleanup_state=$4
        WHERE repository_node_id=$1 AND pull_number=$2 AND operation_key=$3 AND cleanup_state='pending'`,
      [row.repository_node_id, row.pull_number, row.operation_key, result]);
    },
  };
}
