import { fixtureShadowAgent } from './fixture-shadow.mjs';

const list = (value) => Array.isArray(value) ? value : [];

/** Resolve only the singleton company CEO explicitly bound and delegated by the Board. */
export async function boundCeo({ host, companyId, setup, config, scope }) {
  const ceoId = setup?.organization?.ceo?.id;
  if (!ceoId || config?.roleBindings?.ceo !== ceoId ||
      !list(setup.organization.authorityPolicy?.ceoOperations).includes(scope)) return null;
  const ceo = await host.agents.get(ceoId, companyId);
  return ceo?.companyId === companyId ? ceo : null;
}

/** Core ceo-review has no assignee; the native Paperclip issue still needs a CEO owner. */
export async function nativeIntakeAssignee({ host, companyId, intake, setup, config }) {
  if (intake.status === 'offered' && intake.assigneeId) {
    const assignee = await host.agents.get(intake.assigneeId, companyId);
    if (!assignee || assignee.companyId !== companyId) throw new Error('Intake assignee is not a company Agent');
    return assignee.id;
  }
  if (intake.status !== 'ceo-review') return null;
  return (await boundCeo({ host, companyId, setup, config, scope: 'intake' }))?.id ?? null;
}

/** Wake the Board-delegated native CEO through Paperclip's budget-checked issue path. */
export async function wakeCeoIssue({ host, companyId, issueId, setup, config, scope, sourceId }) {
  const ceo = await boundCeo({ host, companyId, setup, config, scope });
  if (!ceo) return { status: 'unavailable', reason: 'CEO role or Board delegation unavailable' };
  const issue = await host.issues.get(issueId, companyId);
  if (!issue || issue.companyId !== companyId || issue.assigneeAgentId !== ceo.id) {
    throw new Error('CEO wakeup requires an issue assigned to the bound company CEO');
  }
  const configuredModel = ceo.adapterType !== 'process' &&
    [ceo.adapterConfig?.model, ceo.adapterConfig?.profile?.model,
      ceo.runtimeConfig?.aiConnection?.profile?.model]
      .some((value) => typeof value === 'string' && value.trim());
  const hasBudget = Number.isFinite(ceo.budgetMonthlyCents) &&
    Number.isFinite(ceo.spentMonthlyCents) && ceo.budgetMonthlyCents > ceo.spentMonthlyCents;
  if (!['idle', 'active', 'running'].includes(ceo.status) || !hasBudget ||
      !(fixtureShadowAgent(ceo) || configuredModel)) {
    return { status: 'unavailable', reason: 'CEO adapter, status or native Agent budget unavailable' };
  }
  const wakeup = await host.issues.requestWakeup(issueId, companyId, {
    reason: `Board-delegated CEO coordination for ${scope}`,
    contextSource: 'polyforge-ceo-coordination',
    idempotencyKey: `polyforge-ceo:${companyId}:${scope}:${sourceId}`,
  });
  return { status: 'requested', wakeup };
}
