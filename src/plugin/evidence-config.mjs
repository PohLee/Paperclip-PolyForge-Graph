import { canonicalEvidence } from '../host/evidence-provider.mjs';

const queues = new Map();
const publicProviders = providers => providers.map(({ secretRef, ...provider }) =>
  ({ ...provider, secretConfigured: Boolean(secretRef) }));

// One worker owns this store. Serialize its read/merge/write sequence so two
// independent provider additions cannot silently overwrite one another.
export async function configureEvidenceProviders({ companyId, actor, reason, requestKey,
  request, read, write, validate, engine, refresh }) {
  const prior = queues.get(companyId) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(async () => {
    const old = await read();
    const requestFingerprint = canonicalEvidence({ actor, reason, request });
    const history = await engine.listDecisions();
    const intent = history.find(entry => entry.type === 'evidence_provider_configuration' &&
      entry.status === 'approved' && entry.evidence?.[0]?.requestKey === requestKey);
    if (intent && intent.evidence[0].requestFingerprint !== requestFingerprint) {
      throw new Error('Idempotency key reused with different evidence provider request or actor');
    }
    const applied = intent && history.find(entry => entry.type === 'evidence_provider_configuration' &&
      entry.status === 'applied' && entry.supersedes === intent.id);
    if (applied) return { configured: true, providers: publicProviders(old), decisionId: applied.id, replayed: true };
    const providers = request.provider
      ? [...old.filter(item => item.id !== request.provider.id), request.provider] : request.providers;
    await validate(providers);
    if (intent && ![canonicalEvidence(intent.evidence[0].before), canonicalEvidence(intent.evidence[0].after)]
      .includes(canonicalEvidence(old))) throw new Error('Provider configuration changed after this request; submit a new choice');
    const approved = intent ?? await engine.recordDecision({ type: 'evidence_provider_configuration',
      status: 'approved', outcome: 'requested', reason, actor,
      evidence: [{ kind: 'provider_change', requestKey, requestFingerprint, before: old, after: providers }],
      idempotencyKey: `${requestKey}:evidence-config-intent` });
    await write(providers);
    await refresh();
    const result = await engine.recordDecision({ type: 'evidence_provider_configuration', status: 'applied',
      outcome: 'configured', reason, actor, supersedes: approved.id,
      evidence: [{ kind: 'provider_change', before: approved.evidence[0].before, after: providers }],
      idempotencyKey: `${requestKey}:evidence-config-result` });
    return { configured: true, providers: publicProviders(providers), decisionId: result.id, replayed: false };
  });
  queues.set(companyId, operation);
  try { return await operation; }
  finally { if (queues.get(companyId) === operation) queues.delete(companyId); }
}

export function providerConfiguration(value) {
  if (!value || typeof value !== 'object') throw new Error('Evidence provider configuration is required');
  const allowed = ['id', 'companyId', 'kinds', 'projectIds', 'maxAgeSeconds', 'enabled', 'secretRef'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown evidence provider configuration field');
  if (value.secretRef && Object.keys(value.secretRef).some(key => !['type', 'secretId', 'version'].includes(key))) {
    throw new Error('Only a Paperclip secret reference may be stored');
  }
  return structuredClone(value);
}
