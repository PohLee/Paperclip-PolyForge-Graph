import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

test('native goals retain Core IDs, correct levels and cancel omitted revisions', async () => {
  const records = new Map(), revisions = [], requests = new Map();
  const host = { db: {}, manifest: { id: 'test.graph' },
    goals: { list: async () => [...records.values()], get: async (id) => records.get(id) ?? null,
      create: async (input) => { const record = { ...input, id: `native-${records.size + 1}` };
        records.set(record.id, record); return record; },
      update: async (id, patch) => { const record = { ...records.get(id), ...patch };
        records.set(id, record); return record; } } };
  const store = { read: async () => ({ control: { goalHistory: revisions } }) };
  const control = { setGoals: async ({ scope, subjectId, goals, idempotencyKey }) => {
    if (requests.has(idempotencyKey)) return requests.get(idempotencyKey);
    const revision = { id: `revision-${revisions.length + 1}`, scope, subjectId, goals,
      supersedes: revisions.at(-1)?.id ?? null };
    revisions.push(revision); requests.set(idempotencyKey, revision); return revision;
  } };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store, control }),
    getConfig: async () => ({ roleBindings: {}, userRoles: {} }),
    trustedActor: async () => ({ actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, isAdministrator: true }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const call = (goals, key) => api.command({ companyId: 'company-a', hostActor: { userId: 'owner' }, body: {
    operation: 'set-goals', scope: 'company', subjectId: 'company-a', goals,
    reason: 'Board commitment', idempotencyKey: key } });
  await call([{ id: 'goal-old', title: 'Old goal', keyResults: [] }], 'goals-1');
  await call([{ id: 'goal-new', title: 'New goal', keyResults: [] }], 'goals-2');
  const old = [...records.values()].find((item) => item.description.includes('PolyForge goal: goal-old'));
  const next = [...records.values()].find((item) => item.description.includes('PolyForge goal: goal-new'));
  assert.equal(old.level, 'company');
  assert.equal(old.status, 'cancelled');
  assert.match(old.description, /superseded by revision: revision-2/);
  assert.equal(next.level, 'company');
  assert.equal(next.status, 'active');
  const replay = await call([{ id: 'goal-old', title: 'Old goal', keyResults: [] }], 'goals-1');
  assert.equal(replay.revision.id, 'revision-1');
  assert.equal(replay.projectedRevisionId, 'revision-2');
  assert.equal(records.get(old.id).status, 'cancelled');
  assert.equal(records.get(next.id).status, 'active');
});
