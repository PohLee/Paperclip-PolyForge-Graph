export function reportingPlan(roles, managed, companyId, externalManagers = {}) {
  const entries = Object.entries(roles ?? {});
  if (!entries.length) throw new Error('Pack has no organization roles');
  const ids = new Set();
  const visiting = new Set();
  const visited = new Set();
  for (const [roleId, role] of entries) {
    if (!Object.hasOwn(role, 'reportsToRole')) throw new Error(`Pack role ${roleId} has no reportsToRole`);
    if (role.reportsToRole !== null && !roles[role.reportsToRole] && !externalManagers[role.reportsToRole]) throw new Error(`Unknown organization manager for ${roleId}`);
    const resolved = managed[roleId];
    if (!resolved?.agentId || !resolved.agent || resolved.agent.companyId !== companyId) throw new Error(`Managed agent ${roleId} is missing from this company`);
    if (ids.has(resolved.agentId)) throw new Error(`Duplicate managed agent ID for ${roleId}`);
    ids.add(resolved.agentId);
  }
  function visit(roleId) {
    if (visiting.has(roleId)) throw new Error('Pack organization has a reporting cycle');
    if (visited.has(roleId)) return;
    visiting.add(roleId);
    const parent = roles[roleId].reportsToRole;
    if (parent !== null && roles[parent]) visit(parent);
    visiting.delete(roleId);
    visited.add(roleId);
  }
  for (const [roleId] of entries) visit(roleId);
  const assignments = entries.map(([roleId, role]) => ({
    roleId,
    agentId: managed[roleId].agentId,
    fromReportsTo: managed[roleId].agent.reportsTo ?? null,
    toReportsTo: role.reportsToRole === null ? null : (managed[role.reportsToRole]?.agentId ?? externalManagers[role.reportsToRole]),
  }));
  const changes = assignments.filter((item) => item.fromReportsTo === null && item.toReportsTo !== null);
  const conflicts = assignments.filter((item) => item.fromReportsTo !== null && item.fromReportsTo !== item.toReportsTo);
  return { assignments, changes, conflicts };
}

export function resumableReportingPlan(decisions, { actor, issueId, companyId, pack, assignments }) {
  const target = JSON.stringify(assignments.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo })));
  return [...decisions].reverse().find((decision) => {
    if (decision.type !== 'adlc_reporting' || decision.status !== 'approved' ||
        decision.actor?.id !== actor.id || decision.actor?.kind !== actor.kind || decision.issueId !== issueId ||
        decisions.some((item) => item.type === 'adlc_reporting' && item.status === 'applied' && item.supersedes === decision.id)) return false;
    const plan = decision.evidence?.find((item) => item.kind === 'organization_plan');
    return plan?.companyId === companyId && plan.packId === pack.id && plan.packVersion === pack.version &&
      JSON.stringify(plan.assignments?.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo }))) === target;
  }) ?? null;
}
