/** Apply one owner-approved ADLC organization plan through an authenticated host adapter. */
export async function alignOrganization({ companyId, issueId, provisionFirst = false, command, readAgent, patchAgent, newKey = () => crypto.randomUUID() }) {
  if (!companyId || !issueId) throw new Error('Company and issue are required for organization alignment');
  if (provisionFirst) await command({ issueId, operation: 'provision',
    reason: 'Company owner provisions managed ADLC agents and skills before organization alignment',
    idempotencyKey: newKey() });
  const plan = await command({ issueId, operation: 'org-reporting-plan',
    reason: 'Company owner aligns managed ADLC agent reporting with the Pack organization',
    idempotencyKey: newKey() });
  if (plan.conflicts?.length) throw new Error(`Reporting plan found ${plan.conflicts.length} nonempty custom manager assignment(s). No manager was changed.`);
  try {
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
    const confirmation = await command({ issueId, operation: 'org-reporting-confirm',
      planDecisionId: plan.planDecisionId, idempotencyKey: newKey() });
    if (!confirmation.aligned) throw new Error('Paperclip did not confirm the organization alignment');
    return { plan, confirmation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Run alignment again to verify or resume plan ${plan.planDecisionId}.`, { cause: error });
  }
}
