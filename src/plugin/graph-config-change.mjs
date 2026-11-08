import { randomUUID } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const equal = (left, right) => canonical(left) === canonical(right);

/** Owns the intent, compare-and-set write, replay, and applied Decision Record. */
export async function applyGraphConfigChange({ companyId, db, engine, actor, reason, idempotencyKey,
  type, kind, patch, context = {}, getConfig, compareAndSet, setConfig, expectedRevision }) {
  const requestKey = idempotencyKey ?? randomUUID();
  const history = await engine.listDecisions();
  const prior = history.find((entry) => entry.type === type && entry.status === 'approved' &&
    entry.evidence?.[0]?.requestKey === requestKey);
  if (prior && (prior.actor?.id !== actor.id || prior.reason !== reason ||
      !equal(prior.evidence[0].patch, patch))) throw new Error('Idempotency key reused with different request or actor');
  const applied = prior && history.find((entry) => entry.type === type && entry.status === 'applied' &&
    entry.supersedes === prior.id);
  if (applied) return { config: await getConfig(db, companyId), decisionId: applied.id, replayed: true };

  const initial = await getConfig(db, companyId);
  if (!prior && expectedRevision !== undefined && expectedRevision !== (initial.revision ?? 0)) {
    throw new Error('Settings changed since you opened this page. Reload settings before saving.');
  }
  const before = prior?.evidence?.[0]?.before ?? Object.fromEntries(Object.keys(patch)
    .map((key) => [key, initial[key]]));
  const intent = prior ?? await engine.recordDecision({ type, status: 'approved', outcome: 'requested',
    reason, actor, evidence: [{ kind, companyId, requestKey, patch, before, after: patch, ...context }],
    idempotencyKey: `${requestKey}:${type}:intent` });
  let written = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await getConfig(db, companyId);
    for (const [key, requested] of Object.entries(patch)) {
      if (!equal(current[key], before[key]) && !equal(current[key], requested)) {
        throw new Error('Graph configuration changed after this request; submit a new choice');
      }
    }
    const next = { ...current, ...patch };
    if (Object.keys(patch).every((key) => equal(current[key], patch[key]))) { written = true; break; }
    if (compareAndSet) {
      if (await compareAndSet(db, companyId, current.revision ?? 0, next)) { written = true; break; }
    } else {
      await setConfig(db, companyId, next);
      written = true; break;
    }
  }
  if (!written) throw new Error('Graph configuration changed during update; retry the request');
  const result = await engine.recordDecision({ type, status: 'applied', outcome: patch.defaultMode ?? 'updated',
    reason, actor, supersedes: intent.id,
    evidence: [{ kind, companyId, requestKey, patch, before, after: patch, ...context }],
    idempotencyKey: `${requestKey}:${type}:result` });
  return { config: await getConfig(db, companyId), decisionId: result.id, replayed: false };
}
