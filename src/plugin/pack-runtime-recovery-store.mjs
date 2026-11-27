import { randomUUID } from 'node:crypto';

function table(namespace, name) {
  if (!/^plugin_[a-z0-9_]+$/.test(namespace)) throw new Error('Invalid host database namespace');
  return `${namespace}.${name}`;
}

function json(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Pack runtime validation fields must be JSON values');
  return encoded;
}

function runtimeIdentity(value) {
  if (!value || typeof value !== 'object' || !['packId', 'packVersion', 'packDigest', 'adapterId', 'adapterVersion', 'adapterBundleDigest']
    .every(key => typeof value[key] === 'string' && value[key])) throw new Error('Trusted Pack runtime identity is invalid');
  return value;
}

function field(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function validationRow(row) {
  if (!row) return null;
  return {
    revision: Number(field(row, 'validation_revision', 'validationRevision')),
    validationToken: field(row, 'validation_token', 'validationToken'),
    status: row.status,
    valid: row.status === 'valid',
    sourceGraphRevision: Number(field(row, 'source_graph_revision', 'sourceGraphRevision')),
    sourceDigest: field(row, 'source_digest', 'sourceDigest'),
    identity: field(row, 'adapter_identity', 'adapterIdentity') ?? null,
    previousIdentity: field(row, 'previous_identity', 'previousIdentity') ?? null,
    actor: row.actor,
    reason: row.reason,
    issues: row.issues ?? [],
    validatedSubjectRefs: field(row, 'validated_subject_refs', 'validatedSubjectRefs') ?? [],
    createdAt: field(row, 'created_at', 'createdAt'),
  };
}

/**
 * Claim the observed Graph state revision before logging the validation and rebinding.
 * An unlogged token blocks the run. A valid log with a changed identity still blocks
 * until the runtime pin matches. Revalidation on the current revision repairs either case.
 */
export async function finalizePackRuntimeValidation(db, { companyId, runId, expectedStateRevision,
  sourceDigest, validation, identity = null, actor, reason }) {
  if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) throw new Error('Expected Graph state revision is invalid');
  if (typeof sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) throw new Error('Pack validation source digest is invalid');
  if (!validation || !['valid', 'invalid'].includes(validation.status) || !Array.isArray(validation.issues) ||
      !Array.isArray(validation.validatedSubjectRefs)) throw new Error('Pack validation result is invalid');
  if (validation.status === 'valid') {
    if (validation.issues.length || !identity) throw new Error('A valid Pack validation needs a trusted identity and no issues');
    runtimeIdentity(identity);
  }
  if (!actor || typeof actor.id !== 'string' || actor.kind !== 'human' || !Array.isArray(actor.roles) || !actor.roles.includes('human-owner')) {
    throw new Error('Pack validation audit requires an authenticated human owner');
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) throw new Error('Pack validation reason is invalid');

  const stateTable = table(db.namespace, 'graph_state');
  const auditTable = table(db.namespace, 'graph_pack_runtime_validation');
  const runtimeTable = table(db.namespace, 'graph_pack_runtime');
  const validationToken = randomUUID();
  const identityJson = identity ? json(runtimeIdentity(identity)) : null;
  const actorJson = json(actor);
  const issuesJson = json(validation.issues);
  const refsJson = json(validation.validatedSubjectRefs);

  const claim = await db.execute(`UPDATE ${stateTable} SET
      revision=revision+1,
      document=jsonb_set(
        jsonb_set(document, ARRAY['revision'], to_jsonb(revision+1), true),
        ARRAY['runs',$2,'hostValidationId'], to_jsonb($4::text), true),
      updated_at=now()
    WHERE company_id=$1 AND revision=$3::bigint AND document #> ARRAY['runs',$2] IS NOT NULL`,
    [companyId, runId, expectedStateRevision, validationToken]);
  if (claim.rowCount !== 1) return { committed: false };

  const logged = await db.execute(`INSERT INTO ${auditTable}
      (company_id,graph_run_id,validation_revision,validation_token,status,source_graph_revision,source_digest,
       adapter_identity,previous_identity,actor,reason,issues,validated_subject_refs)
    SELECT $1,$2,
      COALESCE((SELECT MAX(v.validation_revision) FROM ${auditTable} v
        WHERE v.company_id=$1 AND v.graph_run_id=$2),0)+1,
      $5::uuid,$6,$3::bigint,$4,$7::jsonb,
      (SELECT jsonb_build_object('packId',r.pack_id,'packVersion',r.pack_version,'packDigest',r.pack_digest,
        'adapterId',r.adapter_id,'adapterVersion',r.adapter_version,'adapterBundleDigest',r.adapter_bundle_digest)
        FROM ${runtimeTable} r WHERE r.company_id=$1 AND r.graph_run_id=$2),
      $8::jsonb,$9,$10::jsonb,$11::jsonb
    WHERE EXISTS (SELECT 1 FROM ${stateTable}
      WHERE company_id=$1 AND revision=$3::bigint+1
        AND document #>> ARRAY['runs',$2,'hostValidationId']=$5::uuid::text)`,
    [companyId, runId, expectedStateRevision, sourceDigest, validationToken, validation.status, identityJson,
      actorJson, reason.trim(), issuesJson, refsJson]);
  if (logged.rowCount !== 1) return { committed: false };

  let rebound = false;
  if (validation.status === 'valid') {
    const result = await db.execute(`INSERT INTO ${runtimeTable}
        (company_id,graph_run_id,pack_id,pack_version,pack_digest,adapter_id,adapter_version,adapter_bundle_digest)
      SELECT $1,$2,$4,$5,$6,$7,$8,$9
      WHERE EXISTS (SELECT 1 FROM ${auditTable}
        WHERE company_id=$1 AND graph_run_id=$2 AND validation_token=$3::uuid AND status='valid')
      ON CONFLICT (company_id,graph_run_id) DO UPDATE SET
        pack_id=EXCLUDED.pack_id,pack_version=EXCLUDED.pack_version,pack_digest=EXCLUDED.pack_digest,
        adapter_id=EXCLUDED.adapter_id,adapter_version=EXCLUDED.adapter_version,
        adapter_bundle_digest=EXCLUDED.adapter_bundle_digest,created_at=now()`,
      [companyId, runId, validationToken, identity.packId, identity.packVersion, identity.packDigest,
        identity.adapterId, identity.adapterVersion, identity.adapterBundleDigest]);
    rebound = result.rowCount === 1;
  }

  const rows = await db.query(`SELECT validation_revision,validation_token,status,source_graph_revision,source_digest,
      adapter_identity,previous_identity,actor,reason,issues,validated_subject_refs,created_at
    FROM ${auditTable} WHERE company_id=$1 AND graph_run_id=$2 AND validation_token=$3::uuid`,
    [companyId, runId, validationToken]);
  const saved = validationRow(rows[0]);
  if (!saved) return { committed: false };
  return { committed: true, validationRevision: saved.revision, previousIdentity: saved.previousIdentity,
    validationToken: saved.validationToken, newStateRevision: saved.sourceGraphRevision + 1,
    validation: saved, rebound };
}

export async function getLatestPackRuntimeValidation(db, companyId, runId) {
  const rows = await db.query(`SELECT validation_revision,validation_token,status,source_graph_revision,source_digest,
      adapter_identity,previous_identity,actor,reason,issues,validated_subject_refs,created_at
    FROM ${table(db.namespace, 'graph_pack_runtime_validation')}
    WHERE company_id=$1 AND graph_run_id=$2 ORDER BY validation_revision DESC LIMIT 1`, [companyId, runId]);
  return validationRow(rows[0]);
}
