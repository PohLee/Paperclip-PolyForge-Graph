import { randomUUID } from 'node:crypto';
import { MemoryStore, RevisionConflict } from './store.mjs';
import { preflightPackChange, capabilityAvailable } from './compatibility.mjs';

const copy = structuredClone;
const required = (value, name) => { if (value === undefined || value === null || value === '') throw new Error(`${name} is required`); return value; };
const stable = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const owner = actor => actor.kind === 'human' && actor.roles.includes('human-owner');
function identity(actor) {
  if (!actor || !['human', 'agent', 'system'].includes(actor.kind) || !actor.id || !Array.isArray(actor.roles)) throw new Error('Trusted actor required');
  if (actor.kind === 'agent' && !actor.executionId) throw new Error('Agent executionId is required');
  return { id: actor.id, kind: actor.kind, roles: [...actor.roles], executionId: actor.executionId ?? null };
}
function initial(companyId) {
  return { companyId, organization: null, enabledPacks: [], intake: [], plans: [], goalHistory: [], knowledge: [], feedback: [], evidenceReceipts: [], handoffs: [], shadowContexts: [], shadows: [], reviews: [], adjustments: [], escalations: [], notificationPreferences: [], outbox: [], audit: [] };
}
function control(state, companyId) {
  state.control ??= initial(companyId);
  if (state.control.companyId !== companyId) throw new Error('Company store isolation violation');
  return state.control;
}
function decision(c, kind, actor, reason, oldRef, newRef, at, details = {}) {
  const event = { id: randomUUID(), companyId: c.companyId, kind, actor: copy(actor), reason: required(reason, 'reason'), oldRef: oldRef ?? null, newRef: newRef ?? null, at, ...copy(details) };
  c.audit.push(event);
  return event;
}
function notify(c, subjectId, eventKind, ref, at) {
  if (!subjectId) return;
  const preferences = c.notificationPreferences.find(item => item.subjectId === subjectId);
  if (preferences && preferences.events.length && !preferences.events.includes(eventKind)) return;
  c.outbox.push({ id: randomUUID(), companyId: c.companyId, subjectId, eventKind, ref, channels: copy(preferences?.channels ?? ['in-app']), deliveryStatus: 'pending', readAt: null, at });
}
function authority(c, actor, scope = 'ceo') {
  if (owner(actor)) return;
  const org = c.organization;
  if (!org) throw new Error('Company setup is required');
  if (scope === 'ceo' && actor.kind === 'agent' && actor.id === org.ceo.id) return;
  if (scope.startsWith('domain:') && actor.kind === 'agent' && (actor.id === org.ceo.id || org.domainHeads.some(head => head.domain === scope.slice(7) && head.agentId === actor.id))) return;
  throw new Error(`Actor lacks ${scope} authority`);
}
function canManageAgent(c, actor, subjectId) {
  if (owner(actor) || actor.kind === 'agent' && actor.id === c.organization?.ceo?.id) return true;
  return actor.kind === 'agent' && c.organization?.domainHeads.some(head => head.agentId === actor.id && head.subordinateIds?.includes(subjectId));
}
function currentGoals(c, subjectId, scope) { return [...c.goalHistory].reverse().find(item => item.subjectId === subjectId && (!scope || item.scope === scope)) ?? null; }
function allCurrentGoals(c) {
  const result = new Map();
  for (const item of c.goalHistory) result.set(`${item.scope}:${item.subjectId}`, item);
  return [...result.values()];
}
function linkedPlanRun(state, plan, item) {
  const matches = Object.values(state.runs ?? {}).filter(run =>
    run.input?.planId === plan.id && run.input?.planItemId === item.id &&
    run.input?.paperclipCompanyId === plan.companyId && run.input?.projectId === plan.projectId &&
    run.packId === item.packId && run.packVersion === item.packVersion && run.graph?.id === item.graphId);
  if (matches.length > 1 || item.runId && matches[0]?.id !== item.runId) throw new Error('Work item has ambiguous or mismatched linked run');
  return matches[0] ?? null;
}
function validateGoals(c, goals, subjectId) {
  if (!Array.isArray(goals)) throw new Error('goals must be an array');
  const ids = new Set();
  const parents = new Set(allCurrentGoals(c).filter(item => item.subjectId !== subjectId).flatMap(item => item.goals.map(goal => goal.id)));
  for (const goal of goals) {
    required(goal.id, 'goal.id'); required(goal.title, 'goal.title');
    if (ids.has(goal.id)) throw new Error('Duplicate goal id');
    ids.add(goal.id);
    if (!Array.isArray(goal.keyResults) || goal.keyResults.length === 0) throw new Error('Measurable key results required');
    for (const kr of goal.keyResults) {
      for (const field of ['id', 'target', 'unit', 'source', 'window']) required(kr[field], `keyResult.${field}`);
      if (typeof kr.target !== 'number' || !Number.isFinite(kr.target)) throw new Error('Key result target must be finite');
      if (kr.baseline !== undefined && (typeof kr.baseline !== 'number' || !Number.isFinite(kr.baseline))) throw new Error('Invalid key result baseline');
      if (kr.windowEnd !== undefined && !Number.isFinite(Date.parse(kr.windowEnd))) throw new Error('Invalid key result windowEnd');
    }
  }
  for (const goal of goals) if (goal.parentGoalId && !ids.has(goal.parentGoalId) && !parents.has(goal.parentGoalId)) throw new Error(`Unknown parent goal: ${goal.parentGoalId}`);
}
function shadowContext(c, run, args) {
  const ref = args.contextRef;
  const snapshot = (c.shadowContexts ?? []).find(item => item.id === ref?.snapshotId && item.parentRunId === run.id && item.parentTaskId === args.parentTaskId);
  if (!snapshot || ref.sourceRunId !== run.id || ref.sourceNodeId !== args.parentTaskId || ref.payloadDigest !== snapshot.payloadDigest) throw new Error('Verified shadow context snapshot required');
  const current = Object.values(run.nodeStates).filter(node => node.status === 'completed').flatMap(node => node.artifacts ?? []);
  if (snapshot.candidateRefs.some(candidate => !current.some(item => item.id === candidate.id && item.version === candidate.version && (!candidate.digest || item.digest === candidate.digest)))) {
    throw new Error('Shadow context candidate is stale');
  }
  return snapshot;
}
function assertShadowScope(c, run, args, actor, at, availableCapabilities) {
  if (!capabilityAvailable(run.pack, run.graph, 'shadow-review-execution', { availableCapabilities })) throw new Error('Shadow execution capability unavailable');
  const node = run.graph.nodes.find(item => item.id === args.parentTaskId);
  const nodeOwner = actor.kind === 'agent' && node?.role && actor.roles.includes(node.role) && run.nodeStates[args.parentTaskId].status !== 'completed';
  if (!nodeOwner) authority(c, actor);
  for (const field of ['role', 'sessionId', 'contextRef', 'scope']) required(args[field], field);
  if (!Array.isArray(args.scope.allowedActions) || !args.scope.allowedActions.length || args.scope.maxTasks !== 1 ||
      args.scope.maxConcurrent !== 1 || !args.scope.deadlineAt || Date.parse(args.scope.deadlineAt) <= Date.parse(at)) throw new Error('Bounded shadow scope requires one task, one concurrent session and future deadline');
  if (args.scope.maxCostUsd !== undefined && !capabilityAvailable(run.pack, run.graph, 'shadow-cost-metering', { availableCapabilities })) throw new Error('Shadow dollar cap requires cost metering');
  const allowed = node?.shadowAllowedActions ?? ['analyze', 'review', 'research', 'draft'];
  if (args.scope.allowedActions.some(action => !allowed.includes(action))) throw new Error('Shadow action exceeds parent node authority');
  if (c.shadows.some(item => ['reserved', 'active'].includes(item.status) && item.parentRunId === run.id && item.parentTaskId === args.parentTaskId)) throw new Error('Parent task already has a shadow session');
  return shadowContext(c, run, args);
}

export class CompanyControlPlane {
  constructor({ store = new MemoryStore(), companyId, now = () => new Date().toISOString(), availableCapabilities = {}, trustedProviders = [] } = {}) {
    this.store = store; this.companyId = required(companyId, 'companyId'); this.now = now; this.availableCapabilities = availableCapabilities;
    this.trustedProviders = new Set(trustedProviders); this.queue = Promise.resolve();
  }
  async #read() { return (await this.store.read()) ?? { revision: 0, packs: {}, runs: {}, decisions: [], audit: [], idempotency: {} }; }
  async #change(operation, args, fn) {
    const actor = identity(args.actor), request = { ...args, actor }, key = args.idempotencyKey && `company:${this.companyId}:${operation}:${args.idempotencyKey}`;
    const task = this.queue.then(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await this.#read();
        state.idempotency ??= {};
        const signature = stable(request);
        if (key && state.idempotency[key]) {
          const saved = state.idempotency[key];
          if (saved.fingerprint !== signature) throw new Error('Idempotency key reused with different request or actor');
          return copy(saved.result);
        }
        const c = control(state, this.companyId), auditLength = c.audit.length, result = fn(c, state, actor, this.now());
        state.audit ??= [];
        state.audit.push(...copy(c.audit.slice(auditLength)));
        if (key) state.idempotency[key] = { fingerprint: signature, result: copy(result) };
        const expected = state.revision; state.revision++;
        try { await this.store.write(state, expected); return copy(result); }
        catch (error) { if (!(error instanceof RevisionConflict) && error.name !== 'RevisionConflict') throw error; if (attempt === 7) throw error; }
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async #control() { const state = await this.#read(); if (state.control?.companyId && state.control.companyId !== this.companyId) throw new Error('Company store isolation violation'); return copy(state.control ?? initial(this.companyId)); }
  async getSetup() {
    const c = await this.#control();
    return { companyId: this.companyId, organization: c.organization, enabledPacks: c.enabledPacks, ready: Boolean(c.organization?.board?.id && c.organization?.ceo?.id && c.organization.domainHeads?.length && c.enabledPacks.length) };
  }
  async configureSetup(args) { return this.#change('setup', args, (c, _state, actor, at) => {
    if (!owner(actor)) throw new Error('Company setup requires human owner');
    const org = args.organization;
    required(org?.board?.id, 'board.id'); required(org?.ceo?.id, 'ceo.id');
    if (!Array.isArray(org.domainHeads) || !org.domainHeads.every(head => head.domain && head.agentId)) throw new Error('domainHeads required');
    if (org.board.id === org.ceo.id || org.domainHeads.some(head => head.agentId === org.ceo.id)) throw new Error('Organization roles need distinct identities');
    const prior = c.organization;
    c.organization = copy(org);
    decision(c, 'organization.configured', actor, args.reason, prior, org, at);
    return copy(c.organization);
  }); }
  async enablePack(args) { return this.#change('enable-pack', args, (c, state, actor, at) => {
    authority(c, actor);
    const pack = state.packs?.[`${args.packId}@${args.version}`];
    if (!pack) throw new Error('Pack release missing from instance catalog');
    const prior = c.enabledPacks.find(item => item.packId === args.packId) ?? null;
    const candidate = { packId: args.packId, version: args.version };
    const report = preflightPackChange({ catalog: Object.values(state.packs), enabled: c.enabledPacks, candidate,
      activeRuns: Object.values(state.runs ?? {}), availableCapabilities: this.availableCapabilities });
    if (!report.ok) throw new Error(`Pack preflight failed: ${report.issues.join('; ')}`);
    c.enabledPacks = [...c.enabledPacks.filter(item => item.packId !== args.packId), candidate];
    decision(c, 'pack.enabled', actor, args.reason, prior, candidate, at);
    return candidate;
  }); }
  async createIntake(args) { return this.#change('intake-create', args, (c, _state, actor, at) => {
    required(args.projectId, 'projectId'); required(args.title, 'title');
    const origin = source => source?.channel && source.senderId && source.messageId
      ? stable([source.channel, String(source.senderId), String(source.messageId), source.chatId ?? source.issueId ?? null]) : null;
    const sourceKey = origin(args.source);
    const existing = sourceKey && c.intake.find(item => origin(item.source) === sourceKey);
    if (existing) {
      const immutable = item => ({ projectId: item.projectId, title: item.title,
        description: item.description ?? '', requestedPackId: item.requestedPackId ?? null,
        attachments: item.attachments ?? [], contextRefs: item.contextRefs ?? [] });
      if (stable(immutable(existing)) !== stable(immutable(args))) throw new Error('Intake source message reused with different request');
      return existing;
    }
    const item = { id: randomUUID(), companyId: c.companyId, projectId: args.projectId, title: args.title, description: args.description ?? '', requestedPackId: args.requestedPackId ?? null,
      source: copy(args.source ?? null), attachments: copy(args.attachments ?? []), contextRefs: copy(args.contextRefs ?? []),
      assigneeId: args.assigneeId ?? null, status: args.assigneeId ? 'offered' : 'ceo-review', history: [], createdAt: at };
    c.intake.push(item);
    item.history.push(decision(c, 'intake.created', actor, args.reason, null, { id: item.id, status: item.status }, at));
    notify(c, item.assigneeId ?? c.organization?.ceo?.id, 'intake.created', { intakeId: item.id }, at);
    return item;
  }); }
  async routeIntake(args) { return this.#change('intake-route', args, (c, _state, actor, at) => {
    const item = c.intake.find(entry => entry.id === args.intakeId);
    if (!item) throw new Error('Intake not found');
    const ownOffer = actor.kind === 'agent' && item.assigneeId === actor.id && item.status === 'offered';
    const ceo = owner(actor) || actor.kind === 'agent' && actor.id === c.organization?.ceo?.id;
    if (!ownOffer && !ceo) throw new Error('Intake routing requires assignee or CEO');
    if (!['accept', 'reject', 'forward-ceo', 'assign', 'cancel'].includes(args.outcome)) throw new Error('Invalid intake outcome');
    if (ownOffer && !['accept', 'reject', 'forward-ceo'].includes(args.outcome)) throw new Error('Assignee cannot reassign');
    if (args.outcome === 'cancel' && !owner(actor)) throw new Error('Cancellation requires human owner');
    if (['accepted', 'rejected', 'cancelled'].includes(item.status)) throw new Error('Intake already resolved');
    if (args.outcome === 'assign') required(args.assigneeId, 'assigneeId');
    const old = { status: item.status, assigneeId: item.assigneeId };
    item.status = args.outcome === 'reject' && ownOffer ? 'ceo-review'
      : ({ accept: 'accepted', reject: 'rejected', 'forward-ceo': 'ceo-review', assign: 'offered', cancel: 'cancelled' })[args.outcome];
    if (args.outcome === 'assign') item.assigneeId = args.assigneeId;
    if (ownOffer && ['reject', 'forward-ceo'].includes(args.outcome)) item.assigneeId = null;
    const event = decision(c, 'intake.routed', actor, args.reason, old, { id: item.id, status: item.status, assigneeId: item.assigneeId }, at);
    item.history.push(event);
    notify(c, item.status === 'offered' ? item.assigneeId : c.organization?.ceo?.id, 'intake.routed', { intakeId: item.id }, at);
    return item;
  }); }
  async escalateDecision(args) { return this.#change('decision-escalate', args, (c, _state, actor, at) => {
    if (!['intake', 'work-plan', 'agent-goal', 'cross-pack', 'strategy'].includes(args.subjectType)) throw new Error('Unsupported escalation subject');
    required(args.subjectId, 'subjectId'); required(args.question, 'question');
    if (!Array.isArray(args.options) || args.options.length < 2 || new Set(args.options.map(item => item.id)).size !== args.options.length) throw new Error('Distinct decision options required');
    const authoritySet = c.organization?.authorityPolicy?.ceoDecisions ?? ['intake', 'work-plan', 'agent-goal'];
    const eligibleRole = authoritySet.includes(args.subjectType) ? 'ceo' : 'human-owner';
    const item = { id: randomUUID(), companyId: c.companyId, subjectType: args.subjectType, subjectId: args.subjectId,
      question: args.question, options: copy(args.options), evidence: copy(args.evidence ?? []), status: 'pending', eligibleRole, openedAt: at };
    c.escalations.push(item);
    decision(c, 'decision.escalated', actor, args.reason, null, { id: item.id, eligibleRole }, at);
    notify(c, eligibleRole === 'ceo' ? c.organization?.ceo?.id : c.organization?.board?.id, 'decision.escalated', { escalationId: item.id }, at);
    return item;
  }); }
  async adjudicate(args) { return this.#change('decision-adjudicate', args, (c, _state, actor, at) => {
    const item = c.escalations.find(entry => entry.id === args.escalationId);
    if (!item || item.status !== 'pending') throw new Error('Pending escalation not found');
    if (item.eligibleRole === 'human-owner' && !owner(actor)) throw new Error('Human owner decision required');
    if (item.eligibleRole === 'ceo') authority(c, actor);
    if (!item.options.some(option => option.id === args.outcome)) throw new Error('Outcome must match recorded option');
    if (!Array.isArray(args.evidence) || !args.evidence.length) throw new Error('Adjudication evidence required');
    item.status = 'resolved'; item.outcome = args.outcome; item.resolvedAt = at; item.resolvedBy = actor; item.resolutionEvidence = copy(args.evidence);
    decision(c, 'decision.adjudicated', actor, args.reason, { id: item.id, status: 'pending' }, { id: item.id, status: 'resolved', outcome: args.outcome }, at);
    return item;
  }); }
  async createWorkPlan(args) { return this.#change('work-plan-create', args, (c, state, actor, at) => {
    authority(c, actor); required(args.projectId, 'projectId');
    if (!Array.isArray(args.items) || !args.items.length) throw new Error('Work plan items required');
    const ids = new Set(args.items.map(item => item.id));
    if (ids.size !== args.items.length) throw new Error('Duplicate work item');
    for (const item of args.items) {
      required(item.id, 'item.id'); required(item.packId, 'item.packId'); required(item.graphId, 'item.graphId');
      const enabled = c.enabledPacks.find(pack => pack.packId === item.packId);
      if (!enabled) throw new Error(`Pack ${item.packId} not enabled`);
      if (!state.packs?.[`${item.packId}@${enabled.version}`]?.graphs?.some(graph => graph.id === item.graphId)) throw new Error(`Graph ${item.graphId} is not in enabled Pack`);
      if (!Number.isInteger(item.priority) || item.priority < 1) throw new Error('Positive integer priority required');
      if ((item.dependsOn ?? []).some(id => !ids.has(id) || id === item.id)) throw new Error('Invalid dependency');
    }
    const visit = (id, stack = new Set(), seen = new Set()) => {
      if (stack.has(id)) throw new Error('Work plan dependency cycle');
      if (seen.has(id)) return;
      stack.add(id);
      for (const dep of args.items.find(item => item.id === id).dependsOn ?? []) visit(dep, stack, seen);
      stack.delete(id); seen.add(id);
    };
    for (const id of ids) visit(id);
    const plan = { id: randomUUID(), companyId: c.companyId, projectId: args.projectId,
      items: copy(args.items.map(item => ({ ...item, packVersion: c.enabledPacks.find(pack => pack.packId === item.packId).version, status: 'pending', dependsOn: item.dependsOn ?? [] }))), version: 1, createdAt: at };
    c.plans.push(plan); decision(c, 'work-plan.created', actor, args.reason, null, { id: plan.id, version: 1 }, at);
    return plan;
  }); }
  async updateWorkItem(args) { return this.#change('work-item-update', args, (c, state, actor, at) => {
    authority(c, actor);
    const plan = c.plans.find(item => item.id === args.planId), item = plan?.items.find(entry => entry.id === args.itemId);
    if (!item) throw new Error('Work item not found');
    const old = copy(item);
    if (args.priority !== undefined) { if (!Number.isInteger(args.priority) || args.priority < 1) throw new Error('Invalid priority'); item.priority = args.priority; }
    if (args.status !== undefined) {
      if (!['pending', 'active', 'completed', 'blocked'].includes(args.status)) throw new Error('Invalid status');
      if (args.status === 'active' && item.dependsOn.some(id => plan.items.find(other => other.id === id).status !== 'completed')) throw new Error('Dependencies incomplete');
      if (old.status === 'completed' && args.status !== 'completed') throw new Error('Completed work item cannot be reopened without intervention');
      if (args.status === 'active' || args.status === 'completed') {
        const run = linkedPlanRun(state, plan, item);
        if (!run || args.status === 'completed' && run.status !== 'completed' ||
            args.status === 'active' && !['running', 'paused'].includes(run.status)) {
          throw new Error('Work item status requires matching Graph run state');
        }
        item.runId = run.id;
      }
      if (args.status === 'pending' && linkedPlanRun(state, plan, item)) throw new Error('Linked work item cannot return to pending');
      item.status = args.status;
    }
    if (stable(old) === stable(item)) return plan;
    plan.version++;
    decision(c, 'work-item.updated', actor, args.reason, old, copy(item), at, { planId: plan.id });
    return plan;
  }); }
  async reconcileWorkPlan(args) { return this.#change('work-plan-reconcile', args, (c, state, actor, at) => {
    if (!(actor.kind === 'system' && actor.roles.includes('work-plan-reconciler'))) authority(c, actor);
    const plan = c.plans.find(item => item.id === args.planId);
    if (!plan) throw new Error('Work plan not found');
    const changes = [];
    for (const item of plan.items) {
      const run = linkedPlanRun(state, plan, item);
      if (!run) continue;
      const status = run.status === 'completed' ? 'completed' :
        ['failed', 'stopped', 'rework_required'].includes(run.status) ? 'blocked' : 'active';
      if (item.status === status && item.runId === run.id) continue;
      const old = copy(item);
      item.status = status; item.runId = run.id;
      const change = { itemId: item.id, runId: run.id, oldStatus: old.status, status };
      changes.push(change);
      decision(c, 'work-item.reconciled', actor, args.reason, old, copy(item), at, { planId: plan.id, runId: run.id });
    }
    if (changes.length) plan.version++;
    return { planId: plan.id, version: plan.version, changes };
  }); }
  async setGoals(args) { return this.#change('goals-set', args, (c, _state, actor, at) => {
    if (!['company', 'agent'].includes(args.scope)) throw new Error('Invalid goal scope');
    if (args.scope === 'company' && args.subjectId !== c.companyId) throw new Error('Company goals must name this company');
    if (args.scope === 'agent' && args.subjectId === c.companyId) throw new Error('Agent goals cannot name the company');
    if (args.scope === 'company' && !owner(actor)) throw new Error('Company commitments require human owner');
    else if (!canManageAgent(c, actor, args.subjectId)) throw new Error('Actor cannot set subordinate goals');
    required(args.subjectId, 'subjectId'); validateGoals(c, args.goals, args.subjectId);
    const prior = currentGoals(c, args.subjectId, args.scope);
    const revision = { id: randomUUID(), companyId: c.companyId, scope: args.scope, subjectId: args.subjectId, version: (prior?.version ?? 0) + 1, goals: copy(args.goals), createdAt: at, supersedes: prior?.id ?? null };
    c.goalHistory.push(revision);
    decision(c, 'goals.revised', actor, args.reason, prior && { id: prior.id, version: prior.version }, { id: revision.id, version: revision.version }, at);
    notify(c, args.subjectId, 'goals.revised', { goalRevisionId: revision.id }, at);
    return revision;
  }); }
  async getGoalContext({ agentId } = {}) {
    const c = await this.#control();
    const current = allCurrentGoals(c).filter(item => item.scope === 'company' || !agentId || item.subjectId === agentId);
    return { companyId: c.companyId, capturedAt: this.now(), revisions: current.map(item => copy(item)) };
  }
  async recordKnowledge(args) { return this.#change('knowledge-record', args, (c, _state, actor, at) => {
    required(args.projectId, 'projectId'); required(args.title, 'title');
    if (!['product', 'decision'].includes(args.kind) || !Array.isArray(args.sourceRefs) || !args.sourceRefs.length) throw new Error('Knowledge needs kind and sources');
    const item = { id: randomUUID(), companyId: c.companyId, projectId: args.projectId, kind: args.kind, title: args.title, body: args.body ?? '', sourceRefs: copy(args.sourceRefs), at, actor };
    c.knowledge.push(item); decision(c, 'knowledge.recorded', actor, args.reason, null, { id: item.id }, at);
    return item;
  }); }
  async queryKnowledge({ projectId, kind, q } = {}) {
    const c = await this.#control(), query = q?.toLowerCase();
    return c.knowledge.filter(item => (!projectId || item.projectId === projectId) && (!kind || item.kind === kind) && (!query || `${item.title} ${item.body}`.toLowerCase().includes(query)));
  }
  async appendFeedback(args) { return this.#change('feedback-append', args, (c, _state, actor, at) => {
    required(args.projectId, 'projectId'); required(args.body, 'body');
    const item = { id: randomUUID(), companyId: c.companyId, projectId: args.projectId, subjectId: args.subjectId ?? null, body: args.body, sourceRefs: copy(args.sourceRefs ?? []), actor, at };
    c.feedback.push(item); decision(c, 'feedback.appended', actor, args.reason, null, { id: item.id }, at);
    notify(c, c.organization?.ceo?.id, 'feedback.appended', { feedbackId: item.id }, at);
    return item;
  }); }
  async recordEvidenceReceipt(args) { return this.#change('evidence-receipt', args, (c, _state, actor, at) => {
    const receipt = args.receipt;
    if (actor.kind !== 'system' || !receipt?.providerId || !this.trustedProviders.has(receipt.providerId) ||
        !actor.roles.includes(`evidence-provider:${receipt.providerId}`)) throw new Error('Receipt requires authenticated evidence provider');
    for (const field of ['id', 'companyId', 'projectId', 'kind', 'issuedAt', 'expiresAt']) required(receipt[field], `receipt.${field}`);
    if (receipt.companyId !== c.companyId || !['release', 'metric'].includes(receipt.kind) ||
        !Array.isArray(receipt.subjectRefs) || !receipt.subjectRefs.length ||
        receipt.subjectRefs.some(ref => !ref.id || !ref.version)) throw new Error('Invalid company evidence receipt');
    const issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt), now = Date.parse(at);
    if (![issued, expires].every(Number.isFinite) || issued > now || expires <= now || expires <= issued) throw new Error('Evidence receipt is stale or invalid');
    if (receipt.kind === 'metric') {
      const data = receipt.data;
      if (!data?.goalRevisionId || !data.goalId || !data.keyResultId || !data.source || !data.window ||
          typeof data.value !== 'number' || !Number.isFinite(data.value) || !Number.isFinite(Date.parse(data.observedAt)) ||
          Date.parse(data.observedAt) > issued) {
        throw new Error('Invalid metric evidence receipt');
      }
    } else {
      const data = receipt.data;
      if (!data?.sourceRunId || !data.releaseEvent?.id || !data.releaseEvent?.version || !data.candidate?.id ||
          !data.candidate?.version || !data.authorizationDecisionId) throw new Error('Invalid release evidence receipt');
    }
    c.evidenceReceipts ??= [];
    const existing = c.evidenceReceipts.find(item => item.id === receipt.id);
    if (existing) { if (stable(existing.receipt) !== stable(receipt)) throw new Error('Evidence receipt ID reused with different payload'); return existing; }
    const item = { id: receipt.id, companyId: c.companyId, receipt: copy(receipt), authenticatedBy: actor, recordedAt: at };
    c.evidenceReceipts.push(item);
    decision(c, 'evidence.receipt-recorded', actor, args.reason, null, { id: item.id, kind: receipt.kind, providerId: receipt.providerId }, at);
    return item;
  }); }
  async takeOver(args) { return this.#change('human-takeover', args, (c, state, actor, at) => {
    if (!owner(actor)) throw new Error('Human takeover requires owner');
    const run = state.runs?.[args.runId];
    if (!run || !run.nodeStates?.[args.nodeId] || !['running', 'paused'].includes(run.status) || run.takeover) throw new Error('Active run/node without takeover required');
    const previousStatus = run.status;
    run.takeover = { id: randomUUID(), nodeId: args.nodeId, actor, reason: required(args.reason, 'reason'), at, previousStatus };
    run.status = 'paused'; run.updatedAt = at;
    decision(c, 'run.taken-over', actor, args.reason, { runId: run.id, status: previousStatus }, { runId: run.id, takeoverId: run.takeover.id, status: 'paused' }, at);
    return { runId: run.id, takeover: run.takeover };
  }); }
  async resolveTakeover(args) { return this.#change('human-takeover-resolve', args, (c, state, actor, at) => {
    if (!owner(actor)) throw new Error('Human takeover resolution requires owner');
    const run = state.runs?.[args.runId];
    if (!run?.takeover || run.takeover.id !== args.takeoverId) throw new Error('Active takeover not found');
    if (!['resume', 'stop'].includes(args.outcome)) throw new Error('Invalid takeover outcome');
    if (args.outcome === 'resume' && (run.pendingHuman || run.conflicts?.some(item => item.status === 'waiting_human'))) throw new Error('Pending human gate must be resolved first');
    const old = copy(run.takeover);
    run.status = args.outcome === 'resume' ? 'running' : 'stopped'; run.updatedAt = at; run.takeover = null;
    decision(c, 'run.takeover-resolved', actor, args.reason, { runId: run.id, takeoverId: old.id }, { runId: run.id, outcome: args.outcome }, at);
    return { runId: run.id, status: run.status, takeoverId: old.id };
  }); }
  async recordHandoff(args) { return this.#change('handoff-record', args, (c, state, actor, at) => {
    authority(c, actor); required(args.projectId, 'projectId'); required(args.sourceRunId, 'sourceRunId');
    const run = state.runs?.[args.sourceRunId];
    if (!run || run.input?.projectId !== args.projectId) throw new Error('Source run/project mismatch');
    if (run.status !== 'completed') throw new Error('Source run is not completed');
    const targetSelection = c.enabledPacks.find(item => item.packId === args.targetPackId);
    if (!targetSelection) throw new Error('Target Pack not enabled');
    const targetPack = state.packs?.[`${args.targetPackId}@${targetSelection.version}`];
    const targetGraph = targetPack?.graphs.find(item => item.id === args.targetGraphId);
    if (!targetGraph) throw new Error('Target Graph missing from enabled release');
    required(args.contract, 'contract'); required(args.contractVersion, 'contractVersion');
    if (!args.sourceEvent?.id || !args.sourceEvent?.digest || !Array.isArray(args.artifacts) || args.artifacts.some(item => !item.id || !item.version || !item.digest)) throw new Error('Handoff needs versioned source event and artifacts');
    const declaration = run.pack.handoffContracts?.find(item => item.contract === args.contract && item.version === args.contractVersion &&
      item.sourceGraphId === run.graph.id && item.targetPackId === args.targetPackId && item.targetGraphId === args.targetGraphId);
    if (!declaration) throw new Error('Handoff is not declared by pinned source Pack');
    const incoming = targetPack.incomingHandoffs?.find(item => item.contract === args.contract && item.contractVersion === args.contractVersion &&
      item.sourcePackId === run.packId && item.sourceGraphId === run.graph.id && item.targetGraphId === args.targetGraphId);
    if (!incoming) throw new Error('Target Pack does not accept handoff contract');
    for (const capability of [declaration.requiredCapability, incoming.requiredCapability].filter(Boolean)) {
      if (!capabilityAvailable(run.pack, run.graph, capability, { availableCapabilities: this.availableCapabilities }) ||
          !capabilityAvailable(targetPack, targetGraph, capability, { availableCapabilities: this.availableCapabilities })) {
        throw new Error(`Handoff capability unavailable: ${capability}`);
      }
    }
    if (declaration.requiredStatus && !Object.entries(run.nodeStates).some(([id, node]) => node.status === 'completed' &&
      (node.outcome === declaration.requiredStatus || node.output === declaration.requiredStatus || node.output?.status === declaration.requiredStatus ||
       run.graph.nodes.find(graphNode => graphNode.id === id)?.output === declaration.requiredStatus))) throw new Error('Required source outcome not recorded');
    const current = Object.values(run.nodeStates).filter(node => node.status === 'completed').flatMap(node => node.artifacts ?? []);
    const matches = ref => current.some(item => item.id === ref.id && item.version === ref.version && item.digest === ref.digest && (!ref.kind || item.kind === ref.kind));
    if (!matches({ ...args.sourceEvent, kind: declaration.eventArtifactKind }) || args.artifacts.some(item => !matches(item))) throw new Error('Handoff references do not match current source artifacts');
    const producer = run.graph.nodes.filter(node => node.produces?.includes(declaration.eventArtifactKind));
    if (producer.length !== 1 || run.nodeStates[producer[0].id]?.status !== 'completed') throw new Error('Declared handoff event producer is incomplete or ambiguous');
    const eventArtifact = run.nodeStates[producer[0].id].artifacts?.find(item => item.kind === declaration.eventArtifactKind &&
      item.id === args.sourceEvent.id && item.version === args.sourceEvent.version && item.digest === args.sourceEvent.digest);
    if (!eventArtifact) throw new Error('Handoff event is not from declared source node');
    if (declaration.eventArtifactKind === 'release_execution_record') {
      for (const key of ['release_execution_event', 'implementation_candidate', 'release_authorization_decision']) {
        const inputRef = run.input?.[key];
        if (!inputRef?.id || !inputRef?.version || !eventArtifact.sourceRefs?.some(ref => ref.kind === 'run_input' && ref.key === key && ref.id === inputRef.id && ref.version === inputRef.version)) {
          throw new Error(`Release handoff event lacks pinned ${key} provenance`);
        }
      }
      const evidence = (c.evidenceReceipts ?? []).find(item => item.id === args.evidenceReceiptId)?.receipt;
      if (!evidence || !this.trustedProviders.has(evidence.providerId) || evidence.kind !== 'release' || evidence.companyId !== c.companyId || evidence.projectId !== args.projectId ||
          Date.parse(evidence.expiresAt) <= Date.parse(at) || evidence.data.sourceRunId !== run.id ||
          evidence.data.releaseEvent.id !== run.input.release_execution_event.id ||
          evidence.data.releaseEvent.version !== run.input.release_execution_event.version ||
          evidence.data.candidate.id !== run.input.implementation_candidate.id ||
          evidence.data.candidate.version !== run.input.implementation_candidate.version ||
          evidence.data.authorizationDecisionId !== run.input.release_authorization_decision.id) {
        throw new Error('Authenticated release evidence receipt does not match pinned source run');
      }
      for (const ref of [run.input.release_execution_event, run.input.implementation_candidate, run.input.release_authorization_decision]) {
        if (!evidence.subjectRefs.some(subject => subject.id === ref.id && subject.version === ref.version)) throw new Error('Release receipt omits pinned source reference');
      }
      if (!evidence.subjectRefs.some(subject => subject.id === args.sourceEvent.id && subject.version === args.sourceEvent.version &&
          subject.digest === args.sourceEvent.digest)) throw new Error('Release receipt does not attest source record digest');
    }
    const item = { ...copy(args), id: randomUUID(), companyId: c.companyId, sourcePack: { id: run.packId, version: run.packVersion }, sourceGraph: { id: run.graph.id, version: run.graph.version },
      targetPack: { id: targetPack.id, version: targetPack.version }, targetGraph: { id: targetGraph.id, version: targetGraph.version }, at, actor };
    delete item.idempotencyKey;
    c.handoffs.push(item); decision(c, 'handoff.recorded', actor, args.reason, null, { id: item.id }, at);
    notify(c, c.organization?.ceo?.id, 'handoff.recorded', { handoffId: item.id }, at);
    return item;
  }); }
  async recordShadowContext(args) { return this.#change('shadow-context', args, (c, state, actor, at) => {
    if (actor.kind !== 'system') throw new Error('Shadow context must come from trusted host');
    const run = state.runs?.[args.parentRunId];
    if (!run?.nodeStates?.[args.parentTaskId]) throw new Error('Parent run/task not found');
    if (!/^sha256:[a-f0-9]{64}$/.test(args.payloadDigest) || !Array.isArray(args.candidateRefs) || !args.candidateRefs.length) throw new Error('Shadow context requires digest and candidates');
    const current = Object.values(run.nodeStates).filter(node => node.status === 'completed').flatMap(node => node.artifacts ?? []);
    if (args.candidateRefs.some(ref => !ref.id || !ref.version || !current.some(item => item.id === ref.id && item.version === ref.version && (!ref.digest || item.digest === ref.digest)))) throw new Error('Shadow candidate is not current');
    const item = { id: randomUUID(), companyId: c.companyId, parentRunId: run.id, parentTaskId: args.parentTaskId,
      candidateRefs: copy(args.candidateRefs), payloadDigest: args.payloadDigest, recordedAt: at, actor };
    c.shadowContexts ??= []; c.shadowContexts.push(item);
    decision(c, 'shadow.context-recorded', actor, args.reason, null, { snapshotId: item.id, parentRunId: run.id, parentTaskId: args.parentTaskId }, at);
    return item;
  }); }
  async prepareShadow(args) { return this.#change('shadow-prepare', args, (c, state, actor, at) => {
    const run = state.runs?.[args.parentRunId];
    if (!run?.nodeStates?.[args.parentTaskId]) throw new Error('Parent run/task not found');
    assertShadowScope(c, run, args, actor, at, this.availableCapabilities);
    if (c.shadows.some(item => ['reserved', 'active'].includes(item.status) && item.sessionId === args.sessionId)) throw new Error('Shadow session already reserved');
    const item = { id: randomUUID(), companyId: c.companyId, parentRunId: run.id, parentTaskId: args.parentTaskId, role: args.role,
      executionId: null, sessionId: args.sessionId, contextRef: copy(args.contextRef), scope: copy(args.scope),
      goalContext: copy(run.goalContext ?? null), status: 'reserved', openedAt: at, closedAt: null, requestedBy: actor };
    c.shadows.push(item); decision(c, 'shadow.reserved', actor, args.reason, null, { id: item.id, parentRunId: run.id, parentTaskId: args.parentTaskId }, at);
    return item;
  }); }
  async bindShadowExecution(args) { return this.#change('shadow-bind', args, (c, _state, actor, at) => {
    if (actor.kind !== 'system') throw new Error('Shadow execution binding requires trusted host');
    const item = c.shadows.find(entry => entry.id === args.shadowId && entry.status === 'reserved');
    if (!item) throw new Error('Reserved shadow not found');
    required(args.executionId, 'executionId');
    if (args.executionId === item.requestedBy.executionId || c.shadows.some(entry => entry.id !== item.id && entry.executionId === args.executionId)) throw new Error('Shadow execution must be distinct');
    if (Date.parse(item.scope.deadlineAt) <= Date.parse(at)) throw new Error('Shadow reservation expired');
    item.executionId = args.executionId; item.status = 'active';
    decision(c, 'shadow.execution-bound', actor, args.reason, { id: item.id, status: 'reserved' }, { id: item.id, status: 'active', executionId: args.executionId }, at);
    return item;
  }); }
  async openShadow(args) { return this.#change('shadow-open', args, (c, state, actor, at) => {
    const run = state.runs?.[args.parentRunId];
    if (!run?.nodeStates?.[args.parentTaskId]) throw new Error('Parent run/task not found');
    assertShadowScope(c, run, args, actor, at, this.availableCapabilities);
    required(args.executionId, 'executionId');
    if (args.executionId === actor.executionId || c.shadows.some(item => ['reserved', 'active'].includes(item.status) && (item.executionId === args.executionId || item.sessionId === args.sessionId))) throw new Error('Shadow needs distinct execution and session');
    const item = { id: randomUUID(), companyId: c.companyId, parentRunId: run.id, parentTaskId: args.parentTaskId, role: args.role,
      executionId: args.executionId, sessionId: args.sessionId, contextRef: copy(args.contextRef), scope: copy(args.scope), goalContext: copy(run.goalContext ?? null), status: 'active', openedAt: at, closedAt: null };
    c.shadows.push(item); decision(c, 'shadow.opened', actor, args.reason, null, { id: item.id, parentRunId: run.id, parentTaskId: args.parentTaskId }, at);
    return item;
  }); }
  async closeShadow(args) { return this.#change('shadow-close', args, (c, _state, actor, at) => {
      const item = c.shadows.find(entry => entry.id === args.shadowId);
      if (!item || !['active', 'reserved'].includes(item.status)) throw new Error('Active or reserved shadow not found');
      const opener = actor.kind === 'agent' && item.requestedBy?.kind === 'agent' &&
        actor.id === item.requestedBy.id && actor.executionId === item.requestedBy.executionId;
      const reconciler = actor.kind === 'system' && actor.roles.includes('shadow-reconciler') &&
        ['completed', 'failed', 'timeout', 'cancelled'].includes(args.outcome);
      if (!opener && !reconciler) authority(c, actor);
      required(args.outcome, 'outcome');
      if (args.reviewResult || args.outcome === 'completed') {
        if (!reconciler || args.outcome !== 'completed' || item.status !== 'active') {
          throw new Error('Completed Shadow review requires trusted terminal reconciliation');
        }
        const result = args.reviewResult;
        const snapshot = (c.shadowContexts ?? []).find(entry => entry.id === item.contextRef?.snapshotId &&
          entry.parentRunId === item.parentRunId && entry.parentTaskId === item.parentTaskId);
        if (!snapshot || result?.status !== 'synthetic-fixture-reviewed' || !/^sha256:[a-f0-9]{64}$/.test(result.outputDigest) ||
            !Array.isArray(result.findings) || !result.findings.length || result.findings.length > 20) {
          throw new Error('Bounded Shadow review result and reserved snapshot required');
        }
        for (const finding of result.findings) {
          if (!['P0', 'P1', 'P2', 'P3'].includes(finding?.severity) ||
              typeof finding.summary !== 'string' || !finding.summary.trim() || finding.summary.length > 1000 ||
              !snapshot.candidateRefs.some(ref => ref.id === finding.sourceRef?.id &&
                ref.version === finding.sourceRef?.version && ref.digest === finding.sourceRef?.digest)) {
            throw new Error('Shadow finding must cite a reserved candidate');
          }
        }
        item.reviewResult = copy({ status: result.status, findings: result.findings,
          outputDigest: result.outputDigest, snapshotId: snapshot.id });
      }
      const previous = item.status;
      item.status = 'closed'; item.closedAt = at; item.outcome = args.outcome;
      decision(c, 'shadow.closed', actor, args.reason, { id: item.id, status: previous },
        { id: item.id, status: 'closed', outcome: item.outcome,
          reviewResult: item.reviewResult ? { snapshotId: item.reviewResult.snapshotId,
            outputDigest: item.reviewResult.outputDigest, findingCount: item.reviewResult.findings.length } : null }, at);
      return item;
    }); }
  async reviewOutcome(args) { return this.#change('outcome-review', args, (c, state, actor, at) => {
    authority(c, actor); required(args.projectId, 'projectId'); required(args.goalId, 'goalId');
    const sourceRun = args.sourceRunId ? state.runs?.[args.sourceRunId] : null;
    if (args.sourceRunId && (!sourceRun || sourceRun.status !== 'completed' || sourceRun.input?.projectId !== args.projectId)) throw new Error('Outcome source must be a completed run in this project');
    const pinnedRevision = sourceRun?.goalContext?.revisions?.find(item => item.goals.some(goal => goal.id === args.goalId));
    if (sourceRun && (!pinnedRevision || args.goalRevisionId && args.goalRevisionId !== pinnedRevision.id)) throw new Error('Outcome goal revision differs from the source run snapshot');
    const revisionId = pinnedRevision?.id ?? args.goalRevisionId;
    const revision = revisionId ? c.goalHistory.find(item => item.id === revisionId)
      : allCurrentGoals(c).find(item => item.goals.some(goal => goal.id === args.goalId));
    const goal = revision?.goals.find(item => item.id === args.goalId);
    if (!goal) throw new Error('Goal not found');
    const observedIds = (args.observations ?? []).map(item => item.keyResultId);
    if (new Set(observedIds).size !== observedIds.length) throw new Error('Duplicate key result observation');
    const observations = (args.observations ?? []).map(item => {
      const kr = goal.keyResults.find(entry => entry.id === item.keyResultId);
      if (!kr) throw new Error('Key result not found');
      const proof = (c.evidenceReceipts ?? []).find(entry => entry.id === item.evidenceReceiptId)?.receipt;
      const observed = Boolean(proof && this.trustedProviders.has(proof.providerId) && proof.kind === 'metric' && proof.companyId === c.companyId && proof.projectId === args.projectId &&
        Date.parse(proof.expiresAt) > Date.parse(at) && proof.data.goalRevisionId === revision.id && proof.data.goalId === goal.id &&
        proof.data.keyResultId === kr.id && proof.data.source === kr.source && proof.data.window === kr.window &&
        (!item.window || item.window === kr.window) && capabilityAvailable(null, null, 'sourced-metrics', { availableCapabilities: this.availableCapabilities }));
      return { keyResultId: kr.id, baseline: kr.baseline ?? null, target: kr.target, source: kr.source, window: kr.window,
        value: observed ? proof.data.value : null, sourceRef: observed ? copy(proof.subjectRefs) : null, evidenceReceiptId: observed ? proof.id : null,
        observedAt: observed ? proof.data.observedAt : null, status: observed ? 'observed' : 'unknown' };
    });
    for (const kr of goal.keyResults) if (!observations.some(item => item.keyResultId === kr.id)) observations.push({ keyResultId: kr.id, baseline: kr.baseline ?? null, target: kr.target, source: kr.source, window: kr.window, value: null, sourceRef: null, status: 'unknown' });
    const review = { id: randomUUID(), companyId: c.companyId, projectId: args.projectId, goalId: args.goalId, goalRevisionId: revision.id,
      sourceRunId: sourceRun?.id ?? null, packId: sourceRun?.packId ?? null, packVersion: sourceRun?.packVersion ?? null, observations, at, actor };
    c.reviews.push(review); decision(c, 'outcome.reviewed', actor, args.reason, null, { id: review.id }, at);
    return review;
  }); }
  async adjustStrategy(args) { return this.#change('strategy-adjust', args, (c, _state, actor, at) => {
    authority(c, actor); const review = c.reviews.find(item => item.id === args.reviewId);
    if (!review) throw new Error('Outcome review not found');
    if (!review.observations.some(item => item.status === 'observed' &&
        (c.evidenceReceipts ?? []).some(entry => entry.id === item.evidenceReceiptId &&
          this.trustedProviders.has(entry.receipt.providerId) && Date.parse(entry.receipt.expiresAt) > Date.parse(at)))) {
      throw new Error('Strategy adjustment needs current observed evidence');
    }
    const previous = c.adjustments.filter(item => item.reviewId === args.reviewId);
    if (previous.length) throw new Error('Review already adjusted');
    const latest = c.adjustments.at(-1);
    if (latest && Date.parse(at) - Date.parse(latest.at) < 86400000) throw new Error('Strategy adjustment cooldown active');
    if (!Array.isArray(args.changes) || !args.changes.length) throw new Error('Goal changes required');
    const revisions = [];
    for (const change of args.changes) {
      const prior = currentGoals(c, change.subjectId, 'agent');
      if (!prior || prior.scope !== 'agent') throw new Error('Only subordinate agent goals may be revised');
      if (!canManageAgent(c, actor, change.subjectId)) throw new Error('Goal outside actor authority');
      validateGoals(c, change.goals, change.subjectId);
      const revision = { id: randomUUID(), companyId: c.companyId, scope: 'agent', subjectId: change.subjectId, version: prior.version + 1, goals: copy(change.goals), createdAt: at, supersedes: prior.id };
      c.goalHistory.push(revision); revisions.push(revision);
      decision(c, 'goals.revised', actor, args.reason, { id: prior.id, version: prior.version }, { id: revision.id, version: revision.version }, at);
      notify(c, change.subjectId, 'goals.revised', { goalRevisionId: revision.id }, at);
    }
    const adjustment = { id: randomUUID(), companyId: c.companyId, reviewId: review.id, goalRevisionIds: revisions.map(item => item.id), at, actor };
    c.adjustments.push(adjustment); decision(c, 'strategy.adjusted', actor, args.reason, { reviewId: review.id }, { id: adjustment.id }, at);
    return adjustment;
  }); }
  async setNotificationPreferences(args) { return this.#change('notification-preferences', args, (c, _state, actor, at) => {
    if (actor.id !== args.subjectId && !owner(actor)) throw new Error('Cannot edit another subject preferences');
    if (!Array.isArray(args.channels) || !Array.isArray(args.events)) throw new Error('Notification channels/events required');
    const old = c.notificationPreferences.find(item => item.subjectId === args.subjectId) ?? null;
    const next = { subjectId: args.subjectId, channels: copy(args.channels), events: copy(args.events) };
    c.notificationPreferences = [...c.notificationPreferences.filter(item => item.subjectId !== args.subjectId), next];
    decision(c, 'notification.preferences', actor, args.reason, old, next, at);
    return next;
  }); }
  async queueOutcomeReviewReminders(args) { return this.#change('outcome-reminders', args, (c, _state, actor, at) => {
    if (actor.kind !== 'system') throw new Error('Outcome reminder scan requires trusted system');
    let queued = 0, skipped = 0;
    for (const revision of allCurrentGoals(c)) for (const goal of revision.goals) for (const kr of goal.keyResults) {
      const dueAt = kr.windowEnd ?? kr.window;
      if (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) > Date.parse(at)) { skipped++; continue; }
      const ref = { goalRevisionId: revision.id, goalId: goal.id, keyResultId: kr.id, window: kr.window };
      if (c.outbox.some(item => item.eventKind === 'outcome-review.due' && item.ref.goalRevisionId === ref.goalRevisionId && item.ref.keyResultId === ref.keyResultId)) { skipped++; continue; }
      const before = c.outbox.length;
      notify(c, c.organization?.ceo?.id ?? c.organization?.board?.id, 'outcome-review.due', ref, at);
      if (c.outbox.length > before) queued++; else skipped++;
    }
    if (queued) decision(c, 'outcome-reminders.queued', actor, args.reason, null, { queued }, at);
    return { queued, skipped };
  }); }
  async queueRunNotifications(args) { return this.#change('run-notifications', args, (c, state, actor, at) => {
    if (actor.kind !== 'system' || !actor.roles.includes('run-observer')) throw new Error('Run notification requires trusted observer');
    let queued = 0;
    for (const run of Object.values(state.runs ?? {})) {
      if (run.input?.paperclipCompanyId !== c.companyId || !['completed', 'failed', 'stopped', 'rework_required'].includes(run.status)) continue;
      const eventKind = `run.${run.status}`;
      for (const subjectId of new Set([c.organization?.board?.id, c.organization?.ceo?.id].filter(Boolean))) {
        if (c.outbox.some(item => item.subjectId === subjectId && item.eventKind === eventKind && item.ref.runId === run.id)) continue;
        const before = c.outbox.length;
        notify(c, subjectId, eventKind, { runId: run.id, projectId: run.input.projectId,
          packId: run.packId, packVersion: run.packVersion, graphId: run.graph.id, graphVersion: run.graph.version }, at);
        queued += c.outbox.length - before;
      }
    }
    if (queued) decision(c, 'run-notifications.queued', actor, args.reason, null, { queued }, at);
    return { queued };
  }); }
  async listNotifications({ subjectId } = {}) { const c = await this.#control(); return c.outbox.filter(item => !subjectId || item.subjectId === subjectId); }
  async markNotification(args) { return this.#change('notification-mark', args, (c, _state, actor, at) => {
    const item = c.outbox.find(entry => entry.id === args.notificationId);
    if (!item) throw new Error('Notification not found');
    if (actor.id !== item.subjectId && !owner(actor)) throw new Error('Cannot mark another subject notification');
    const old = item.readAt; item.readAt = at;
    decision(c, 'notification.read', actor, args.reason, { id: item.id, readAt: old }, { id: item.id, readAt: at }, at);
    return item;
  }); }
  async acknowledgeDelivery(args) { return this.#change('notification-delivery', args, (c, _state, actor, at) => {
    if (actor.kind !== 'system') throw new Error('Delivery acknowledgment requires trusted system');
    const item = c.outbox.find(entry => entry.id === args.notificationId);
    if (!item) throw new Error('Notification not found');
    required(args.providerRef, 'providerRef');
    const old = item.deliveryStatus; item.deliveryStatus = 'delivered'; item.deliveredAt = at; item.providerRef = args.providerRef;
    decision(c, 'notification.delivered', actor, args.reason, { id: item.id, deliveryStatus: old }, { id: item.id, deliveryStatus: item.deliveryStatus, providerRef: args.providerRef }, at);
    return item;
  }); }
  async getAudit() { return (await this.#control()).audit; }
  async getIntake() { return (await this.#control()).intake; }
  async getPlans() { return (await this.#control()).plans; }
  async getShadows() { return (await this.#control()).shadows; }
  async getReviews() { return (await this.#control()).reviews; }
  async getHandoffs() { return (await this.#control()).handoffs; }
  async getFeedback() { return (await this.#control()).feedback; }
  async getEscalations() { return (await this.#control()).escalations; }
}
