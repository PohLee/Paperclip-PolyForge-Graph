import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, CompanyControlPlane, GraphEngine } from '../../src/core/index.mjs';
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

test('company Decision read reuses its card and rejects an untrusted resolver without changing Core', async () => {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const control = new CompanyControlPlane({ store, companyId: 'company-a' });
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const escalation = await control.escalateDecision({ subjectType: 'strategy',
    subjectId: 'project-a', question: 'Change strategy?',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    actor: owner, reason: 'Needs a decision' });
  const issues = [], cards = [];
  let resolver = owner;
  const host = { manifest: { id: 'test.graph' }, db: { namespace: 'plugin_test', query: async () => [] },
    agents: { list: async () => [] }, projects: { list: async () => [] }, goals: { list: async () => [] },
    issues: {
      list: async ({ originId }) => issues.filter((item) => item.originId === originId),
      create: async (input) => { const issue = { ...input, id: 'issue-decision' }; issues.push(issue); return issue; },
      listInteractions: async () => cards,
      askUserQuestions: async (_issueId, spec) => {
        assert.equal(spec.resolverPolicy, 'human_only');
        assert.equal(spec.continuationPolicy, 'none');
        const card = { id: 'card-decision', status: 'pending', idempotencyKey: spec.idempotencyKey };
        cards.push(card); return card;
      },
    },
  };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store, engine, control }),
    getConfig: async () => ({ roleBindings: {}, userRoles: {}, defaultMode: 'manual' }),
    trustedActor: async (_companyId, hostActor) => ({ actor: hostActor.userId === 'viewer' ? owner : resolver,
      isAdministrator: true }), capabilitiesFor: async () => ({}),
    getEvidenceProviders: async () => [] });
  const read = () => api.read({ companyId: 'company-a', hostActor: { userId: 'viewer' } });
  await read(); await read();
  assert.equal(issues.length, 1);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].idempotencyKey, `polyforge-decision:${escalation.id}`);
  cards[0].status = 'resolved'; cards[0].resolvedByUserId = 'intruder';
  cards[0].result = { answers: [{ questionId: 'choice', optionIds: ['yes'] },
    { questionId: 'reason', otherText: 'Untrusted' }] };
  resolver = { id: 'intruder', kind: 'human', roles: [] };
  const rejected = await read();
  assert.match(rejected.nativeDecisionError, /human owner/);
  assert.equal((await control.getSetup()).organization, null);
  assert.equal((await store.read()).control.escalations.find((item) => item.id === escalation.id).status, 'pending');
  resolver = owner; cards[0].resolvedByUserId = 'owner';
  const accepted = await read();
  assert.equal(accepted.nativeDecisionError, null);
  const resolved = (await store.read()).control.escalations.find((item) => item.id === escalation.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolutionEvidence.find((item) => item.kind === 'paperclip_decision').interactionId,
    'card-decision');
  await read();
  assert.equal(cards.length, 1);
  assert.equal((await store.read()).control.audit.filter((item) => item.kind === 'decision.adjudicated').length, 1);
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
    store: { read: async () => state }, control: { getSetup: async () => ({ enabledPacks: [] }),
      readReconciledWorkPlans: async () => state, getTemporaryAgentPolicy: async () => ({enabled:false}) } }),
    getConfig: async () => ({ roleBindings: {}, defaultMode: 'manual' }),
    trustedActor: async () => ({ actor, isAdministrator: false }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const view = await api.read({ companyId: 'company-a', hostActor: {} });
  assert.deepEqual(view.control.shadows.map(item => item.id), ['own']);
  assert.equal(view.config, undefined);
  actor.executionId = null;
  assert.deepEqual((await api.read({ companyId: 'company-a', hostActor: {} })).control.shadows, []);
});

test('agent knowledge includes only dispatched run decisions and dashboard runs use starter identity', async () => {
  const agent = { id: 'agent-a', kind: 'agent', roles: [], executionId: 'exec' };
  let actor = agent;
  const state = { runs: {
    own: { id: 'own', startedBy: agent, packId: 'p', status: 'running', input: { projectId: 'one' } },
    other: { id: 'other', startedBy: { id: 'agent-b', kind: 'agent' }, packId: 'p', status: 'running', input: { projectId: 'two' } },
    human: { id: 'human', startedBy: { id: 'agent-a', kind: 'human' }, packId: 'p', status: 'running' },
  }, decisions: [{ id: 'allowed', runId: 'own', type: 'decision', reason: 'own' },
    { id: 'other', runId: 'other', type: 'decision', reason: 'other' },
    { id: 'standalone', type: 'product', reason: 'standalone' }], control: { plans: [] } };
  const db = { namespace: 'plugin_test', query: async (sql, params) => {
    if (sql.includes('graph_dispatch')) { assert.deepEqual(params, ['company-a', 'agent-a']); return [{ graph_run_id: 'own' }]; }
    return [];
  } };
  const host = { manifest: { id: 'test.graph' }, db, agents: { list: async () => [] },
    projects: { list: async () => [] }, goals: { list: async () => [] } };
  const control = { queryKnowledge: async () => [{ id: 'manual' },
    { id: 'own-lesson', kind: 'run-lesson', projectId: 'one' }, { id: 'other-lesson', kind: 'run-lesson', projectId: 'two' }],
    getSetup: async () => ({ enabledPacks: [] }),
    readReconciledWorkPlans: async () => state, getTemporaryAgentPolicy: async () => ({ enabled: false }),
    getShadowPolicy: async () => ({}) };
  const api = createCompanyApi({ host, catalog: () => [], engineFor: async () => ({ store: { read: async () => state }, control }),
    getConfig: async () => ({ roleBindings: {}, defaultMode: 'manual' }), trustedActor: async () => ({ actor, isAdministrator: false }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const command = () => api.command({ companyId: 'company-a', hostActor: {}, body: { operation: 'query-knowledge', reason: 'Search', idempotencyKey: 'q' } });
  assert.deepEqual((await command()).map(item => item.id), ['manual', 'own-lesson', 'allowed']);
  assert.deepEqual((await api.read({ companyId: 'company-a', hostActor: {} })).runs.map(item => item.id), ['own']);
  actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  assert.deepEqual((await command()).map(item => item.id), ['manual', 'own-lesson', 'other-lesson', 'allowed', 'other', 'standalone']);
});

test('company escalation requires a bound CEO or domain head', async () => {
  let actor = { id: 'ceo', kind: 'agent', roles: [], executionId: 'exec' };
  const organization = { ceo: { id: 'ceo' }, domainHeads: [{ agentId: 'head' }] };
  let binding = 'other';
  const control = { getSetup: async () => ({ organization }), escalateDecision: async args => args };
  const api = createCompanyApi({ host: { db: {}, manifest: { id: 'test' } }, catalog: () => [],
    engineFor: async () => ({ control }), getConfig: async () => ({ roleBindings: { ceo: binding } }),
    trustedActor: async () => ({ actor }), capabilitiesFor: async () => ({}) });
  const call = () => api.command({ companyId: 'a', hostActor: {}, body: { operation: 'escalate-decision',
    subjectType: 'strategy', subjectId: 's', question: 'Q?', options: [], reason: 'Reason', idempotencyKey: 'key' } });
  await assert.rejects(call(), /bound CEO/);
  binding = 'ceo'; assert.equal((await call()).actor.id, 'ceo');
  actor = { ...actor, id: 'head' }; assert.equal((await call()).actor.id, 'head');
  actor = { ...actor, id: 'worker' }; await assert.rejects(call(), /bound CEO/);
});
