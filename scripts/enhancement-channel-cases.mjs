import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { base, pluginId, root, waitFor } from './enhancement-client.mjs';

const arr = value => Array.isArray(value) ? value : value?.items ?? value?.comments ?? [];
const endpoint = `/api/plugins/${pluginId}`;

export async function runChannelCases({ state, save, record, command, read, data, call, auth }) {
  const a = state.development;
  assert.ok(a?.companyId && a.projectId && a.issueId && auth?.userId);
  let company = await read(a.companyId);
  const boardId = company.setup.organization.board.id;
  assert.equal(boardId, auth.userId, 'Local Board binding must match the authenticated owner');
  const policy = company.setup.organization.authorityPolicy ?? {};
  const ceoOperations = [...new Set([...(policy.ceoOperations ?? []), 'intake', 'decision', 'strategy'])];
  const ceoDecisions = [...new Set([...(policy.ceoDecisions ?? []), 'strategy'])];
  if (ceoOperations.length !== (policy.ceoOperations ?? []).length ||
      ceoDecisions.length !== (policy.ceoDecisions ?? []).length) {
    await command(a.companyId, 'configure-organization', { organization: {
      ...company.setup.organization, authorityPolicy: { ...policy, ceoOperations, ceoDecisions },
    } }, 'channel:board-delegates-local-ceo-strategy');
    company = await read(a.companyId);
  }

  const secretPath = resolve(root, '.e2e/channel-fixture.json');
  let secret = await readFile(secretPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!secret || secret.companyId !== a.companyId) {
    const value = randomBytes(32).toString('base64url');
    const created = await data('POST', `/api/companies/${a.companyId}/secrets`, {
      name: 'Local Telegram webhook fixture', key: 'POLYFORGE_E2E_TELEGRAM_WEBHOOK', value,
      description: 'Synthetic localhost channel acceptance only',
    });
    secret = { companyId: a.companyId, secretId: created.id, value };
    await writeFile(secretPath, JSON.stringify(secret), { mode: 0o600 });
  }
  const ref = { type: 'secret_ref', secretId: secret.secretId, version: 'latest' };
  const native = await data('GET', `${endpoint}/config?companyId=${a.companyId}`);
  const configJson = { ...(native?.configJson ?? {}), telegram: {
    ...(native?.configJson?.telegram ?? {}), webhookSecretRef: ref,
  } };
  await data('POST', `${endpoint}/config`, { companyId: a.companyId, configJson });
  const bound = await data('GET', `${endpoint}/config?companyId=${a.companyId}`);
  assert.equal(bound.configJson.telegram.webhookSecretRef.secretId, secret.secretId);
  assert.deepEqual(bound.configJson.evidence, native?.configJson?.evidence,
    'Telegram binding must preserve prior evidence-provider bindings');

  const settings = {
    outboundMode: 'simulate',
    paperclip: { bindings: [{ issueId: a.issueId, projectId: a.projectId }] },
    telegram: { webhookSecretRef: ref,
      bindings: [{ chatId: '-100777', telegramUserId: '777', userId: auth.userId, projectId: a.projectId }] },
    recipients: [
      { subjectId: boardId, channel: 'paperclip', issueId: a.issueId },
      { subjectId: boardId, channel: 'telegram', chatId: '-100777' },
      { subjectId: boardId, channel: 'email', email: 'owner@example.invalid' },
    ],
  };
  const channels = await data('POST', `${endpoint}/api/channels`, { companyId: a.companyId, settings,
    reason: 'Local deterministic channel acceptance configuration',
    idempotencyKey: `channel:configure:${a.companyId}` });
  assert.equal(channels.outboundMode, 'simulate');
  assert.equal((await data('GET', `${endpoint}/api/channels?companyId=${a.companyId}`)).outboundMode, 'simulate');
  await record('Official native secret binding and company channel configuration', {
    companyId: a.companyId, mode: channels.outboundMode, paperclipIssueId: a.issueId,
    telegramBindingCount: channels.telegram.bindings.length,
  });

  const nativeComment = await data('POST', `/api/issues/${a.issueId}/comments`, {
    body: `Local native chat intake ${Date.now()}: validate company-scoped event delivery.`,
  });
  const chatIntake = await waitFor(async () => {
    const snapshot = await read(a.companyId);
    return snapshot.control.intake.find(item => item.source?.channel === 'paperclip-chat' &&
      item.source?.messageId === nativeComment.id);
  }, 'native Paperclip chat intake');
  assert.equal(chatIntake.projectId, a.projectId);
  assert.equal(chatIntake.source.senderId, auth.userId);
  await record('Native Paperclip comment event creates one scoped intake', {
    commentId: nativeComment.id, intakeId: chatIntake.id, projectId: chatIntake.projectId,
  });

  const webhook = async (token, update) => {
    const response = await fetch(`${base}${endpoint}/webhooks/telegram`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': token },
      body: JSON.stringify(update) });
    return { status: response.status, body: await response.json() };
  };
  const updateId = state.channelUpdateId ?? Math.floor(Date.now() / 1000);
  const update = { update_id: updateId, message: { message_id: updateId,
    from: { id: 777, is_bot: false }, chat: { id: -100777 },
    text: 'Synthetic Telegram request from a bound local sender',
  } };
  const invalid = await webhook('wrong-local-token', update);
  assert.equal(invalid.status, 502);
  const accepted = await webhook(secret.value, update);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const telegramIntake = await waitFor(async () => {
    const snapshot = await read(a.companyId);
    return snapshot.control.intake.find(item => item.source?.channel === 'telegram' &&
      item.source?.messageId === String(updateId));
  }, 'authenticated Telegram intake');
  assert.equal(telegramIntake.projectId, a.projectId);
  assert.equal(telegramIntake.source.senderId, '777');
  const duplicate = await webhook(secret.value, update);
  assert.equal(duplicate.status, 200);
  assert.equal((await read(a.companyId)).control.intake.filter(item => item.source?.channel === 'telegram' &&
    item.source?.chatId === '-100777' && item.source?.messageId === String(updateId)).length, 1);
  state.channelUpdateId = updateId;
  await save();
  await record('Telegram webhook rejects invalid token and deduplicates bound sender', {
    invalidStatus: invalid.status, validStatus: accepted.status, duplicateStatus: duplicate.status,
    intakeId: telegramIntake.id,
  });

  await command(a.companyId, 'set-notification-preferences', {
    subjectId: boardId, channels: ['paperclip', 'telegram', 'email'], events: ['decision.escalated'],
  }, 'channel:board-notification-preferences');
  const subordinateId = company.setup.organization.domainHeads.find(item => item.domain === 'product')?.agentId ??
    company.setup.organization.domainHeads[0]?.agentId;
  assert.ok(subordinateId && subordinateId !== company.setup.organization.ceo.id,
    'A distinct subordinate Agent is required for CEO strategy adjustment');
  const subordinateGoalId = `channel-subordinate-${a.companyId}`;
  const subordinate = await command(a.companyId, 'set-goals', {
    scope: 'agent', subjectId: subordinateId, goals: [{ id: subordinateGoalId,
      title: 'Improve a synthetic subordinate outcome', parentGoalId: 'enhancement-users',
      keyResults: [{ id: 'local-subordinate', baseline: 0, target: 3, unit: 'cases',
        source: 'local-fixture', window: 'synthetic-launch+10d' }] }],
  }, 'channel:subordinate-goal-before-strategy');
  const observed = (await read(a.companyId)).control.reviews.find(item => item.goalId === 'enhancement-users' &&
    item.observations.some(observation => observation.status === 'observed'));
  assert.ok(observed, 'A sourced outcome review from the real provider is required');
  const reviewed = observed;
  assert.equal(reviewed.observations[0].status, 'observed');

  const jobs = await data('GET', `${endpoint}/jobs`);
  const trigger = async (jobKey) => {
    const job = arr(jobs).find(item => item.jobKey === jobKey);
    assert.ok(job?.id, `Scheduled ${jobKey} job must be registered`);
    const started = await data('POST', `${endpoint}/jobs/${job.id}/trigger`, {});
    const completed = await waitFor(async () => {
      const runs = arr(await data('GET', `${endpoint}/jobs/${job.id}/runs`));
      const run = runs.find(item => item.id === started.runId);
      if (run?.status === 'failed') throw new Error(`${jobKey} failed: ${run.error ?? run.errorMessage ?? 'unknown'}`);
      return run?.status === 'succeeded' ? run : null;
    }, `${jobKey} job completion`);
    return { jobId: job.id, runId: completed.id };
  };
  const strategyJob = await trigger('strategy-review');
  const escalated = await waitFor(async () => {
    const snapshot = await read(a.companyId);
    return snapshot.control.escalations.find(item => item.subjectType === 'strategy' && item.subjectId === reviewed.id);
  }, 'sourced CEO strategy escalation');
  assert.ok(escalated.evidence.some(item => item.goalRevisionId === reviewed.goalRevisionId));
  assert.equal(escalated.eligibleRole, 'ceo', 'Board delegated this sourced strategy decision to CEO');
  const strategyAdjustment = await waitFor(async () => {
    const snapshot = await read(a.companyId);
    return snapshot.control.adjustments.find(item => item.reviewId === reviewed.id);
  }, 'local CEO strategy adjustment');
  const afterStrategy = await read(a.companyId);
  const revisedSubordinate = afterStrategy.control.goalHistory
    .filter(item => item.scope === 'agent' && item.subjectId === subordinateId).at(-1);
  assert.notEqual(revisedSubordinate.id, subordinate.revision.id);
  assert.equal(revisedSubordinate.goals[0].keyResults[0].target, 4);
  let deliveryEscalation = escalated;
  if (escalated.eligibleRole !== 'human-owner') {
    const delegated = new Set(company.setup.organization.authorityPolicy?.ceoDecisions ?? []);
    const humanScope = ['cross-pack', 'strategy', 'work-plan', 'agent-goal', 'intake']
      .find(subjectType => !delegated.has(subjectType));
    assert.ok(humanScope, 'At least one Board-owned decision scope is required for human channel acceptance');
    deliveryEscalation = await command(a.companyId, 'escalate-decision', {
      subjectType: humanScope, subjectId: `channel-delivery:${reviewed.id}`,
      question: 'Verify local channel notification delivery for a sourced outcome',
      options: [{ id: 'keep', label: 'Keep current plan' }, { id: 'review', label: 'Review proposal' }],
      evidence: [{ kind: 'outcome-review', reviewId: reviewed.id, goalRevisionId: reviewed.goalRevisionId }],
    }, 'channel:board-delivery-escalation');
    assert.equal(deliveryEscalation.eligibleRole, 'human-owner');
  }
  const notice = (await read(a.companyId)).control.outbox.find(item => item.ref?.escalationId === deliveryEscalation.id);
  assert.ok(notice && notice.subjectId === boardId);
  assert.deepEqual(notice.channels, ['paperclip', 'telegram', 'email']);
  const deliveryJob = await trigger('channel-delivery');
  const ledger = await data('GET', `${endpoint}/api/channels/deliveries?companyId=${a.companyId}`);
  const deliveries = arr(ledger).filter(item => item.notificationId === notice.id);
  assert.equal(deliveries.find(item => item.channel === 'paperclip')?.status, 'delivered');
  assert.equal(deliveries.find(item => item.channel === 'telegram')?.status, 'simulated');
  assert.equal(deliveries.find(item => item.channel === 'email')?.status, 'simulated');
  const comments = arr(await data('GET', `/api/issues/${a.issueId}/comments`));
  assert.ok(comments.some(item => item.body?.includes(deliveryEscalation.id)), 'Paperclip notification comment was not posted');
  await record('Scheduled sourced strategy review and durable local channel delivery', {
    reviewId: reviewed.id, escalationId: escalated.id, deliveryEscalationId: deliveryEscalation.id,
    goalRevisionId: reviewed.goalRevisionId, strategyAdjustmentId: strategyAdjustment.id,
    subordinateRevisionId: revisedSubordinate.id,
    strategyJob, deliveryJob, channels: deliveries.map(item => ({ channel: item.channel, status: item.status })),
  });

  const ceoId = company.setup.organization.ceo.id;
  const dueKey = `channel-review-${a.companyId}`;
  state.channelWindowEnd ??= new Date(Date.now() - 60000).toISOString();
  await save();
  await command(a.companyId, 'set-goals', { scope: 'agent', subjectId: ceoId, goals: [{
    id: dueKey, title: 'Review synthetic channel outcome evidence', parentGoalId: 'enhancement-users',
    keyResults: [{ id: 'local-review', baseline: 0, target: 1, unit: 'review', source: 'local-fixture',
      window: 'local-channel-window', windowEnd: state.channelWindowEnd }],
  }] }, 'channel:due-review-goal');
  const reminderJob = await trigger('outcome-reminders');
  const reminder = (await read(a.companyId)).control.outbox.find(item =>
    item.eventKind === 'outcome-review.due' && item.ref?.keyResultId === 'local-review');
  assert.ok(reminder && reminder.subjectId === ceoId);
  await record('Scheduled due outcome reminder pins current goal revision', {
    reminderJob, notificationId: reminder.id, goalRevisionId: reminder.ref.goalRevisionId,
  });
}
