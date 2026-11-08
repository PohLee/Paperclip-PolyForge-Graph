import { createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const clone = value => structuredClone(value);
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
// The snapshot is already company-scoped. Passing every decision avoids a brittle
// reference-key allowlist omitting a newer or Pack-specific decision link. Validators
// must scope records to the pinned run and its referenced product context themselves.
function relevantDecisions(state, _run) { return state.decisions ?? []; }

function issue(code, path, message, action) { return { code, path, message, action }; }

function normalizeResult(value) {
  if (!value || typeof value !== 'object' || typeof value.valid !== 'boolean' || !Array.isArray(value.issues)) {
    return { status: 'invalid', issues: [issue('invalid-validator-result', '$',
      'Trusted validator returned an invalid result shape', 'Update the trusted adapter to return valid plus a structured issue list')],
      validatedSubjectRefs: [] };
  }
  const issues = value.issues.filter(item => item && typeof item.code === 'string' && typeof item.path === 'string' &&
    typeof item.message === 'string' && typeof item.action === 'string').map(item => clone(item));
  if (issues.length !== value.issues.length || (value.valid && issues.length)) {
    return { status: 'invalid', issues: [issue('invalid-validator-result', '$',
      'Trusted validator returned inconsistent validity and issue fields', 'Correct the adapter result and revalidate')],
      validatedSubjectRefs: [] };
  }
  if (!value.valid && !issues.length) issues.push(issue('unexplained-validation-failure', '$',
    'Trusted validator rejected the run without an actionable issue', 'Inspect the trusted validator and revalidate'));
  const refs = value.validatedSubjectRefs ?? [];
  if (!Array.isArray(refs)) return { status: 'invalid', issues: [issue('invalid-validator-result', 'validatedSubjectRefs',
    'Trusted validator returned invalid subject references', 'Correct the adapter result and revalidate')], validatedSubjectRefs: [] };
  return { status: value.valid && !issues.length ? 'valid' : 'invalid', issues, validatedSubjectRefs: clone(refs) };
}

/** Internal bootstrap verifier. It records a sidecar attestation and never mutates Graph history. */
export function createPackRuntimeRecovery({ readSnapshot, resolveValidator, resolveOwner, finalizeValidation }) {
  if (typeof readSnapshot !== 'function' || typeof resolveValidator !== 'function' ||
      typeof resolveOwner !== 'function' || typeof finalizeValidation !== 'function') {
    throw new Error('Pack runtime recovery dependencies missing');
  }

  async function revalidate({ companyId, runId, actor: claimedActor, reason }) {
    if (typeof companyId !== 'string' || !companyId || typeof runId !== 'string' || !runId) {
      throw new Error('Company and run are required for Pack recovery');
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) {
      throw new Error('Pack recovery reason is required and must not exceed 1000 characters');
    }
    const actor = await resolveOwner({ companyId, claimedActor });
    if (!actor || actor.kind !== 'human' || !actor.id || !Array.isArray(actor.roles) || !actor.roles.includes('human-owner')) {
      throw new Error('Pack recovery requires an authenticated human owner');
    }
    const state = await readSnapshot(companyId);
    if (!state || !Number.isSafeInteger(state.revision) || !state.runs?.[runId]) throw new Error('Pinned Graph run not found');
    const run = state.runs[runId];
    const decisions = relevantDecisions(state, run);
    const sourceDigest = digest({ run, decisions });
    let identity = null, validation;
    try {
      const validator = await resolveValidator(clone(run));
      if (!validator || typeof validator.validateRun !== 'function' || !validator.identity) {
        validation = { status: 'invalid', issues: [issue('trusted-adapter-unavailable', 'pack',
          'No exact trusted validator is installed for the run’s pinned Pack release',
          'Install the matching trusted Pack adapter; do not edit the pinned run to match a newer release')],
          validatedSubjectRefs: [] };
      } else {
        identity = clone(validator.identity);
        if (identity.packId !== run.pack?.id || identity.packVersion !== run.pack?.version ||
            identity.packDigest !== digest(run.pack) ||
            identity.packId !== run.packId || identity.packVersion !== run.packVersion) {
          identity = null;
          validation = { status: 'invalid', issues: [issue('adapter-pack-mismatch', 'pack',
            'Trusted adapter identity does not match the run’s exact pinned Pack descriptor and digest',
            'Install or select a trusted adapter for this exact pinned Pack release')], validatedSubjectRefs: [] };
        } else {
          try {
            validation = normalizeResult(await validator.validateRun({ run: clone(run), decisions: clone(decisions) }));
          } catch (error) {
            validation = { status: 'invalid', issues: [issue('validator-error', '$',
              error instanceof Error ? error.message : String(error),
              'Repair the reported source or trusted validator issue, then explicitly revalidate')], validatedSubjectRefs: [] };
          }
        }
      }
    } catch (error) {
      validation = { status: 'invalid', issues: [issue('validator-resolution-error', 'pack',
        error instanceof Error ? error.message : String(error),
        'Restore the exact trusted adapter for this pinned Pack and revalidate')], validatedSubjectRefs: [] };
    }
    const committed = await finalizeValidation({ companyId, runId, expectedStateRevision: state.revision,
      sourceDigest, validation, identity, actor: clone(actor), reason: reason.trim() });
    if (!committed?.committed) throw new Error('Graph state changed during revalidation; reload and validate again');
    return { ...validation, valid: validation.status === 'valid', sourceDigest, identity, validationRevision: committed.validationRevision,
      validationToken: committed.validationToken,
      newStateRevision: committed.newStateRevision,
      previousIdentity: committed.previousIdentity ?? null };
  }

  return Object.freeze({ revalidate });
}

export { relevantDecisions as relevantPackRuntimeDecisions, digest as packRuntimeSourceDigest };
