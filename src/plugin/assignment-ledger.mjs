import { canonical } from '../core/canonical.mjs';

function assignmentTable(db) {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid host database namespace');
  return `${db.namespace}.graph_issue_assignment`;
}
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

export async function getAssignment(db, companyId, operationId) {
  const rows = await db.query(`SELECT operation_id,request,outcome,result,generation,retirement_owners,created_at
    FROM ${assignmentTable(db)} WHERE company_id=$1 AND operation_id=$2`, [companyId, operationId]);
  const row = rows[0];
  return row ? { ...row, request: json(row.request), result: json(row.result), retirement_owners: json(row.retirement_owners) } : null;
}

// Only a completed prior send can be reopened. A readback of an unassigned
// issue permits a new generation, but never resolves an unknown generation.
export async function beginAssignment(db, companyId, operationId, request) {
  const table = assignmentTable(db);
  const result = await db.execute(`INSERT INTO ${table} AS assignment
      (company_id,operation_id,request,outcome,generation)
    VALUES ($1,$2,$3::jsonb,'unknown',1)
    ON CONFLICT (company_id,operation_id) DO UPDATE SET
      request=$3::jsonb,outcome='unknown',result=NULL,generation=assignment.generation+1,updated_at=now()
    WHERE (assignment.request IS NULL OR (assignment.request=$3::jsonb AND assignment.outcome IN ('confirmed_success','confirmed_failure')))
      AND assignment.retirement_owners='[]'::jsonb`, [companyId, operationId, JSON.stringify(request)]);
  const current = await getAssignment(db, companyId, operationId);
  if (!current || (current.request !== null && canonical(current.request) !== canonical(request))) {
    throw new Error('Assignment operation ID reused with a different request');
  }
  return { ...current, owner: result.rowCount === 1 };
}

export async function confirmAssignment(db, companyId, operationId, generation, result, outcome = 'confirmed_success') {
  if (!['confirmed_success', 'confirmed_failure'].includes(outcome)) throw new Error('Invalid assignment outcome');
  const updated = await db.execute(`UPDATE ${assignmentTable(db)}
    SET outcome=$5,result=$4::jsonb,updated_at=now()
    WHERE company_id=$1 AND operation_id=$2 AND generation=$3 AND outcome='unknown'`,
  [companyId, operationId, generation, JSON.stringify(result), outcome]);
  if (updated.rowCount === 1) return;
  const current = await getAssignment(db, companyId, operationId);
  if (String(current?.generation) !== String(generation) || current?.outcome !== outcome ||
      canonical(current.result) !== canonical(result)) throw new Error('Assignment receipt conflicts with current generation');
}

// Additive owners fence both first assignment and reassignment. Compensation
// releases only its own owner, so it cannot undo a concurrent committed retry.
export async function retireAssignment(db, companyId, operationId, retirementOwner) {
  const table = assignmentTable(db);
  await db.execute(`INSERT INTO ${table} AS assignment
      (company_id,operation_id,outcome,retirement_owners)
    VALUES ($1,$2,'confirmed_failure',jsonb_build_array($3::text))
    ON CONFLICT (company_id,operation_id) DO UPDATE SET
      retirement_owners=assignment.retirement_owners || jsonb_build_array($3::text),updated_at=now()
    WHERE NOT (assignment.retirement_owners ? $3::text)`, [companyId, operationId, retirementOwner]);
  const current = await getAssignment(db, companyId, operationId);
  return { ...current, inserted: current?.retirement_owners?.includes(retirementOwner) === true };
}

export async function cancelAssignmentRetirements(db, companyId, operationIds, retirementOwner) {
  if (!operationIds.length) return;
  const table = assignmentTable(db);
  await db.execute(`UPDATE ${table} SET retirement_owners=retirement_owners - $3::text,updated_at=now()
    WHERE company_id=$1 AND operation_id IN (SELECT jsonb_array_elements_text($2::jsonb))
      AND retirement_owners ? $3::text`, [companyId, JSON.stringify(operationIds), retirementOwner]);
  // Keep all sent records, including unknown outcomes, after releasing owners.
  await db.execute(`DELETE FROM ${table}
    WHERE company_id=$1 AND operation_id IN (SELECT jsonb_array_elements_text($2::jsonb))
      AND request IS NULL AND retirement_owners='[]'::jsonb`, [companyId, JSON.stringify(operationIds)]);
}


export async function listAssignmentRetirements(db, companyId, retryPrefix) {
  const rows = await db.query(`SELECT operation_id,retirement_owners FROM ${assignmentTable(db)}
    WHERE company_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(retirement_owners) AS owner(value)
      WHERE starts_with(owner.value,$2))`, [companyId, retryPrefix]);
  return rows.flatMap(row => json(row.retirement_owners).filter(owner => owner.startsWith(retryPrefix))
    .map(owner => ({ operationId: row.operation_id, retirementOwner: owner, kind: 'assignment', inserted: true })));
}
