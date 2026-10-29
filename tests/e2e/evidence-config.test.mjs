import test from 'node:test';
import assert from 'node:assert/strict';
import { configureEvidenceProviders, providerConfiguration } from '../../src/plugin/evidence-config.mjs';

test('provider upserts preserve peers, audit exact changes, and replay cannot undo newer configuration', async () => {
  let providers = [];
  const history = [];
  const engine = { listDecisions: async () => history,
    recordDecision: async request => { const row = { ...request, id: String(history.length + 1) }; history.push(row); return row; } };
  const provider = (id, kinds = ['metric']) => ({ id, companyId: 'company', kinds,
    projectIds: ['project'], secretRef: { type: 'secret_ref', secretId: 'stored-secret', version: 'latest' } });
  const call = (value, key) => configureEvidenceProviders({ companyId: 'company',
    actor: { id: 'owner', kind: 'human' }, reason: 'Configure measured evidence', requestKey: key,
    request: { provider: providerConfiguration(value) }, read: async () => structuredClone(providers),
    write: async next => { providers = structuredClone(next); }, validate: async () => {}, refresh: async () => {}, engine });
  await Promise.all([call(provider('a'), 'a-1'), call(provider('b'), 'b-1')]);
  assert.deepEqual(providers.map(item => item.id).sort(), ['a', 'b']);
  await call(provider('a', ['release']), 'a-2');
  const replay = await call(provider('a'), 'a-1');
  assert.equal(replay.replayed, true);
  assert.deepEqual(providers.find(item => item.id === 'a').kinds, ['release']);
  assert.equal(history.length, 6);
  assert.deepEqual(history.at(-1).evidence[0].after.find(item => item.id === 'a'), provider('a', ['release']));
  await assert.rejects(call(provider('a', ['release']), 'a-1'), /Idempotency key reused/);
  assert.throws(() => providerConfiguration({ ...provider('a'), token: 'never-record-me' }), /Unknown/);
  assert.throws(() => providerConfiguration({ ...provider('a'), secretRef: { type: 'secret_ref', value: 'never-record-me' } }), /Only a Paperclip/);
});
