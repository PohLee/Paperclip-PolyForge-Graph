import { randomUUID } from 'node:crypto';

const copy = structuredClone;

function linkedRun(state, plan, item) {
  const matches = Object.values(state.runs ?? {}).filter(run =>
    run.input?.planId === plan.id && run.input?.planItemId === item.id &&
    run.input?.paperclipCompanyId === plan.companyId && run.input?.projectId === plan.projectId &&
    run.packId === item.packId && run.packVersion === item.packVersion && run.graph?.id === item.graphId);
  if (matches.length > 1 || item.runId && matches[0]?.id !== item.runId) {
    throw new Error('Work item has ambiguous or mismatched linked run');
  }
  return matches[0] ?? null;
}

function runStatus(run) {
  return run.status === 'completed' ? 'completed' :
    ['failed', 'stopped', 'rework_required'].includes(run.status) ? 'blocked' : 'active';
}

export function plansNeedingReconciliation(state, planId) {
  return (state.control?.plans ?? []).filter(plan => !planId || plan.id === planId).filter(plan =>
    plan.items.some(item => {
      const run = linkedRun(state, plan, item);
      return run && (item.runId !== run.id || item.status !== runStatus(run));
    })).map(plan => plan.id);
}

export function workPlanItemContext(state, planId, itemId) {
  const plan = state.control?.plans?.find(entry => entry.id === planId);
  const item = plan?.items.find(entry => entry.id === itemId);
  if (!item) throw new Error('Work plan item not found');
  if (item.dependsOn.some(id => plan.items.find(other => other.id === id)?.status !== 'completed')) {
    throw new Error('Work plan dependencies are incomplete');
  }
  if (!state.control.enabledPacks?.some(entry => entry.packId === item.packId && entry.version === item.packVersion)) {
    throw new Error('Work plan Pack version is no longer enabled');
  }
  return { plan: copy(plan), item: copy(item), run: copy(linkedRun(state, plan, item)) };
}

export function updateWorkItem(state, plan, item, status) {
  if (!['pending', 'active', 'completed', 'blocked'].includes(status)) throw new Error('Invalid status');
  if (status === 'active' && item.dependsOn.some(id =>
    plan.items.find(other => other.id === id).status !== 'completed')) throw new Error('Dependencies incomplete');
  if (item.status === 'completed' && status !== 'completed') {
    throw new Error('Completed work item cannot be reopened without intervention');
  }
  if (status === 'active' || status === 'completed') {
    const run = linkedRun(state, plan, item);
    if (!run || status === 'completed' && run.status !== 'completed' ||
        status === 'active' && !['running', 'paused'].includes(run.status)) {
      throw new Error('Work item status requires matching Graph run state');
    }
    item.runId = run.id;
  }
  if (status === 'pending' && linkedRun(state, plan, item)) {
    throw new Error('Linked work item cannot return to pending');
  }
  item.status = status;
}

export function reconcileWorkPlan(state, plan, onChange) {
  const changes = [];
  for (const item of plan.items) {
    const run = linkedRun(state, plan, item);
    if (!run) continue;
    const status = runStatus(run);
    if (item.status === status && item.runId === run.id) continue;
    if (item.status === 'completed' && status !== 'completed') {
      throw new Error('Completed work item cannot be reopened without intervention');
    }
    const old = copy(item);
    item.status = status; item.runId = run.id;
    changes.push({ itemId: item.id, runId: run.id, oldStatus: old.status, status });
    onChange(old, copy(item), run);
  }
  if (changes.length) plan.version++;
  return { planId: plan.id, version: plan.version, changes };
}

export function authorizeWorkPlanRun(state, input, packId, packVersion, graphId) {
  if (input.planId === undefined && input.planItemId === undefined) return null;
  if (!input.planId || !input.planItemId || !state.control) {
    throw new Error('Complete company work plan context required');
  }
  const plan = state.control.plans?.find(entry => entry.id === input.planId);
  const item = plan?.items.find(entry => entry.id === input.planItemId);
  if (!item || plan.companyId !== state.control.companyId || plan.projectId !== input.projectId ||
      item.packId !== packId || item.packVersion !== packVersion || item.graphId !== graphId) {
    throw new Error('Work plan item does not authorize this Graph/project/version');
  }
  if (item.status !== 'pending' || item.runId || Object.values(state.runs ?? {}).some(run =>
    run.input?.planId === plan.id && run.input?.planItemId === item.id)) {
    throw new Error('Work plan item already started or unavailable');
  }
  if (item.dependsOn?.some(id => plan.items.find(other => other.id === id)?.status !== 'completed')) {
    throw new Error('Work plan dependencies are incomplete');
  }
  return { plan, item };
}

export function linkWorkPlanRun(state, planned, run, actor, at) {
  if (!planned) return;
  const { plan, item } = planned;
  const old = { id: item.id, status: item.status, runId: item.runId ?? null };
  item.status = 'active'; item.runId = run.id; item.startedAt = at; plan.version++;
  const event = { id: randomUUID(), companyId: state.control.companyId, kind: 'work-item.run-linked',
    actor: copy(actor), reason: 'Started the pinned Graph run for this work plan item', oldRef: old,
    newRef: { id: item.id, status: item.status, runId: run.id }, planId: plan.id, runId: run.id, at };
  state.control.audit.push(event); state.audit.push(copy(event));
}
