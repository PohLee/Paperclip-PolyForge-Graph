import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, CompanyControlPlane } from '../../src/core/index.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

function fixture() {
  const store = new MemoryStore();
  const control = new CompanyControlPlane({ store, companyId: 'company-a' });
  const issues = [], comments = [{ id: 'comment-a', authorUserId: 'user-a', body: 'Please investigate this request', deletedAt: null }];
  const host = {
    manifest: { id: 'test.graph' }, db: {},
    projects: { get: async (id, companyId) => companyId === 'company-a' && id === 'project-a'
      ? { id, companyId } : null, list: async () => [] },
    goals: { list: async () => [] },
    issues: {
      get: async (id, companyId) => companyId === 'company-a' && id === 'source-a'
        ? { id, companyId, projectId: 'project-a' } : null,
      listComments: async () => comments,
      list: async ({ companyId, originId }) => issues.filter((issue) => issue.companyId === companyId && issue.originId === originId),
      create: async (input) => { const issue = { ...input, id: `issue-${issues.length + 1}` }; issues.push(issue); return issue; },
    },
  };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store, control }),
    getConfig: async () => ({ roleBindings: {}, userRoles: {}, defaultMode: 'manual' }),
    trustedActor: async (_companyId, hostActor) => ({ actor: { id: hostActor.userId,
      kind: 'human', roles: ['human-owner'], executionId: null }, isAdministrator: true }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  return { api, issues, comments };
}

test('authenticated Paperclip chat intake replays to one native issue', async () => {
  const { api, issues } = fixture();
  const request = { companyId: 'company-a', hostActor: { userId: 'user-a' }, body: {
    operation: 'create-intake', projectId: 'project-a', title: 'New request',
    sourceIssueId: 'source-a', sourceCommentId: 'comment-a', reason: 'Board request', idempotencyKey: 'message-a',
  } };
  const first = await api.command(request), replay = await api.command(request);
  assert.equal(first.intake.id, replay.intake.id);
  assert.equal(first.issueId, replay.issueId);
  assert.equal(issues.length, 1);
  assert.deepEqual(first.intake.source, { channel: 'paperclip-chat', senderId: 'user-a',
    messageId: 'comment-a', issueId: 'source-a' });
  await assert.rejects(api.command({ ...request, body: { ...request.body, title: 'Changed request' } }), /Idempotency key reused/);
});

test('intake rejects foreign project and untrusted chat author', async () => {
  const { api, comments, issues } = fixture();
  const base = { companyId: 'company-a', hostActor: { userId: 'user-a' }, body: {
    operation: 'create-intake', projectId: 'project-b', title: 'Request',
    sourceIssueId: 'source-a', sourceCommentId: 'comment-a', reason: 'Board request', idempotencyKey: 'message-b',
  } };
  await assert.rejects(api.command(base), /project not found in company/);
  comments[0].authorUserId = 'user-b';
  await assert.rejects(api.command({ ...base, body: { ...base.body, projectId: 'project-a' } }), /authenticated user/);
  assert.equal(issues.length, 0);
});

test('Agent read exposes only Shadows requested by its current authenticated execution', async () => {
  const actor = { id: 'qa-a', kind: 'agent', roles: ['adlc:qa-engineer'], executionId: 'execution-a' };
  const shadows = [
    { id: 'own', requestedBy: actor },
    { id: 'prior', requestedBy: { ...actor, executionId: 'prior-execution' } },
    { id: 'other', requestedBy: { ...actor, id: 'qa-b' } },
    { id: 'human', requestedBy: { ...actor, kind: 'human' } },
  ];
  const state = { runs: {}, control: { plans: [], shadows } };
  const host = { manifest: { id: 'test.graph' }, db: { namespace: 'plugin_test', query: async () => [] },
    agents: { list: async () => [] }, projects: { list: async () => [] }, goals: { list: async () => [] } };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({
    store: { read: async () => state }, control: { getSetup: async () => ({ enabledPacks: [] }) } }),
    getConfig: async () => ({ roleBindings: {}, defaultMode: 'manual' }),
    trustedActor: async () => ({ actor, isAdministrator: false }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const view = await api.read({ companyId: 'company-a', hostActor: {} });
  assert.deepEqual(view.control.shadows.map(item => item.id), ['own']);
  assert.equal(view.config, undefined);
  actor.executionId = null;
  assert.deepEqual((await api.read({ companyId: 'company-a', hostActor: {} })).control.shadows, []);
});
