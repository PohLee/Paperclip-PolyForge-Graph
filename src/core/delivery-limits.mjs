export const DELIVERY_LIMITS = Object.freeze({
  sliceMs: 120 * 60_000,
  idleMs: 30 * 60_000,
  fixRounds: 3,
  fullRegressions: 3,
  implementationCorrections: 1,
  testDatabases: 2,
  sourceSnapshots: 1,
  parallelAgents: 3,
  concurrentRuns: 3,
  noProgressRuns: 3,
  runResets: 6,
});
export const DELIVERY_LIMIT_HARD_MAX = Object.freeze({
  sliceMs: 240 * 60_000, idleMs: 60 * 60_000,
  fixRounds: 5, fullRegressions: 5, implementationCorrections: 2,
  testDatabases: 4, sourceSnapshots: 2, parallelAgents: 5,
  concurrentRuns: 5, noProgressRuns: 5, runResets: 20,
});

export function normalizeDeliveryLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delivery limits');
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in DELIVERY_LIMITS) || !Number.isSafeInteger(entry) || entry < 1 || entry > DELIVERY_LIMIT_HARD_MAX[key]) {
      throw new Error(`Invalid delivery limit: ${key}`);
    }
  }
  const limits = { ...DELIVERY_LIMITS, ...value };
  if (limits.idleMs > limits.sliceMs) throw new Error('Idle limit cannot exceed delivery slice limit');
  return limits;
}
const fingerprint = (value) => JSON.stringify(value, function (_key, entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
  }
  return entry;
});

const active = (run) => run.status === 'running';
const elapsed = (run, at) => run.deliveryClock.activeMs +
  (active(run) && run.deliveryClock.activeSince ? Math.max(0, at - Date.parse(run.deliveryClock.activeSince)) : 0);

export function deliveryKey(input, runId) {
  const id = input.deliveryId ?? input.paperclipIssueId ?? runId;
  if (typeof id !== 'string' || !id.trim()) throw new Error('deliveryId must be a nonempty string');
  return `${input.paperclipCompanyId ?? 'local'}:${input.projectId ?? 'local'}:${id}`;
}

export function initDelivery(state, run, at, configuredLimits = {}) {
  state.deliveries ??= {};
  const key = deliveryKey(run.input, run.id);
  const limits = normalizeDeliveryLimits(configuredLimits);
  const delivery = state.deliveries[key] ??= {
    id: run.input.deliveryId ?? run.input.paperclipIssueId ?? run.id,
    key, limits, status: 'active', noProgressRuns: 0, unproductiveActiveMs: 0,
    milestoneRefs: {}, milestones: [], fixRounds: {}, totalFixRounds: 0, fullRegressions: 0,
    regressionCandidates: {},
    corrections: {}, resources: { testDatabase: {}, sourceSnapshot: {} },
    runIds: [],
  };
  delivery.limits ??= { ...DELIVERY_LIMITS };
  const pinnedLimits = normalizeDeliveryLimits(delivery.limits);
  if (delivery.status !== 'active') throw new Error('Delivery limit reached; scope a new delivery goal');
  if (delivery.noProgressRuns >= pinnedLimits.noProgressRuns) throw new Error('No-progress run limit reached for delivery');
  if (delivery.runIds.filter((id) => ['running', 'paused'].includes(state.runs[id]?.status)).length >= pinnedLimits.concurrentRuns) {
    throw new Error('Concurrent Graph run limit reached for delivery');
  }
  if (delivery.fullRegressions >= pinnedLimits.fullRegressions &&
      run.graph.nodes.some((node) => node.deliveryCheck?.kind === 'full_regression')) {
    throw new Error('Full regression limit reached for delivery');
  }
  if ((delivery.totalFixRounds ?? 0) >= pinnedLimits.fixRounds &&
      run.graph.nodes.some((node) => node.deliveryCheck?.kind === 'fix_reverify')) {
    throw new Error('Fix/reverify limit reached for delivery');
  }
  if (run.graph.deliveryContract) {
    const { goalInput, acceptanceInput, verificationPlanInput } = run.graph.deliveryContract;
    const boundary = { goal: fingerprint(run.input[goalInput]), acceptance: fingerprint(run.input[acceptanceInput]) };
    if (delivery.boundary && (delivery.boundary.goal !== boundary.goal || delivery.boundary.acceptance !== boundary.acceptance)) {
      throw new Error('Delivery goal or acceptance criteria changed; scope a new delivery goal');
    }
    delivery.boundary ??= boundary;
    if (verificationPlanInput) {
      const plan = fingerprint(run.input[verificationPlanInput]);
      if (delivery.boundary.verificationPlan && delivery.boundary.verificationPlan !== plan) {
        throw new Error('Verification plan changed; scope a new delivery goal');
      }
      delivery.boundary.verificationPlan ??= plan;
    }
  }
  delivery.runIds.push(run.id);
  run.deliveryKey = key;
  run.deliveryLimits = { ...pinnedLimits };
  run.deliveryClock = { activeMs: 0, activeSince: at,
    lastProgressActiveMs: -(delivery.unproductiveActiveMs ?? 0), progress: [] };
  return delivery;
}

export function syncDeliveryClock(run, previousStatus, at) {
  if (!run.deliveryClock) return;
  const clock = run.deliveryClock;
  if (previousStatus === 'running' && run.status !== 'running' && clock.activeSince) {
    clock.activeMs += Math.max(0, Date.parse(at) - Date.parse(clock.activeSince));
    clock.activeSince = null;
  } else if (previousStatus !== 'running' && run.status === 'running') {
    clock.activeSince = at;
  }
}

export function deliveryExpiry(state, run, at) {
  if (!run.deliveryClock || !active(run)) return null;
  const delivery = state.deliveries?.[run.deliveryKey];
  const limits = delivery?.limits ?? run.deliveryLimits ?? DELIVERY_LIMITS;
  if (delivery?.status === 'stopped') return 'delivery_limit';
  const current = elapsed(run, Date.parse(at));
  if (current >= limits.sliceMs) return 'slice_time_limit';
  if (current - run.deliveryClock.lastProgressActiveMs >= limits.idleMs) return 'idle_progress_limit';
  return null;
}

export function deliverySnapshot(state, run, at) {
  if (!run.deliveryClock) return null;
  const delivery = state.deliveries?.[run.deliveryKey];
  const limits = delivery?.limits ?? run.deliveryLimits ?? DELIVERY_LIMITS;
  const activeMs = elapsed(run, Date.parse(at));
  return {
    deliveryId: delivery?.id ?? null,
    status: delivery?.status ?? 'active',
    runStatus: run.status,
    limits: structuredClone(limits),
    goal: run.graph.deliveryContract ? run.input[run.graph.deliveryContract.goalInput] : null,
    acceptanceCriteria: run.graph.deliveryContract ? run.input[run.graph.deliveryContract.acceptanceInput] : null,
    verificationPlan: run.graph.deliveryContract?.verificationPlanInput
      ? run.input[run.graph.deliveryContract.verificationPlanInput] : null,
    acceptedMilestones: structuredClone(delivery?.milestones ?? run.deliveryClock.progress),
    activeMinutes: Math.floor(activeMs / 60_000),
    sliceMinutesRemaining: Math.max(0, Math.ceil((limits.sliceMs - activeMs) / 60_000)),
    idleMinutesRemaining: Math.max(0, Math.ceil((limits.idleMs - (activeMs - run.deliveryClock.lastProgressActiveMs)) / 60_000)),
    fixRounds: structuredClone(delivery?.fixRounds ?? {}),
    fixRoundsRemaining: Math.max(0, limits.fixRounds - (delivery?.totalFixRounds ?? 0)),
    fullRegressions: delivery?.fullRegressions ?? 0,
    fullRegressionsRemaining: Math.max(0, limits.fullRegressions - (delivery?.fullRegressions ?? 0)),
    noProgressRuns: delivery?.noProgressRuns ?? 0,
    implementationCorrections: structuredClone(delivery?.corrections ?? {}),
    resources: {
      testDatabases: Object.keys(delivery?.resources?.testDatabase ?? {}),
      sourceSnapshots: Object.keys(delivery?.resources?.sourceSnapshot ?? {}),
    },
  };
}

export function recordMilestone(run, nodeId, artifacts, at, delivery) {
  if (!run.deliveryClock) return;
  if (!artifacts?.length || artifacts.some((item) => !item.id || !item.version)) {
    throw new Error('Delivery milestone needs versioned artifacts');
  }
  delivery.milestoneRefs ??= {};
  const fresh = artifacts.some((item) => !delivery.milestoneRefs[JSON.stringify([item.kind, item.id, item.version])]);
  if (!fresh) return;
  for (const item of artifacts) delivery.milestoneRefs[JSON.stringify([item.kind, item.id, item.version])] = true;
  const clock = run.deliveryClock;
  clock.lastProgressActiveMs = elapsed(run, Date.parse(at));
  delivery.unproductiveActiveMs = 0;
  const milestone = { runId: run.id, nodeId, at,
    artifacts: artifacts.map((item) => ({ kind: item.kind, id: item.id, version: item.version })) };
  clock.progress.push(milestone);
  delivery.milestones ??= [];
  delivery.milestones.push(milestone);
}

export function countDeliveryEvent(delivery, event) {
  const limits = delivery.limits ?? DELIVERY_LIMITS;
  const { kind, rootCauseId, agentId, receipt, resourceId, action } = event;
  if (kind === 'fix_reverify') {
    if (typeof rootCauseId !== 'string' || !rootCauseId.trim()) throw new Error('rootCauseId is required');
    const count = delivery.fixRounds[rootCauseId] ?? 0;
    if (count >= limits.fixRounds || (delivery.totalFixRounds ?? 0) >= limits.fixRounds) {
      return { allowed: false, limit: 'fix_round_limit', count };
    }
    delivery.fixRounds[rootCauseId] = count + 1;
    delivery.totalFixRounds = (delivery.totalFixRounds ?? 0) + 1;
    return { allowed: true, count: count + 1 };
  }
  if (kind === 'full_regression') {
    if (!receipt?.id || !receipt.version || !receipt.candidateId) throw new Error('Full regression needs a versioned receipt and candidateId');
    delivery.regressionCandidates ??= {};
    if (delivery.regressionCandidates[receipt.candidateId]) {
      return { allowed: false, limit: 'duplicate_full_regression', count: delivery.fullRegressions };
    }
    if (delivery.fullRegressions >= limits.fullRegressions) return { allowed: false, limit: 'full_regression_limit', count: delivery.fullRegressions };
    delivery.fullRegressions++;
    delivery.regressionCandidates[receipt.candidateId] = { receiptId: receipt.id, version: receipt.version };
    return { allowed: true, count: delivery.fullRegressions };
  }
  if (kind === 'implementation_correction') {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('agentId is required');
    const count = delivery.corrections[agentId] ?? 0;
    if (count >= limits.implementationCorrections) return { allowed: false, limit: 'implementation_correction_limit', count };
    delivery.corrections[agentId] = count + 1;
    return { allowed: true, count: count + 1 };
  }
  if (kind === 'resource') {
    if (!['acquire', 'release'].includes(action) || !['testDatabase', 'sourceSnapshot'].includes(event.resourceKind) ||
      typeof resourceId !== 'string' || !resourceId.trim()) throw new Error('Invalid delivery resource event');
    const resources = delivery.resources[event.resourceKind];
    if (action === 'release') { delete resources[resourceId]; return { allowed: true, count: Object.keys(resources).length }; }
    if (resources[resourceId]) return { allowed: true, count: Object.keys(resources).length };
    const cap = limits[event.resourceKind === 'testDatabase' ? 'testDatabases' : 'sourceSnapshots'];
    if (Object.keys(resources).length >= cap) return { allowed: false, limit: 'resource_limit', count: Object.keys(resources).length };
    resources[resourceId] = true;
    return { allowed: true, count: Object.keys(resources).length };
  }
  throw new Error('Unknown delivery event kind');
}
