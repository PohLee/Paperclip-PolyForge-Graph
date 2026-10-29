import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryStore, CompanyControlPlane } from '../../src/core/index.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';
import { canonicalEvidence } from '../../src/host/evidence-provider.mjs';

test('host imports only a signed, company-scoped provider receipt', async () => {
  const secret = 'test-provider-secret-value';
  const provider = { id: 'provider-a', companyId: 'company-a', kinds: ['metric'],
    secretRef: { type: 'secret_ref', secretId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } };
  const store = new MemoryStore();
  const control = new CompanyControlPlane({ store, companyId: 'company-a', trustedProviders: [provider.id] });
  const host = { manifest: { id: 'test.graph' }, db: {},
    projects: { get: async (id, companyId) => id === 'project-a' && companyId === 'company-a' ? { id } : null },
    secrets: { resolve: async () => secret } };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store, control }),
    getConfig: async () => ({ roleBindings: {}, userRoles: {}, defaultMode: 'manual' }),
    trustedActor: async () => ({ actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'], executionId: null },
      isAdministrator: true }), capabilitiesFor: async () => ({ 'sourced-metrics': '1.0.0' }),
    getEvidenceProviders: async () => [provider] });
  const now = Date.now();
  const receipt = { id: 'receipt-a', providerId: provider.id, companyId: 'company-a', projectId: 'project-a',
    kind: 'metric', issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    subjectRefs: [{ id: 'source-a', version: 'v1' }],
    data: { goalRevisionId: 'revision-a', goalId: 'goal-a', keyResultId: 'kr-a', source: 'analytics',
      window: 'weekly', value: 12, observedAt: new Date(now - 90_000).toISOString() } };
  const signature = createHmac('sha256', secret).update(canonicalEvidence(receipt)).digest('hex');
  const call = (body) => api.command({ companyId: 'company-a', hostActor: { actorType: 'user', userId: 'owner-a' },
    body: { operation: 'import-evidence', projectId: 'project-a', reason: 'Verified analytics receipt',
      idempotencyKey: 'receipt-a', ...body } });
  const result = await call({ receipt, signature });
  assert.equal(result.receipt.verification.providerId, provider.id);
  assert.equal((await store.read()).control.evidenceReceipts.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replay = await call({ receipt, signature });
  assert.deepEqual(replay, result);
  assert.equal((await store.read()).control.evidenceReceipts.length, 1);
  await assert.rejects(call({ receipt: { ...receipt, companyId: 'company-b' }, signature }), /company\/project mismatch/);
  await assert.rejects(call({ receipt: { ...receipt, data: { ...receipt.data, value: 999 } }, signature }), /signature verification failed/);
});
