// The process fixture runs through the native Shadow runtime; these helpers
// retain fixture discovery and pinned actor scoping.
const FIXTURE_SCRIPT = '/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs';

export function fixtureShadowAgent(agent) {
  const config = agent?.adapterConfig;
  return agent?.adapterType === 'process' && config?.command === 'node' &&
    Array.isArray(config.args) && config.args.length === 1 && config.args[0] === FIXTURE_SCRIPT &&
    Number.isInteger(config.timeoutSec) && config.timeoutSec > 0 && config.timeoutSec <= 900 &&
    agent.status === 'idle' && Number.isFinite(agent.budgetMonthlyCents) &&
    Number.isFinite(agent.spentMonthlyCents) && agent.budgetMonthlyCents > agent.spentMonthlyCents;
}

export async function fixtureShadowAvailable(host, companyId, agentIds) {
  for (const id of agentIds) {
    let agent;
    try { agent = await host.agents.get(id, companyId); }
    catch { return false; } // No authorized native scope means capability is unavailable.
    if (agent?.companyId === companyId && fixtureShadowAgent(agent)) return true;
  }
  return false;
}

// Host bindings are Pack-qualified; Core evaluates roles inside the pinned Pack.
// Add only this run's node role, never a same-named role from another Pack.
export function shadowActorForRun(actor, run, node) {
  if (actor.kind !== 'agent') return actor;
  if (!actor.executionId || !actor.roles?.includes(`${run.packId}:${node.role}`)) {
    throw new Error('Owning Graph Agent run required');
  }
  return { ...actor, roles: [...new Set([...actor.roles, node.role])] };
}
