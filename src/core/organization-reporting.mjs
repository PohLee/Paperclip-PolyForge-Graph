import { canonical } from './canonical.mjs';

const packReferences = (packs) => packs.map(({ packId, version }) => ({ packId, version }))
  .sort((left, right) => left.packId.localeCompare(right.packId) || left.version.localeCompare(right.version));
const targetReferences = (assignments) => assignments.map(({ roleId, agentId, toReportsTo }) =>
  canonical([roleId, agentId, toReportsTo])).sort();
const evidenceOf = (decision, kind) => decision?.evidence?.find((item) => item.kind === kind);

function setupReference(setup, pack) {
  const ceoId = setup?.organization?.ceo?.id ?? null;
  if (pack) return { ceoId };
  const domainHeadIds = [...new Set((setup?.organization?.domainHeads ?? []).map((head) => head.agentId))].sort();
  return { ceoId, domainHeadIds, enabledPacks: packReferences(setup?.enabledPacks ?? []) };
}

const reportingType = (pack) => pack ? 'adlc_reporting' : 'company_reporting';
const reportingScope = (companyId, pack, setup) => pack ? { companyId, packId: pack.id, packVersion: pack.version } :
  { companyId, enabledPacks: packReferences(setup?.enabledPacks ?? []) };
const sameIdentity = (item, { type, issueId, actor }) => item?.type === type && item.runId == null &&
  (item.issueId ?? null) === issueId && item.actor?.id === actor.id && item.actor?.kind === actor.kind;

function evidenceScope({ companyId, enabledPacks, packId, packVersion }) {
  return Array.isArray(enabledPacks) ? { companyId, enabledPacks: packReferences(enabledPacks) } :
    { companyId, packId, packVersion };
}

function evidenceReference(evidence) {
  if (!Array.isArray(evidence?.assignments)) return null;
  return { ...evidenceScope(evidence), targets: targetReferences(evidence.assignments) };
}

function requestIdentity({ type, status, outcome, reason, actor, issueId, supersedes, evidence }) {
  const organization = evidenceOf({ evidence }, status === 'applied' ? 'organization_result' : 'organization_plan');
  return { reportingRequestVersion: 1, type, status, outcome, reason, actor, issueId: issueId ?? null,
    supersedes: supersedes ?? null, reporting: evidenceReference(organization),
    conflicts: organization?.conflicts?.map((conflict) => canonical(conflict)).sort() ?? [] };
}

export function requireReportingIntent(decisions, { actor, companyId, issueId, pack, setup, planDecisionId }) {
  const intent = decisions.find((item) => item.id === planDecisionId);
  const recorded = evidenceOf(intent, 'organization_plan');
  // Legacy company records do not identify the enabled releases and cannot be reused.
  if (!sameIdentity(intent, { type: reportingType(pack), actor, issueId }) || intent.status !== 'approved' ||
      !recorded || canonical(evidenceScope(recorded)) !== canonical(reportingScope(companyId, pack, setup))) {
    throw new Error(pack ? 'Reporting plan is missing, stale, or belongs to another actor' :
      'Reporting plan belongs to another actor or company, or its enabled Pack scope is stale');
  }
  return intent;
}

/** Resolve a reporting request against the snapshot that will be committed. */
export function recordReportingDecision(state, { actor, companyId, issueId, pack, setup, plan, planDecisionId,
  reason, idempotencyKey }, append) {
  const type = reportingType(pack);
  const reference = setupReference(setup, pack);
  if ((state.control?.companyId && state.control.companyId !== companyId) ||
      canonical(setupReference(state.control, pack)) !== canonical(reference)) {
    throw new Error('Company organization setup changed while checking reporting; retry the plan');
  }
  const scope = reportingScope(companyId, pack, setup);
  const identityScope = { type, issueId, actor };
  const confirming = planDecisionId != null;
  const evidence = confirming ? { kind: 'organization_result', ...scope, assignments: plan.assignments } :
    { kind: 'organization_plan', ...scope, assignments: plan.assignments, conflicts: plan.conflicts };
  const target = canonical(evidenceReference(evidence));
  const hasTarget = (item, kind) => canonical(evidenceReference(evidenceOf(item, kind))) === target;
  const status = confirming ? 'applied' : plan.conflicts.length ? 'blocked' : 'approved';
  const outcome = confirming ? 'aligned' : plan.conflicts.length ? 'custom_manager_conflict' : 'requested';
  const results = state.decisions.filter((item) => item.type === type && item.runId == null && item.status === 'applied');
  const settled = new Set(results.map((item) => item.supersedes));
  const matchesResult = (item) => sameIdentity(item, identityScope) && item.status === 'applied' &&
    item.supersedes === planDecisionId && item.outcome === outcome && hasTarget(item, 'organization_result');
  const mismatch = pack ? 'Reporting changes are incomplete or managed identities changed; retry the plan' :
    'Native Paperclip reporting links do not match the approved plan';
  let existing;

  if (confirming) {
    const intent = requireReportingIntent(state.decisions, { actor, companyId, issueId, pack, setup, planDecisionId });
    if (plan.conflicts.length || plan.changes.length || !hasTarget(intent, 'organization_plan')) throw new Error(mismatch);
    if (pack) reason = intent.reason;
    existing = results.findLast((item) => item.supersedes === planDecisionId);
    if (existing && !matchesResult(existing)) {
      throw new Error('Recorded reporting confirmation is stale; retry the plan');
    }
  } else if (status === 'approved') {
    existing = state.decisions.findLast((item) => sameIdentity(item, identityScope) && item.status === status &&
      !settled.has(item.id) && hasTarget(item, 'organization_plan'));
  }

  const details = { actor, type, issueId, status, outcome, reason, supersedes: planDecisionId, evidence: [evidence] };
  const suffix = confirming ? (pack ? 'result' : 'reporting-confirm') : (pack ? 'intent' : 'reporting-plan');
  const key = idempotencyKey && `decision:${idempotencyKey}:${suffix}`;
  const identity = canonical(requestIdentity(details));
  const saved = key && Object.hasOwn(state.idempotency, key) ? state.idempotency[key] : null;
  if (saved) {
    const previous = JSON.parse(saved.fingerprint);
    const previousIdentity = canonical(previous.reportingRequestVersion === 1 ? previous : requestIdentity(previous));
    if (previousIdentity !== identity) throw new Error('Idempotency key reused with different request or actor');
    const original = state.decisions.find((item) => item.id === saved.result.id);
    if (confirming ? !matchesResult(original) : (!sameIdentity(original, identityScope) || original.status !== status ||
        !hasTarget(original, 'organization_plan') || (settled.has(original.id) && plan.changes.length))) {
      throw new Error('Recorded reporting request is stale; retry with a new request');
    }
    return { record: original, resumed: !confirming && status === 'approved' };
  }

  const record = existing ?? append(details);
  if (key) state.idempotency[key] = { fingerprint: identity, result: structuredClone(record) };
  return { record, resumed: !confirming && Boolean(existing) };
}
