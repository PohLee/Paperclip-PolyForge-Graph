class ReportingConflictError extends Error {
  constructor(conflicts) {
    super(`Organization alignment is blocked by existing managers that need review. No manager was changed. Review the existing manager for ${conflicts.map(item => item.roleId).join(', ')}.`);
    this.name = 'ReportingConflictError';
  }
}

/** Apply one owner-approved ADLC organization plan through an authenticated host adapter. */
export async function alignOrganization({ companyId, issueId, provisionFirst = false, command, readAgent, patchAgent, newKey = () => crypto.randomUUID() }) {
  if (!companyId || !issueId) throw new Error('Company and issue are required for organization alignment');
  if (provisionFirst) await command({ issueId, operation: 'provision',
    reason: 'Company owner provisions managed ADLC agents and skills before organization alignment',
    idempotencyKey: newKey() });
  const plan = await command({ issueId, operation: 'org-reporting-plan',
    reason: 'Company owner aligns managed ADLC agent reporting with the Pack organization',
    idempotencyKey: newKey() });
  try {
    await applyReportingPlan({ companyId, plan, readAgent, patchAgent });
    const confirmation = await command({ issueId, operation: 'org-reporting-confirm',
      planDecisionId: plan.planDecisionId, idempotencyKey: newKey() });
    if (!confirmation.aligned) throw new Error('Paperclip did not confirm the organization alignment');
    return { plan, confirmation };
  } catch (error) {
    if (error instanceof ReportingConflictError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Run alignment again to verify or resume plan ${plan.planDecisionId}.`, { cause: error });
  }
}

async function applyReportingPlan({ companyId, plan, readAgent, patchAgent }) {
  if (plan.conflicts?.length) throw new ReportingConflictError(plan.conflicts);
  for (const change of plan.changes ?? []) {
    const before = await readAgent(change.agentId);
    if (before.companyId !== companyId) throw new Error(`${change.roleId} belongs to another company`);
    if ((before.reportsTo ?? null) === change.toReportsTo) continue;
    if ((before.reportsTo ?? null) !== change.fromReportsTo || change.fromReportsTo !== null) {
      throw new Error(`${change.roleId} changed since the reporting plan`);
    }
    const updated = await patchAgent(change.agentId, change.toReportsTo);
    if (updated.reportsTo !== change.toReportsTo) throw new Error(`Paperclip did not apply ${change.roleId}'s reporting change`);
  }
}

export async function alignCompanyOrganization({ companyId, organization, pack, command, readAgent, patchAgent }) {
  if (pack) {
    await command('provision-pack', { packId: pack.id, version: pack.version, reason: 'Provision selected Pack roles and skills' });
  }
  try {
    await command('configure-organization', { derive: true,
      organization: { board: organization?.board, ceo: organization?.ceo, authorityPolicy: organization?.authorityPolicy },
      reason: 'Align the company organization with its provisioned Pack roles' });
    const plan = await command('organization-reporting-plan', { reason: 'Plan native reporting links for enabled Packs' });
    await applyReportingPlan({ companyId, plan, readAgent, patchAgent });
    const result = await command('organization-reporting-confirm', {
      planDecisionId: plan.planDecisionId, reason: 'Verify the applied Paperclip reporting links' });
    if (!result?.aligned) throw new Error('Paperclip could not confirm the reporting links.');
  } catch (error) {
    if (!pack) throw error;
    if (error instanceof ReportingConflictError) {
      throw new Error(`Roles provisioned for ${pack.id}. ${error.message}`, { cause: error });
    }
    throw new Error(`Roles provisioned for ${pack.id}. Organization alignment is pending. ${error.message} Check the enabled Packs and retry alignment in Organization & readiness.`, { cause: error });
  }
}
