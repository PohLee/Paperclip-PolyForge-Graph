import { normalizeDeliveryLimits } from '../core/delivery-limits.mjs';

export function settingsRoles(catalog, config = {}) {
  const roles = new Map([['ceo', { id: 'ceo', name: 'Company CEO', packId: null }]]);
  for (const pack of catalog) for (const [id, role] of Object.entries(pack.roles ?? {})) {
    roles.set(`${pack.id}:${id}`, { id: `${pack.id}:${id}`, localId: id, name: role.name ?? id, packId: pack.id });
  }
  for (const id of new Set([...Object.keys(config.roleBindings ?? {}), ...Object.values(config.userRoles ?? {}).flat()])) {
    if (id !== 'human-owner' && !roles.has(id) && !roles.has(`adlc:${id}`)) {
      roles.set(id, { id, name: id.replaceAll(/[-_]/g, ' '), packId: 'Historical mapping', historical: true });
    }
  }
  return [...roles.values()];
}

export async function validateSettings({ payload, config, catalog, host, companyId }) {
  const object = (value, label) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
    return value;
  };
  const roleBindings = object(payload.roleBindings ?? config.roleBindings, 'Role bindings');
  const userRoles = object(payload.userRoles ?? config.userRoles, 'Human roles');
  const known = new Set(settingsRoles(catalog).map(role => role.id));
  for (const pack of catalog.filter(pack => pack.id === 'adlc')) for (const id of Object.keys(pack.roles)) known.add(id);
  const defaultMode = payload.defaultMode ?? config.defaultMode;
  if (!['manual', 'assisted', 'autonomous'].includes(defaultMode)) throw new Error('Invalid company default decision mode');
  const deliveryLimits = normalizeDeliveryLimits(payload.deliveryLimits ?? config.deliveryLimits);
  for (const [role, id] of Object.entries(roleBindings)) {
    const preserved = !known.has(role) && config.roleBindings[role] === id;
    if ((!known.has(role) && !preserved) || typeof id !== 'string' || !id || !await host.agents.get(id, companyId)) {
      throw new Error(`Invalid agent binding for role ${role}`);
    }
  }
  const members = await host.access.members.list({ companyId });
  for (const [id, roles] of Object.entries(userRoles)) {
    if (!members.some(m => m.principalType === 'user' && m.principalId === id && m.status === 'active')) {
      throw new Error(`Inactive or unknown human user: ${id}`);
    }
    if (!Array.isArray(roles) || roles.some(role => role !== 'human-owner' &&
        ((!known.has(role) && !config.userRoles[id]?.includes(role)) || role === 'ceo'))) {
      throw new Error(`Invalid human role binding for ${id}`);
    }
  }
  return { roleBindings, userRoles, defaultMode, deliveryLimits };
}

// Only verified managed-resource identities are automatic. Names and titles are
// deliberately not authority: two people can share a name or a Pack role.
export async function mappingSuggestions({ host, companyId, roles, agents, bindings }) {
  const suggestions = {};
  for (const role of roles) {
    if (role.historical) continue;
    if (bindings[role.id] || (role.packId === 'adlc' && bindings[role.localId])) continue;
    const key = role.id === 'ceo' ? 'company:ceo' : role.id;
    const managed = await host.agents.managed.get(key, companyId);
    if (managed?.pluginKey === host.manifest.id && managed.resourceKey === key &&
        agents.some(agent => agent.id === managed.agentId && agent.status !== 'terminated')) {
      suggestions[role.id] = managed.agentId;
    }
  }
  return suggestions;
}
