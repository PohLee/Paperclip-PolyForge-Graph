import { DELIVERY_LIMITS } from '../core/delivery-limits.mjs';

const attemptKey = (runId, nodeId, attempt, phase) => JSON.stringify([runId, nodeId, attempt, phase]);
const activeAttempt = (run, node) => {
  const state = run.nodeStates[node.id];
  if (!['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(state?.status)) return null;
  const phase = state.status === 'awaiting_supervisor_review' ? 'supervisor' : 'work';
  const attempt = (state.attempts?.length ?? 0) + (state.status === 'pending' ? 1 : 0);
  return attemptKey(run.id, node.id, attempt, phase);
};

export function createDispatchAdmission(persistence, currentDispatches) {
  async function prepare(companyId, run) {
    const cap = run.deliveryLimits?.parallelAgents ?? DELIVERY_LIMITS.parallelAgents;
    const state = await persistence.readState?.(companyId);
    const runs = run.deliveryKey
      ? Object.values(state?.runs ?? { [run.id]: run }).filter((other) => other.deliveryKey === run.deliveryKey)
      : [run];
    const live = runs.filter((other) => other.status === 'running');
    const liveKeys = live.flatMap((other) => other.graph.nodes.map((node) => activeAttempt(other, node)).filter(Boolean));
    const reserved = run.deliveryKey && persistence.reconcileSlots
      ? new Set(await persistence.reconcileSlots(companyId, run.deliveryKey, liveKeys)) : new Set();
    const active = (await Promise.all(live.map((other) => currentDispatches(companyId, other)))).flat()
      .map((entry) => ({ ...entry, key: attemptKey(entry.runId, entry.nodeId, entry.attempt, entry.phase) }));
    const legacyCount = active.filter((entry) => !reserved.has(entry.key)).length;
    const ownKeys = new Set(active.filter((entry) => entry.runId === run.id).map((entry) => entry.key));
    let occupied = active.length;
    return {
      async admit(nodeId, attempt, phase) {
        const key = attemptKey(run.id, nodeId, attempt, phase);
        if (ownKeys.has(key)) return true;
        if (occupied >= cap) return false;
        if (run.deliveryKey && persistence.reserveSlot &&
          !await persistence.reserveSlot({ companyId, deliveryKey: run.deliveryKey,
            attemptKey: key, limit: Math.max(0, cap - legacyCount) })) return false;
        occupied++;
        ownKeys.add(key);
        return true;
      },
    };
  }
  return { prepare };
}
