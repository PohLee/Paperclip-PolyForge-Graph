import { createHash, timingSafeEqual } from 'node:crypto';
import { telegramIntake, deliverNotification } from '../host/channels.mjs';
import { boundCeo, nativeIntakeAssignee, wakeCeoIssue } from './ceo-dispatch.mjs';
import { getGraphConfig, getChannelConfig, setChannelConfig, listChannelConfigs, listGraphCompanies,
  claimNotificationDelivery, finishNotificationDelivery, listNotificationDeliveries } from './store.mjs';

const required = (v, n) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${n} required`); return v.trim(); };
const list = v => Array.isArray(v) ? v : [];
const hash = v => createHash('sha256').update(String(v)).digest('hex');
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const secretRef = v => v?.type === 'secret_ref' && typeof v.secretId === 'string' && v.secretId.length > 0;
const field = (r, a, b) => r?.[a] ?? r?.[b];
const table = db => {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid host database namespace');
  return `${db.namespace}.graph_channel_intake`;
};
const tgKey = (ref, chat, message) => `tg:${hash(ref.secretId)}:chat:${chat}:message:${message}`;
const pcKey = (company, comment) => `paperclip:${company}:comment:${comment}`;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0 &&
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

async function claimInbound(db, { companyId, channel, sourceKey, fingerprint, replyToKey }) {
  const inserted = await db.execute(`INSERT INTO ${table(db)}
    (company_id,channel,source_key,fingerprint,status,reply_to_key)
    VALUES ($1,$2,$3,$4,'claimed',$5) ON CONFLICT DO NOTHING`,
  [companyId, channel, sourceKey, fingerprint, replyToKey ?? null]);
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id=$1 AND channel=$2 AND source_key=$3`,
    [companyId, channel, sourceKey]);
  const row = rows[0];
  if (!row || row.fingerprint !== fingerprint) throw new Error('Inbound source key reused with different content or company');
  return { claimed: inserted.rowCount === 1, status: row.status,
    intakeId: field(row, 'intake_id', 'intakeId'), issueId: field(row, 'issue_id', 'issueId') };
}
async function finishInbound(db, { companyId, channel, sourceKey, status, intakeId, issueId }) {
  const result = await db.execute(`UPDATE ${table(db)} SET status=$4,intake_id=$5,issue_id=$6,updated_at=now()
    WHERE company_id=$1 AND channel=$2 AND source_key=$3 AND status='claimed'`,
  [companyId, channel, sourceKey, status, intakeId ?? null, issueId ?? null]);
  if (result.rowCount !== 1) throw new Error('Inbound claim lost');
}
async function mappedMessage(db, companyId, channel, sourceKey) {
  const rows = await db.query(`SELECT intake_id,issue_id,status FROM ${table(db)}
    WHERE company_id=$1 AND channel=$2 AND source_key=$3`, [companyId, channel, sourceKey]);
  const row = rows[0];
  return row?.status === 'completed' && field(row, 'intake_id', 'intakeId')
    ? { intakeId: field(row, 'intake_id', 'intakeId'), issueId: field(row, 'issue_id', 'issueId') } : null;
}

/** Channel integration bound to host identities and a durable delivery ledger. */
export function createChannelBridge({ host, engineFor, getConfig = getChannelConfig,
  setConfig = setChannelConfig, trustedActor, externalDeliveryEnabled = false }) {
  if (!host?.db || !host?.manifest?.id || !engineFor || !trustedActor) throw new Error('Channel bridge dependencies missing');
  async function identity(companyId, userId) {
    const { actor } = await trustedActor(companyId, { actorType: 'user', userId }, await getGraphConfig(host.db, companyId));
    if (actor.kind !== 'human') throw new Error('Bound sender is not human');
    return actor;
  }
  async function owner(companyId, hostActor) {
    const resolved = await trustedActor(companyId, hostActor, await getGraphConfig(host.db, companyId));
    if (!resolved.isAdministrator || resolved.actor.kind !== 'human') throw new Error('Company owner or admin required');
    return resolved.actor;
  }
  async function member(companyId, userId) {
    const rows = await host.access.members.list({ companyId });
    if (!rows.some(r => r.principalType === 'user' && r.principalId === userId && r.status === 'active'))
      throw new Error('Human has no active company membership');
  }
  async function validate(companyId, settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Channel settings object required');
    if (settings.outboundMode !== undefined && !['disabled', 'simulate'].includes(settings.outboundMode))
      throw new Error('Invalid outbound mode');
    for (const [name, provider] of Object.entries({ telegram: settings.telegram, email: settings.email })) {
      if (!provider) continue;
      for (const key of name === 'telegram' ? ['webhookSecretRef', 'botTokenSecretRef'] : ['tokenSecretRef'])
        if (provider[key] !== undefined && !secretRef(provider[key])) throw new Error(`${name}.${key} must be a host secret reference`);
      if (name === 'telegram' && list(provider.bindings).length && !secretRef(provider.webhookSecretRef))
        throw new Error('Telegram bindings require a webhook secret reference');
    }
    const unique = new Set();
    for (const b of list(settings.telegram?.bindings)) {
      required(b.userId, 'binding.userId'); required(b.projectId, 'binding.projectId');
      if (b.chatId === undefined || b.telegramUserId === undefined) throw new Error('Telegram sender and chat binding required');
      const key = `${b.chatId}:${b.telegramUserId}`;
      if (unique.has(key)) throw new Error('Duplicate Telegram sender binding'); unique.add(key);
      await member(companyId, b.userId);
      if (!await host.projects.get(b.projectId, companyId)) throw new Error('Bound project outside company');
      if (b.assigneeId && !await host.agents.get(b.assigneeId, companyId)) throw new Error('Bound assignee outside company');
    }
    for (const b of list(settings.paperclip?.bindings)) {
      const issue = await host.issues.get(required(b.issueId, 'Paperclip chat issue'), companyId);
      if (!issue || issue.projectId !== required(b.projectId, 'Paperclip chat project')) throw new Error('Chat issue/project mismatch');
      if (b.assigneeId && !await host.agents.get(b.assigneeId, companyId)) throw new Error('Chat assignee outside company');
    }
    for (const b of list(settings.recipients)) {
      required(b.subjectId, 'recipient.subjectId');
      if (!['telegram', 'email', 'paperclip', 'in-app'].includes(b.channel)) throw new Error('Unknown recipient channel');
      if (b.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email ?? '')) throw new Error('Recipient email invalid');
      if (b.channel === 'telegram' && b.chatId === undefined) throw new Error('Recipient Telegram chat required');
      if (b.channel === 'paperclip' && !await host.issues.get(required(b.issueId, 'recipient.issueId'), companyId)) throw new Error('Recipient issue outside company');
      if (['telegram', 'email'].includes(b.channel)) await member(companyId, b.subjectId);
    }
  }
  async function readConfig({ companyId, hostActor }) { await owner(companyId, hostActor); return getConfig(host.db, companyId); }
  async function readDeliveries({ companyId, hostActor }) {
    await owner(companyId, hostActor);
    return listNotificationDeliveries(host.db, companyId);
  }
  async function configure({ companyId, hostActor, settings, reason, idempotencyKey }) {
    const actor = await owner(companyId, hostActor);
    required(reason, 'reason'); required(idempotencyKey, 'idempotencyKey');
    await validate(companyId, settings);
    const safe = {
      telegram: settings.telegram ? {
        webhookSecretRef: settings.telegram.webhookSecretRef,
        botTokenSecretRef: settings.telegram.botTokenSecretRef,
        apiBase: settings.telegram.apiBase,
        bindings: list(settings.telegram.bindings).map(b => ({ chatId: b.chatId, telegramUserId: b.telegramUserId,
          userId: b.userId, projectId: b.projectId, assigneeId: b.assigneeId ?? null, enabled: b.enabled !== false })),
      } : undefined,
      email: settings.email ? { tokenSecretRef: settings.email.tokenSecretRef,
        endpoint: settings.email.endpoint, from: settings.email.from } : undefined,
      paperclip: settings.paperclip ? { bindings: list(settings.paperclip.bindings).map(b => ({
        issueId: b.issueId, projectId: b.projectId, assigneeId: b.assigneeId ?? null,
        enabled: b.enabled !== false })) } : undefined,
      recipients: list(settings.recipients).map(b => ({ subjectId: b.subjectId, channel: b.channel,
        chatId: b.chatId, email: b.email, issueId: b.issueId, enabled: b.enabled !== false })),
      outboundMode: settings.outboundMode ?? 'disabled',
    };
    const before = await getConfig(host.db, companyId);
    const summary = (value) => ({ digest: `sha256:${hash(canonical(value))}`,
      outboundMode: value.outboundMode ?? 'disabled',
      paperclipBindings: list(value.paperclip?.bindings).length,
      telegramBindings: list(value.telegram?.bindings).length,
      recipients: list(value.recipients).length,
      webhookSecretBound: secretRef(value.telegram?.webhookSecretRef) });
    const { engine } = await engineFor(companyId);
    const requestRef = { kind: 'channel-config-request', id: `${companyId}:${idempotencyKey}` };
    const related = (await engine.listDecisions()).filter(item => item.type === 'channel_configuration' &&
      item.affectedRefs?.some(ref => ref.kind === requestRef.kind && ref.id === requestRef.id));
    const previous = related.find(item => item.status === 'approved');
    const beforeRef = previous?.evidence?.[0]?.before ?? summary(before);
    const afterRef = summary(safe);
    if (previous && (previous.reason !== reason || previous.actor?.id !== actor.id || previous.actor?.kind !== actor.kind)) {
      throw new Error('Channel config idempotency key reused with different actor or reason');
    }
    if (previous && previous.evidence?.[0]?.after?.digest !== afterRef.digest) throw new Error('Channel config idempotency key reused with changed settings');
    if (previous && ![beforeRef.digest, afterRef.digest].includes(summary(before).digest)) {
      throw new Error('Channel configuration intent is stale');
    }
    if (related.some(item => item.status === 'applied')) {
      if (summary(before).digest !== afterRef.digest) throw new Error('Applied channel config replay is stale');
      return before;
    }
    const evidence = [{ kind: 'channel-config-change', before: beforeRef, after: afterRef }];
    const intent = await engine.recordDecision({ type: 'channel_configuration', status: 'approved', outcome: 'requested',
      reason, actor, evidence, affectedRefs: [requestRef],
      idempotencyKey: `channel-config:${companyId}:${idempotencyKey}:intent` });
    await setConfig(host.db, companyId, structuredClone(safe));
    await engine.recordDecision({ type: 'channel_configuration', status: 'applied', outcome: 'updated',
      reason, actor, evidence, affectedRefs: [requestRef], supersedes: intent.id,
      idempotencyKey: `channel-config:${companyId}:${idempotencyKey}:result` });
    return getConfig(host.db, companyId);
  }
  async function processMessage({ companyId, userId, projectId, assigneeId, title, text,
    attachments, source, sourceKey, replyToKey, channel }) {
    await member(companyId, userId);
    if (!await host.projects.get(projectId, companyId)) throw new Error('Inbound project outside company');
    const actor = await identity(companyId, userId);
    const fingerprint = hash(canonical({ companyId, userId, projectId, text, attachments, source: {
      ...source, eventId: undefined, updateId: undefined } }));
    const reply = replyToKey ? await mappedMessage(host.db, companyId, channel, replyToKey) : null;
    if (replyToKey && !reply) throw new Error('Reply has no completed intake mapping');
    const claim = await claimInbound(host.db, { companyId, channel, sourceKey, fingerprint, replyToKey });
    if (!claim.claimed) return { status: claim.status === 'completed' ? 'duplicate' : 'unknown',
      intakeId: claim.intakeId, issueId: claim.issueId };
    let intakeId = null, issueId = null;
    try {
      const { control } = await engineFor(companyId);
      if (reply) {
        intakeId = reply.intakeId; issueId = reply.issueId;
        if (!issueId || !await host.issues.get(issueId, companyId)) throw new Error('Reply intake issue missing');
        await control.appendFeedback({ projectId, subjectId: intakeId, body: text,
          sourceRefs: [{ kind: 'intake', id: intakeId }, { kind: channel, ...source }],
          actor, reason: `Human ${channel} reply`, idempotencyKey: `channel-reply:${sourceKey}` });
        if (channel === 'telegram') await host.issues.createComment(issueId, text, companyId, { actorUserId: userId });
      } else {
        const intake = await control.createIntake({ projectId, title, description: text,
          assigneeId: assigneeId ?? null, source, attachments, actor,
          reason: `Human ${channel} request`, idempotencyKey: `channel-intake:${sourceKey}` });
        intakeId = intake.id;
        const setup = await control.getSetup();
        const config = await getGraphConfig(host.db, companyId);
        const assigneeAgentId = await nativeIntakeAssignee({ host, companyId, intake, setup, config });
        const originKind = `plugin:${host.manifest.id}:intake`;
        const found = await host.issues.list({ companyId, originKind, originId: intake.id, limit: 2 });
        if (found.length > 1) throw new Error('Duplicate Paperclip intake issues require operator repair');
        const issue = found[0] ?? await host.issues.create({ companyId, projectId: intake.projectId,
          title: intake.title, description: intake.description, status: 'todo',
          assigneeAgentId: assigneeAgentId ?? undefined, originKind, originId: intake.id });
        issueId = issue.id;
        if (found[0] && (issue.assigneeAgentId ?? null) !== assigneeAgentId) {
          await host.issues.update(issue.id, { assigneeAgentId }, companyId);
        }
        if (intake.status === 'ceo-review' && assigneeAgentId) {
          await wakeCeoIssue({ host, companyId, issueId, setup, config,
            scope: 'intake', sourceId: intake.id });
        }
      }
      await finishInbound(host.db, { companyId, channel, sourceKey, status: 'completed', intakeId, issueId });
      return { status: 'completed', intakeId, issueId };
    } catch (error) {
      await finishInbound(host.db, { companyId, channel, sourceKey, status: 'unknown', intakeId, issueId });
      throw error;
    }
  }
  async function handleWebhook(input) {
    if (input.endpointKey !== 'telegram') throw new Error('Unknown channel webhook');
    const update = input.parsedBody ?? JSON.parse(input.rawBody);
    const configurations = await listChannelConfigs(host.db);
    const matches = [];
    const normalizedHeaders = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => {
      if (Array.isArray(value) && value.length !== 1) throw new Error('Ambiguous webhook header');
      return [key, Array.isArray(value) ? value[0] : value];
    }));
    const header = Object.entries(normalizedHeaders).find(([k]) => k.toLowerCase() === 'x-telegram-bot-api-secret-token')?.[1];
    for (const { companyId, settings } of configurations) {
      const ref = settings?.telegram?.webhookSecretRef;
      if (!secretRef(ref)) continue;
      const value = await host.secrets.resolve(ref, { companyId, configPath: 'telegram.webhookSecretRef' });
      if (same(Array.isArray(header) ? header[0] : header, value)) matches.push({ companyId, settings, value });
    }
    if (matches.length !== 1) throw new Error('Telegram webhook secret must match exactly one company');
    const { companyId, settings, value } = matches[0];
    const intake = telegramIntake({ headers: normalizedHeaders, update, secret: value,
      bindings: list(settings.telegram?.bindings).map(b => ({ ...b, companyId })) });
    const ref = settings.telegram.webhookSecretRef;
    return processMessage({ companyId, userId: intake.userId, projectId: intake.projectId,
      assigneeId: intake.assigneeId, title: intake.title, text: intake.description,
      attachments: intake.attachments, source: intake.source,
      sourceKey: tgKey(ref, intake.source.chatId, intake.source.messageId),
      replyToKey: intake.source.replyToMessageId ? tgKey(ref, intake.source.chatId, intake.source.replyToMessageId) : null,
      channel: 'telegram' });
  }
  async function handleEvent(event) {
    if (event.eventType !== 'issue.comment.created' || !event.companyId || !event.entityId) return { status: 'ignored' };
    const issue = await host.issues.get(event.entityId, event.companyId);
    if (!issue) throw new Error('Event issue outside company');
    const commentId = event.payload?.commentId ?? event.payload?.id;
    const comment = (await host.issues.listComments(issue.id, event.companyId)).find(x => x.id === commentId);
    if (comment && (comment.issueId && comment.issueId !== issue.id ||
        comment.companyId && comment.companyId !== event.companyId)) throw new Error('Comment provenance mismatch');
    if (!comment || comment.deletedAt || comment.authorType !== 'user' || !comment.authorUserId ||
        event.actorType !== 'user' || event.actorId !== comment.authorUserId) return { status: 'ignored' };
    const settings = await getConfig(host.db, event.companyId);
    const binding = list(settings.paperclip?.bindings).find(x => x.enabled !== false && x.issueId === issue.id);
    const intakeIssue = !binding && issue.originKind === `plugin:${host.manifest.id}:intake` ? issue : null;
    if (!binding && !intakeIssue) return { status: 'ignored' };
    const projectId = binding?.projectId ?? issue.projectId;
    if (!projectId || issue.projectId !== projectId) throw new Error('Event issue/project mismatch');
    required(comment.body, 'Paperclip comment body');
    const text = comment.body;
    const source = { channel: 'paperclip-chat', senderId: comment.authorUserId, messageId: comment.id,
      issueId: issue.id, eventId: event.eventId };
    const attachments = (await host.issues.listAttachments(issue.id, event.companyId))
      .filter(x => x.issueCommentId === comment.id)
      .map(x => ({ kind: 'paperclip-attachment', id: x.id, fileName: x.originalFilename ?? null,
        mimeType: x.contentType, sha256: x.sha256, byteSize: x.byteSize }));
    let replyToKey = null;
    if (intakeIssue) {
      const rows = await host.db.query(`SELECT source_key FROM ${table(host.db)} WHERE company_id=$1 AND channel='paperclip-chat' AND intake_id=$2 AND status='completed' ORDER BY created_at LIMIT 1`,
        [event.companyId, issue.originId]);
      replyToKey = field(rows[0], 'source_key', 'sourceKey');
      if (!replyToKey) throw new Error('Native intake issue has no mapped source');
    }
    return processMessage({ companyId: event.companyId, userId: comment.authorUserId, projectId,
      assigneeId: binding?.assigneeId, title: text.split('\n')[0].slice(0, 180), text,
      attachments, source, sourceKey: pcKey(event.companyId, comment.id), replyToKey,
      channel: 'paperclip-chat' });
  }
  async function deliverPending({ companyId } = {}) {
    const configurations = companyId ? [{ companyId, settings: await getConfig(host.db, companyId) }]
      : await Promise.all((await listGraphCompanies(host.db)).map(async id => ({ companyId: id, settings: await getConfig(host.db, id) })));
    const results = [];
    for (const { companyId: company, settings } of configurations) {
      const { control } = await engineFor(company);
      if (control.queueRunNotifications) await control.queueRunNotifications({
        actor: { id: host.manifest.id, kind: 'system', roles: ['run-observer'] },
        reason: 'Observed terminal Graph state for company progress reporting',
      });
      for (const n of await control.listNotifications()) {
        if (n.companyId !== company) throw new Error('Notification company mismatch');
        for (const channel of list(n.channels)) {
          if (!['telegram', 'email', 'paperclip', 'in-app'].includes(channel)) continue;
          const simulated = ['telegram', 'email'].includes(channel) && settings.outboundMode === 'simulate';
          if (['telegram', 'email'].includes(channel) && !externalDeliveryEnabled && !simulated) {
            results.push({ companyId: company, notificationId: n.id, channel, status: 'disabled',
              reason: 'External delivery is not activated' });
            continue;
          }
          const b = list(settings.recipients).find(x => x.enabled !== false && x.subjectId === n.subjectId && x.channel === channel);
          const provider = settings[channel] ?? {};
          let credential = null;
          // Check company scope before claiming. A job with no usable host scope must not strand delivery.
          if (b && ['telegram', 'email'].includes(channel)) {
            await member(company, n.subjectId);
            const ref = provider.botTokenSecretRef ?? provider.tokenSecretRef;
            if (!simulated && ref) credential = await host.secrets.resolve(ref, { companyId: company,
              configPath: channel === 'telegram' ? 'telegram.botTokenSecretRef' : 'email.tokenSecretRef' });
          }
          if (b && channel === 'paperclip' && !await host.issues.get(b.issueId, company))
            throw new Error('Bound notification issue missing in company');
          if (!await claimNotificationDelivery(host.db, company, n.id, channel)) continue;
          let result;
          try {
            if (channel === 'in-app') result = { status: 'delivered', channel,
              receipt: { provider: 'paperclip-outbox', id: n.id } };
            else if (!b) result = { status: 'unconfigured', channel, reason: 'No bound recipient' };
            else if (simulated) result = { status: 'simulated', channel,
              receipt: { provider: 'local-simulation', id: `${company}:${n.id}:${channel}` } };
            else {
              result = await deliverNotification({ channel, notification: { ...n,
                text: `${n.eventKind}: ${JSON.stringify(n.ref ?? {})}` }, destination: { ...b, companyId: company },
                config: { ...provider, tokenSecretRef: provider.botTokenSecretRef ?? provider.tokenSecretRef },
                resolveSecret: async () => credential,
                fetchImpl: (...args) => host.http.fetch(...args),
                postPaperclip: ({ issueId, body }) => host.issues.createComment(issueId, body, company) });
            }
          } catch { result = { status: 'unknown', channel, reason: 'Delivery outcome unknown; inspect provider before retrying' }; }
          await finishNotificationDelivery(host.db, company, n.id, channel, result);
          results.push({ companyId: company, notificationId: n.id, ...result });
        }
      }
    }
    return results;
  }
  async function outcomeReminders({ companyId } = {}) {
    const configs = companyId ? [{ companyId }] : (await listGraphCompanies(host.db)).map(id => ({ companyId: id }));
    const result = [];
    for (const { companyId: company } of configs) {
      const { control } = await engineFor(company);
      result.push({ companyId: company, ...await control.queueOutcomeReviewReminders({
        actor: { id: 'polyforge-channel-job', kind: 'system', roles: [], executionId: null },
        reason: 'Scheduled outcome review reminder',
        idempotencyKey: `outcome-reminders:${company}:${new Date().toISOString().slice(0, 10)}` }) });
    }
    return result;
  }
  async function strategyReview({ companyId } = {}) {
    const companies = companyId ? [companyId] : await listGraphCompanies(host.db);
    const results = [];
    for (const company of companies) {
      const { control, store } = await engineFor(company);
      const state = await store.read();
      const c = state?.control;
      if (!c || c.companyId !== company) continue;
      const now = Date.now();
      const providers = control.trustedProviders ?? new Set();
      async function ensureCeoStrategyIssue(escalation, review) {
        if (escalation.eligibleRole !== 'ceo' || escalation.status === 'resolved') return null;
        if (!review.projectId || !await host.projects.get(review.projectId, company)) {
          throw new Error('Strategy review project outside company');
        }
        const setup = await control.getSetup();
        const config = await getGraphConfig(host.db, company);
        const ceo = await boundCeo({ host, companyId: company, setup, config, scope: 'strategy' });
        if (!ceo) return { status: 'unavailable', reason: 'CEO strategy delegation unavailable' };
        const originKind = `plugin:${host.manifest.id}:strategy`;
        const found = await host.issues.list({ companyId: company, originKind, originId: escalation.id, limit: 2 });
        if (found.length > 1) throw new Error('Duplicate strategy issues require operator repair');
        const issue = found[0] ?? await host.issues.create({ companyId: company, projectId: review.projectId,
          title: 'Review sourced outcome and goals', description: escalation.question,
          status: 'todo', assigneeAgentId: ceo.id, originKind, originId: escalation.id });
        if (issue.projectId !== review.projectId) throw new Error('Strategy issue project mismatch');
        if (found[0] && issue.assigneeAgentId !== ceo.id) {
          await host.issues.update(issue.id, { assigneeAgentId: ceo.id }, company);
        }
        return { issueId: issue.id, ...await wakeCeoIssue({ host, companyId: company, issueId: issue.id,
          setup, config, scope: 'strategy', sourceId: escalation.id }) };
      }
      for (const review of c.reviews ?? []) {
        if (review.companyId !== company || (c.adjustments ?? []).some(item => item.reviewId === review.id)) continue;
        const previous = (c.escalations ?? []).find(item => item.subjectType === 'strategy' && item.subjectId === review.id);
        if (previous) {
          if (previous.status === 'pending') await ensureCeoStrategyIssue(previous, review);
          continue;
        }
        const evidence = (review.observations ?? []).filter(item => item.status === 'observed' && item.evidenceReceiptId)
          .map(item => ({ observation: item, receipt: (c.evidenceReceipts ?? []).find(entry => entry.id === item.evidenceReceiptId)?.receipt }))
          .filter(({ receipt }) => receipt && providers.has(receipt.providerId) && Date.parse(receipt.expiresAt) > now);
        if (!evidence.length) continue;
        const latest = (c.adjustments ?? []).at(-1);
        if (latest && now - Date.parse(latest.at) < 86400000) continue;
        const goalRevision = (c.goalHistory ?? []).find(item => item.id === review.goalRevisionId);
        if (!goalRevision) continue;
        const escalation = await control.escalateDecision({ subjectType: 'strategy', subjectId: review.id,
          question: 'Review sourced outcome evidence and decide whether subordinate goals need adjustment',
          options: [{ id: 'keep', label: 'Keep current goals' }, { id: 'propose', label: 'Propose subordinate goal changes' }],
          evidence: [{ kind: 'outcome-review', reviewId: review.id, goalRevisionId: review.goalRevisionId,
            goalRevisionVersion: goalRevision.version, receiptIds: evidence.map(({ receipt }) => receipt.id) }],
          actor: { id: 'polyforge-strategy-job', kind: 'system', roles: [], executionId: null },
          reason: 'Scheduled review of current sourced outcome evidence',
          idempotencyKey: `strategy-review:${company}:${review.id}` });
        const wakeup = await ensureCeoStrategyIssue(escalation, review);
        results.push({ companyId: company, reviewId: review.id, escalationId: escalation.id,
          eligibleRole: escalation.eligibleRole, wakeup });
      }
    }
    return results;
  }
  return { readConfig, readDeliveries, configure, handleWebhook, handleEvent, deliverPending, outcomeReminders, strategyReview };
}
