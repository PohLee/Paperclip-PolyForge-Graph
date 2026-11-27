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
