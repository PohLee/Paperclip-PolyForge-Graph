import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelBridge } from '../../src/plugin/channel-bridge.mjs';

const secretRef = { type: 'secret_ref', secretId: 'telegram-secret' };
const settings = { telegram: { webhookSecretRef: secretRef,
  bindings: [{ chatId: '-1', telegramUserId: '7', userId: 'owner', projectId: 'p' }] },
  paperclip: { bindings: [{ issueId: 'chat', projectId: 'p' }] }, recipients: [] };

function fixture() {
  const rows = new Map(), deliveries = new Map(), intake = [], feedback = [], issued = [], sent = [];
  const decisions = [];
  const wakeups = [], agents = new Map();
  const graphConfig = { roleBindings: {}, userRoles: {}, defaultMode: 'manual' };
  const organization = { ceo: { id: 'ceo' }, authorityPolicy: { ceoOperations: [] } };
  const state = { control: null };
  const configs = new Map([['c', structuredClone(settings)]]);
  const comments = new Map();
  const db = { namespace: 'plugin_test',
    async execute(sql, args) {
      if (sql.includes('graph_channel_intake') && sql.includes('INSERT')) {
        const [company_id, channel, source_key, fingerprint, reply_to_key] = args;
        const key = `${channel}:${source_key}`;
        if (rows.has(key)) return { rowCount: 0 };
        rows.set(key, { company_id, channel, source_key, fingerprint, reply_to_key, status: 'claimed', intake_id: null, issue_id: null });
        return { rowCount: 1 };
      }
      if (sql.includes('graph_channel_intake') && sql.includes('UPDATE')) {
        const [company, channel, source, status, intakeId, issueId] = args;
        const row = rows.get(`${channel}:${source}`);
        if (!row || row.company_id !== company || row.status !== 'claimed') return { rowCount: 0 };
        Object.assign(row, { status, intake_id: intakeId, issue_id: issueId }); return { rowCount: 1 };
      }
      if (sql.includes('graph_notification_delivery') && sql.includes('INSERT')) {
        const key = args.join(':'); if (deliveries.has(key)) return { rowCount: 0 };
        deliveries.set(key, { status: 'claimed' }); return { rowCount: 1 };
      }
      if (sql.includes('graph_notification_delivery') && sql.includes('UPDATE')) {
        const [company, id, channel, status, receipt, reason] = args;
        Object.assign(deliveries.get(`${company}:${id}:${channel}`), { status, receipt: JSON.parse(receipt), reason });
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected execute: ${sql}`);
    },
    async query(sql, args) {
      if (sql.includes('graph_channel_config'))
        return [...configs].map(([company_id, settings]) => ({ company_id, settings }));
      if (sql.includes('graph_notification_delivery')) return [...deliveries].map(([key, item]) => {
        const [company_id, notification_id, channel] = key.split(':');
        return { company_id, notification_id, channel, ...item };
      }).filter(row => row.company_id === args[0]);
      if (sql.includes('graph_config')) return [{ role_bindings: graphConfig.roleBindings,
        user_roles: graphConfig.userRoles, default_mode: graphConfig.defaultMode }];
      if (sql.includes('graph_channel_intake') && sql.includes('source_key=$3')) {
        const row = rows.get(`${args[1]}:${args[2]}`);
        return row?.company_id === args[0] ? [row] : [];
      }
      if (sql.includes('graph_channel_intake') && sql.includes('intake_id=$2'))
        return [...rows.values()].filter(r => r.company_id === args[0] && r.intake_id === args[1] && r.status === 'completed');
      throw new Error(`Unexpected query: ${sql}`);
    } };
  const control = {
    async createIntake(args) { const item = { ...args, id: `intake-${intake.length + 1}`,
      status: args.assigneeId ? 'offered' : 'ceo-review' }; intake.push(item); return item; },
    async getSetup() { return { organization }; },
    async appendFeedback(args) { feedback.push(args); return { id: `feedback-${feedback.length}` }; },
    async listNotifications() { return control.notifications ?? []; },
    async queueOutcomeReviewReminders() { return { queued: 0, skipped: 0 }; },
    trustedProviders: new Set(['fixture-provider']),
    async escalateDecision(args) { const item = { ...args, id: `escalation-${state.control.escalations.length + 1}`, status: 'pending', eligibleRole: 'ceo' }; state.control.escalations.push(item); return item; },
  };
  const host = { db, manifest: { id: 'test.graph' },
    access: { members: { list: async ({ companyId }) => companyId === 'c'
      ? [{ principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' }] : [] } },
    projects: { get: async (id, company) => company === 'c' && id === 'p' ? { id, companyId: company } : null },
    agents: { get: async (id, company) => company === 'c' ? agents.get(id) ?? null : null },
    issues: {
      get: async (id, company) => company === 'c' ? issued.find(i => i.id === id) ??
        (id === 'chat' ? { id, companyId: company, projectId: 'p' } : null) : null,
      list: async ({ companyId, originKind, originId }) => issued.filter(i => i.companyId === companyId && i.originKind === originKind && i.originId === originId),
      create: async data => { const issue = { ...data, id: `issue-${issued.length + 1}` }; issued.push(issue); return issue; },
      update: async (id, changes, company) => { const issue = issued.find(item => item.id === id && item.companyId === company);
        if (!issue) throw new Error('Issue missing'); Object.assign(issue, changes); return issue; },
      requestWakeup: async (id, company, options) => { wakeups.push({ id, company, ...options }); return { queued: true }; },
      listComments: async id => comments.get(id) ?? [],
      listAttachments: async () => [],
      createComment: async (id, body, company, options) => { sent.push({ id, body, company, options }); return { id: `comment-${sent.length}` }; },
    },
    secrets: { resolve: async ref => ref.secretId === 'telegram-secret' ? 'fixture-secret' : null },
    http: { fetch: async () => { throw new Error('External send must not occur in fixture'); } },
  };
  const engine = { listDecisions: async () => decisions,
    recordDecision: async (args) => { const item = { ...args, id: `decision-${decisions.length + 1}` }; decisions.push(item); return item; } };
  const bridge = createChannelBridge({ host, engineFor: async () => ({ control, engine, store: { read: async () => state } }),
    getConfig: async (_db, company) => configs.get(company) ?? {},
    setConfig: async (_db, company, value) => configs.set(company, value),
    trustedActor: async (company, actor) => {
      if (company !== 'c' || actor.userId !== 'owner') throw new Error('No active membership');
      return { actor: { id: 'owner', kind: 'human', roles: ['human-owner'], executionId: null }, isAdministrator: true };
    } });
  return { bridge, host, db, rows, deliveries, intake, feedback, issued, comments, sent, configs,
    control, state, decisions, agents, graphConfig, organization, wakeups };
}

function telegram(updateId = 1, messageId = 10, text = 'Build this', replyToMessageId = null) {
  return { endpointKey: 'telegram', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fixture-secret' },
    parsedBody: { update_id: updateId, message: { message_id: messageId, from: { id: 7, is_bot: false },
      chat: { id: -1 }, text, ...(replyToMessageId ? { reply_to_message: { message_id: replyToMessageId } } : {}) } } };
}

test('Telegram webhook authenticates exact human binding, deduplicates, and maps reply to intake', async () => {
  const f = fixture();
  const first = await f.bridge.handleWebhook(telegram());
  assert.equal(first.status, 'completed'); assert.equal(f.intake.length, 1);
  assert.equal(f.intake[0].description, 'Build this'); assert.equal(f.issued.length, 1);
  assert.equal((await f.bridge.handleWebhook(telegram())).status, 'duplicate');
  const reply = await f.bridge.handleWebhook(telegram(2, 11, 'Here is feedback', 10));
  assert.equal(reply.intakeId, first.intakeId); assert.equal(reply.issueId, first.issueId);
  assert.equal(f.feedback.length, 1); assert.equal(f.feedback[0].subjectId, first.intakeId);
  assert.deepEqual(f.sent[0], { id: first.issueId, body: 'Here is feedback', company: 'c', options: { actorUserId: 'owner' } });
  await assert.rejects(f.bridge.handleWebhook({ ...telegram(3, 12), headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' } }), /secret/);
  await assert.rejects(f.bridge.handleWebhook({ ...telegram(3, 12), parsedBody: { ...telegram(3, 12).parsedBody,
    message: { ...telegram(3, 12).parsedBody.message, from: { id: 8 } } } }), /binding/);
});

test('native comment event re-reads original text and author; replay and plugin relay do not create intake', async () => {
  const f = fixture();
  f.comments.set('chat', [{ id: 'comment-1', authorType: 'user', authorUserId: 'owner', body: 'Exact original\nline two' }]);
  const event = { eventType: 'issue.comment.created', companyId: 'c', entityId: 'chat', eventId: 'evt-1',
    actorType: 'user', actorId: 'owner', payload: { commentId: 'comment-1', body: 'Forged body' } };
  const first = await f.bridge.handleEvent(event);
  assert.equal(first.status, 'completed'); assert.equal(f.intake[0].description, 'Exact original\nline two');
  assert.equal((await f.bridge.handleEvent({ ...event, eventId: 'evt-2' })).status, 'duplicate');
  assert.equal((await f.bridge.handleEvent({ ...event, actorType: 'plugin' })).status, 'ignored');
  assert.equal(f.intake.length, 1);
});

test('delivery is claimed once and an ambiguous result never auto retries or marks delivered', async () => {
  const f = fixture(); let calls = 0;
  f.configs.set('c', { recipients: [{ subjectId: 'owner', channel: 'paperclip', issueId: 'chat' }] });
  f.control.notifications = [{ id: 'n', companyId: 'c', subjectId: 'owner', eventKind: 'review.due',
    ref: { goalId: 'g' }, channels: ['paperclip'] }];
  f.host.issues.createComment = async () => { calls++; throw new Error('ambiguous provider response with secret'); };
  const first = await f.bridge.deliverPending({ companyId: 'c' });
  assert.equal(first[0].status, 'unknown'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(first).includes('secret'));
  assert.deepEqual(await f.bridge.deliverPending({ companyId: 'c' }), []);
  assert.equal(f.deliveries.get('c:n:paperclip').status, 'unknown');
});

test('external delivery stays disabled without explicit host activation and makes no claim', async () => {
  const f = fixture();
  f.configs.set('c', { telegram: { botTokenSecretRef: secretRef },
    recipients: [{ subjectId: 'owner', channel: 'telegram', chatId: '-1' }] });
  f.control.notifications = [{ id: 'external', companyId: 'c', subjectId: 'owner', eventKind: 'test',
    ref: {}, channels: ['telegram'] }];
  const result = await f.bridge.deliverPending({ companyId: 'c' });
  assert.equal(result[0].status, 'disabled');
  assert.equal(f.deliveries.size, 0);
});

test('local simulation durably records Telegram and email separately without network or secret resolution', async () => {
  const f = fixture();
  f.configs.set('c', { outboundMode: 'simulate', recipients: [
    { subjectId: 'owner', channel: 'telegram', chatId: '-1' },
    { subjectId: 'owner', channel: 'email', email: 'owner@example.test' },
  ] });
  f.control.notifications = [{ id: 'local', companyId: 'c', subjectId: 'owner', eventKind: 'outcome-review.due',
    ref: { goalId: 'g' }, channels: ['telegram', 'email'] }];
  f.host.secrets.resolve = async () => { throw new Error('Simulation must not resolve provider secrets'); };
  const first = await f.bridge.deliverPending({ companyId: 'c' });
  assert.deepEqual(first.map(item => item.status), ['simulated', 'simulated']);
  assert.deepEqual(first.map(item => item.receipt.provider), ['local-simulation', 'local-simulation']);
  assert.deepEqual(await f.bridge.deliverPending({ companyId: 'c' }), []);
  assert.equal(f.deliveries.get('c:local:telegram').status, 'simulated');
  assert.equal(f.deliveries.get('c:local:email').status, 'simulated');
  const owner = { actorType: 'user', userId: 'owner' };
  const visible = await f.bridge.readDeliveries({ companyId: 'c', hostActor: owner });
  assert.equal(visible.length, 2);
  assert.ok(visible.every(item => item.status === 'simulated'));
  await assert.rejects(f.bridge.readDeliveries({ companyId: 'other', hostActor: owner }), /membership/);
});

test('strategy scan escalates only current sourced reviews and pins the reviewed goal revision', async () => {
  const f = fixture();
  const future = new Date(Date.now() + 60000).toISOString();
  f.state.control = { companyId: 'c', goalHistory: [{ id: 'revision-2', version: 2 }],
    reviews: [{ id: 'review-1', companyId: 'c', projectId: 'p', goalRevisionId: 'revision-2',
      observations: [{ status: 'observed', evidenceReceiptId: 'receipt-1' }] },
    { id: 'unknown-review', companyId: 'c', projectId: 'p', goalRevisionId: 'revision-2',
      observations: [{ status: 'unknown' }] }],
    evidenceReceipts: [{ id: 'receipt-1', receipt: { id: 'receipt-1', providerId: 'fixture-provider', expiresAt: future } }],
    escalations: [], adjustments: [] };
  const first = await f.bridge.strategyReview({ companyId: 'c' });
  assert.equal(first.length, 1);
  assert.equal(first[0].reviewId, 'review-1');
  assert.deepEqual(f.state.control.escalations[0].evidence[0], { kind: 'outcome-review', reviewId: 'review-1',
    goalRevisionId: 'revision-2', goalRevisionVersion: 2, receiptIds: ['receipt-1'] });
  assert.deepEqual(await f.bridge.strategyReview({ companyId: 'c' }), []);
});

test('channel intake assigns and wakes only the bound delegated local CEO fixture, once per source', async () => {
  const f = fixture();
  f.graphConfig.roleBindings.ceo = 'ceo';
  f.organization.authorityPolicy.ceoOperations = ['intake'];
  f.agents.set('ceo', { id: 'ceo', companyId: 'c', adapterType: 'process', status: 'idle',
    adapterConfig: { command: 'node', args: ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs'], timeoutSec: 900 },
    budgetMonthlyCents: 100, spentMonthlyCents: 0 });
  const first = await f.bridge.handleWebhook(telegram(20, 30, 'Synthetic CEO intake fixture: route product'));
  assert.equal(first.status, 'completed');
  assert.equal(f.issued[0].assigneeAgentId, 'ceo');
  assert.deepEqual(f.wakeups.map(item => item.idempotencyKey), [`polyforge-ceo:c:intake:${first.intakeId}`]);
  const replay = await f.bridge.handleWebhook(telegram(20, 30, 'Synthetic CEO intake fixture: route product'));
  assert.equal(replay.status, 'duplicate');
  assert.equal(f.wakeups.length, 1);
  f.graphConfig.roleBindings.ceo = 'different';
  const unbound = await f.bridge.handleWebhook(telegram(21, 31, 'Another request'));
  assert.equal(unbound.status, 'completed');
  assert.equal(f.issued[1].assigneeAgentId, undefined);
  assert.equal(f.wakeups.length, 1);
});

test('strategy escalation creates a CEO issue with an idempotent fixture wakeup', async () => {
  const f = fixture();
  f.graphConfig.roleBindings.ceo = 'ceo';
  f.organization.authorityPolicy.ceoOperations = ['strategy'];
  f.agents.set('ceo', { id: 'ceo', companyId: 'c', adapterType: 'process', status: 'idle',
    adapterConfig: { command: 'node', args: ['/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs'], timeoutSec: 900 },
    budgetMonthlyCents: 100, spentMonthlyCents: 0 });
  f.state.control = { companyId: 'c', goalHistory: [{ id: 'revision-1', version: 1 }],
    reviews: [{ id: 'review-1', companyId: 'c', projectId: 'p', goalRevisionId: 'revision-1',
      observations: [{ status: 'observed', evidenceReceiptId: 'receipt-1' }] }],
    evidenceReceipts: [{ id: 'receipt-1', receipt: { id: 'receipt-1', providerId: 'fixture-provider',
      expiresAt: new Date(Date.now() + 60000).toISOString() } }], escalations: [], adjustments: [] };
  const first = await f.bridge.strategyReview({ companyId: 'c' });
  assert.equal(first.length, 1);
  assert.equal(first[0].wakeup.status, 'requested');
  assert.equal(f.issued[0].originId, first[0].escalationId);
  assert.equal(f.issued[0].assigneeAgentId, 'ceo');
  assert.equal(f.wakeups[0].idempotencyKey, `polyforge-ceo:c:strategy:${first[0].escalationId}`);
  assert.deepEqual(await f.bridge.strategyReview({ companyId: 'c' }), []);
  assert.equal(f.issued.length, 1);
  assert.equal(f.wakeups[1].idempotencyKey, f.wakeups[0].idempotencyKey);
});

test('concurrent inbound delivery creates one intake and an unknown claim is never replayed', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.host.issues.create;
  f.host.issues.create = async data => { await gate; return original(data); };
  const first = f.bridge.handleWebhook(telegram());
  while (![...f.rows.values()].some(row => row.status === 'claimed')) await new Promise(resolve => setImmediate(resolve));
  const second = await f.bridge.handleWebhook(telegram());
  assert.equal(second.status, 'unknown');
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(f.intake.length, 1); assert.equal(f.issued.length, 1);
  f.host.issues.create = async () => { throw new Error('ambiguous Paperclip creation'); };
  await assert.rejects(f.bridge.handleWebhook(telegram(2, 12)), /ambiguous/);
  assert.equal((await f.bridge.handleWebhook(telegram(2, 12))).status, 'unknown');
  assert.equal(f.intake.length, 2);
});

test('native attachment provenance stays on the matching comment and foreign company is ignored', async () => {
  const f = fixture();
  f.comments.set('chat', [{ id: 'comment-1', authorType: 'user', authorUserId: 'owner', body: 'See brief' }]);
  f.host.issues.listAttachments = async () => [
    { id: 'a1', issueCommentId: 'comment-1', originalFilename: 'brief.pdf', contentType: 'application/pdf', sha256: 'digest', byteSize: 12 },
    { id: 'a2', issueCommentId: 'other', originalFilename: 'other.pdf', contentType: 'application/pdf', sha256: 'other', byteSize: 20 },
  ];
  const event = { eventType: 'issue.comment.created', companyId: 'c', entityId: 'chat', eventId: 'evt',
    actorType: 'user', actorId: 'owner', payload: { commentId: 'comment-1' } };
  await f.bridge.handleEvent(event);
  assert.deepEqual(f.intake[0].attachments, [{ kind: 'paperclip-attachment', id: 'a1',
    fileName: 'brief.pdf', mimeType: 'application/pdf', sha256: 'digest', byteSize: 12 }]);
  await assert.rejects(f.bridge.handleEvent({ ...event, companyId: 'other' }), /outside company/);
});

test('a human follow-up on the native intake issue stays attached to the same intake', async () => {
  const f = fixture();
  f.comments.set('chat', [{ id: 'initial', authorType: 'user', authorUserId: 'owner', body: 'Start task' }]);
  const event = (entityId, commentId) => ({ eventType: 'issue.comment.created', companyId: 'c', entityId,
    eventId: `event-${commentId}`, actorType: 'user', actorId: 'owner', payload: { commentId } });
  const first = await f.bridge.handleEvent(event('chat', 'initial'));
  f.comments.set(first.issueId, [{ id: 'follow-up', authorType: 'user', authorUserId: 'owner', body: '  Exact follow-up  ' }]);
  const reply = await f.bridge.handleEvent(event(first.issueId, 'follow-up'));
  assert.equal(reply.intakeId, first.intakeId);
  assert.equal(f.feedback[0].body, '  Exact follow-up  ');
  assert.equal(f.feedback[0].subjectId, first.intakeId);
  assert.equal(f.intake.length, 1);
});

test('only a company administrator may configure channel identities; secret values cannot be stored', async () => {
  const f = fixture();
  await assert.rejects(f.bridge.configure({ companyId: 'c', hostActor: { actorType: 'user', userId: 'owner' },
    settings: { telegram: { webhookSecretRef: 'raw-secret', bindings: [] } }, reason: 'Configure', idempotencyKey: 'invalid' }), /secret reference/);
  await assert.rejects(f.bridge.configure({ companyId: 'other', hostActor: { actorType: 'user', userId: 'owner' },
    settings, reason: 'Configure', idempotencyKey: 'foreign' }), /membership/);
  await assert.rejects(f.bridge.configure({ companyId: 'c', hostActor: { actorType: 'agent', agentId: 'ceo' },
    settings, reason: 'Configure', idempotencyKey: 'agent' }), /membership/);
  const saved = await f.bridge.configure({ companyId: 'c', hostActor: { actorType: 'user', userId: 'owner' },
    settings: { ...settings, unexpectedSecret: 'should-not-persist', telegram: { ...settings.telegram,
      token: 'also-should-not-persist' } }, reason: 'Configure local channels', idempotencyKey: 'setup' });
  assert.ok(!JSON.stringify(saved).includes('should-not-persist'));
  assert.deepEqual(f.decisions.map(item => item.status), ['approved', 'applied']);
  assert.ok(!JSON.stringify(f.decisions).includes('telegram-secret'));
  assert.equal(f.decisions[0].actor.id, 'owner');
  assert.equal(f.decisions[1].supersedes, f.decisions[0].id);
  assert.deepEqual(await f.bridge.configure({ companyId: 'c', hostActor: { actorType: 'user', userId: 'owner' },
    settings: { ...settings, unexpectedSecret: 'should-not-persist', telegram: { ...settings.telegram,
      token: 'also-should-not-persist' } }, reason: 'Configure local channels', idempotencyKey: 'setup' }), saved);
  assert.equal(f.decisions.length, 2);
});
