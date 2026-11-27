import semver from 'semver';

export const MCP_MINIMUMS = Object.freeze({ git: '2026.11.18', filesystem: '2.4.0',
  everything: '2.3.1', fetch: '2026.11.11', inspector: '2.14.0' });
/** Resource budget for already parsed JSON, not an MCP gateway or JSON Schema validator.
 * Pattern text is only counted, never compiled or executed. */
export function checkMcpConfigBudget(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 2000 || item.depth > 12) return { ok: false, error: 'Configuration exceeds structural budget' };
    if (typeof item.value === 'string' && item.value.length > 4096) return { ok: false, error: 'Configuration string exceeds budget' };
    if (item.value && typeof item.value === 'object') {
      const entries = Object.entries(item.value);
      if (entries.length > 100) return { ok: false, error: 'Configuration object exceeds budget' };
      for (const [key, child] of entries) {
        if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key))
          return { ok: false, error: 'Invalid configuration key' };
        if (key === 'pattern' && (typeof child !== 'string' || child.length > 256))
          return { ok: false, error: 'Pattern exceeds budget' };
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else if (item.value !== null && !['string', 'number', 'boolean'].includes(typeof item.value)) {
      return { ok: false, error: 'Configuration must contain JSON values' };
    }
  }
  return { ok: true };
}
/** A secret-free, operator-attested deployment inventory, not an installation scanner. */
export function checkMcpDeploymentInventory(inventory) {
  const errors = [];
  const budget = checkMcpConfigBudget(inventory);
  if (!budget.ok) return { ok: false, errors: [budget.error] };
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
      Object.keys(inventory).some(key => !['schema', 'complete', 'servers'].includes(key)) ||
      inventory.schema !== 'polyforge.mcp-inventory.v1' || inventory.complete !== true ||
      !Array.isArray(inventory.servers) || inventory.servers.length > 100) {
    return { ok: false, errors: ['Inventory must be a complete bounded v1 deployment inventory'] };
  }
  const seen = new Set();
  for (const entry of inventory.servers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['id', 'kind', 'version'].includes(key)) ||
        typeof entry.id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(entry.id) || seen.has(entry.id) ||
        !Object.hasOwn(MCP_MINIMUMS, entry.kind) || typeof entry.version !== 'string' ||
        !/^\d{1,4}\.\d{1,2}\.\d{1,2}$/.test(entry.version) || !semver.valid(entry.version) ||
        (['git', 'fetch'].includes(entry.kind) ? Number(entry.version.split('.')[0]) < 2000
          : Number(entry.version.split('.')[0]) >= 2000)) {
      errors.push('Invalid or duplicate inventory entry'); continue;
    }
    seen.add(entry.id);
    if (semver.lt(entry.version, MCP_MINIMUMS[entry.kind])) errors.push(`${entry.id}: below ${entry.kind} minimum ${MCP_MINIMUMS[entry.kind]}`);
  }
  return { ok: errors.length === 0, errors };
}
