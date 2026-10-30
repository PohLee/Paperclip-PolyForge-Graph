/** A temporary execution is never an organizational Agent identity. */
export const TEMPORARY_AGENT_DEFAULT_POLICY = Object.freeze({
  version: 1,
  enabled: false,
  maxConcurrentChildren: 3,
  maxDepth: 1,
  maxDurationSeconds: 900,
  allowSharedWorkspaceWrites: false,
  allowedPurposes: Object.freeze(['review', 'research', 'analyze', 'implement']),
});

const kinds = ['sub-agent', 'shadow-agent'];
const purposes = TEMPORARY_AGENT_DEFAULT_POLICY.allowedPurposes;
const statuses = ['completed', 'failed', 'cancelled', 'timed-out'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const fail = message => { throw new Error(`Invalid temporary agent ${message}`); };
const positive = value => Number.isInteger(value) && value > 0;
const isoTime = value => nonempty(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const stringList = (value, { allowEmpty = false } = {}) => Array.isArray(value) &&
  (allowEmpty || value.length > 0) && value.every(nonempty) && new Set(value).size === value.length;
const ref = value => record(value) && nonempty(value.kind) &&
  (nonempty(value.id) || nonempty(value.artifactId) || nonempty(value.url));
const refList = (value, { allowEmpty = false } = {}) => Array.isArray(value) &&
  (allowEmpty || value.length > 0) && value.every(ref);

export function normalizeTemporaryAgentPolicy(policy = {}) {
  if (!record(policy)) fail('policy');
  const next = { ...TEMPORARY_AGENT_DEFAULT_POLICY, ...policy,
    allowedPurposes: policy.allowedPurposes ?? [...purposes] };
  if (next.version !== 1 || typeof next.enabled !== 'boolean' ||
      !positive(next.maxConcurrentChildren) || next.maxConcurrentChildren > 16 ||
      next.maxDepth !== 1 ||
      !positive(next.maxDurationSeconds) || next.maxDurationSeconds > 3600 ||
      typeof next.allowSharedWorkspaceWrites !== 'boolean' ||
      !stringList(next.allowedPurposes) || next.allowedPurposes.some(value => !purposes.includes(value))) {
    fail('policy');
  }
  if (next.maxCostUsd !== undefined &&
      (typeof next.maxCostUsd !== 'number' || !Number.isFinite(next.maxCostUsd) || next.maxCostUsd <= 0)) fail('policy cost cap');
  return next;
}

/** Validate a bounded request against authority supplied by the trusted parent runtime. */
export function validateTemporaryAgentRequest(request, { policy = TEMPORARY_AGENT_DEFAULT_POLICY,
  parentAuthority, now = new Date().toISOString(), activeChildren = [] } = {}) {
  const rules = normalizeTemporaryAgentPolicy(policy);
  if (!rules.enabled) fail('policy is disabled');
  if (!record(request) || !nonempty(request.id) || !kinds.includes(request.kind) ||
      !purposes.includes(request.purpose) || !rules.allowedPurposes.includes(request.purpose)) fail('request kind or purpose');
  if (!record(request.parent) || !nonempty(request.parent.agentId) ||
      !nonempty(request.parent.executionId) || !record(request.context) ||
      !nonempty(request.context.parentSessionRef)) fail('parent identity or context');
  const mode = request.kind === 'sub-agent' ? 'fresh' : 'fork';
  if (request.context.mode !== mode) fail('context mode');
  if (request.purpose === 'review' && request.kind !== 'sub-agent') fail('independent review requires a fresh Sub-Agent');
  if (!record(parentAuthority) || parentAuthority.canDelegate !== true ||
      parentAuthority.agentId !== request.parent.agentId ||
      !stringList(parentAuthority.allowedActions)) fail('parent authority');
  const depth = request.depth ?? 1;
  if (!positive(depth) || depth > rules.maxDepth || depth !== 1) fail('delegation depth');
  if (!record(request.brief) || !nonempty(request.brief.objective) ||
      !nonempty(request.brief.scope) || !nonempty(request.brief.outputFormat) ||
      !stringList(request.brief.boundaries) || !refList(request.brief.inputRefs) ||
      !stringList(request.brief.acceptanceCriteria) || !stringList(request.brief.allowedActions) ||
      !isoTime(request.brief.deadlineAt)) fail('brief');
  if (!request.brief.allowedActions.includes(request.purpose) ||
      request.brief.allowedActions.some(action => !parentAuthority.allowedActions.includes(action))) {
    fail('action exceeds parent authority');
  }
  const start = Date.parse(now), deadline = Date.parse(request.brief.deadlineAt);
  if (!Number.isFinite(start) || deadline <= start ||
      deadline - start > rules.maxDurationSeconds * 1000 ||
      (parentAuthority.deadlineAt && deadline > Date.parse(parentAuthority.deadlineAt))) fail('deadline');
  const limits = { maxTasks: 1, maxConcurrent: 1, ...request.limits };
  if (limits.maxTasks !== 1 || limits.maxConcurrent !== 1 ||
      (limits.maxCostUsd !== undefined &&
        (typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0 ||
          (rules.maxCostUsd !== undefined && limits.maxCostUsd > rules.maxCostUsd) ||
          (parentAuthority.maxCostUsd !== undefined && limits.maxCostUsd > parentAuthority.maxCostUsd)))) {
    fail('limits');
  }
  const workspace = { mode: 'shared', writeAccess: 'none', ...request.workspace };
  if (!['shared', 'isolated'].includes(workspace.mode) ||
      !['none', 'exclusive'].includes(workspace.writeAccess)) fail('workspace');
  if (request.purpose === 'implement' && workspace.writeAccess !== 'exclusive') fail('implementation requires an exclusive writer');
  if (request.purpose !== 'implement' && workspace.writeAccess !== 'none') fail('read-only purpose cannot request a writer');
  if (workspace.writeAccess === 'exclusive') {
    if (!parentAuthority.allowedActions.includes('implement')) fail('write authority');
    if (workspace.mode === 'shared' && (!rules.allowSharedWorkspaceWrites ||
        parentAuthority.workspace?.allowSharedWrite !== true ||
        !nonempty(workspace.writerLeaseRef) ||
        workspace.writerLeaseRef !== parentAuthority.workspace.writerLeaseRef)) fail('shared workspace writer lease');
  }
  if (!Array.isArray(activeChildren) || activeChildren.some(child => !record(child))) fail('active children');
  const active = activeChildren.filter(child => ['reserved', 'active'].includes(child.status));
  if (active.length >= rules.maxConcurrentChildren ||
      (workspace.mode === 'shared' && workspace.writeAccess === 'exclusive' &&
        active.some(child => child.workspace?.mode === 'shared' && child.workspace?.writeAccess === 'exclusive'))) {
    fail('concurrency limit');
  }
  return { ...request, depth, limits, workspace };
}

/** Check host-attested session creation after launch. The host must verify the receipt. */
export function validateTemporaryAgentContextReceipt(receipt, request) {
  if (!record(request) || !record(receipt) || receipt.requestId !== request.id ||
      receipt.mode !== request.context?.mode ||
      receipt.parentSessionRef !== request.context?.parentSessionRef ||
      !nonempty(receipt.sessionRef) || receipt.sessionRef === receipt.parentSessionRef ||
      !nonempty(receipt.executionId) || receipt.executionId === request.parent?.executionId) fail('context receipt');
  if (request.kind === 'sub-agent') {
    if (receipt.creationMethod !== 'new-session' || receipt.forkRef !== undefined ||
        receipt.forkedAt !== undefined) fail('fresh session provenance');
  } else if (request.kind === 'shadow-agent') {
    if (receipt.creationMethod !== 'native-fork' || !nonempty(receipt.forkRef) ||
        !isoTime(receipt.forkedAt)) fail('native fork provenance');
  } else fail('request kind');
  return receipt;
}

/** Validate a terminal report before the parent accepts its evidence. */
export function validateTemporaryAgentResult(result, request) {
  if (!record(request) || !record(result) || !statuses.includes(result.status) ||
      !nonempty(result.summary) || !nonempty(result.executionId) ||
      result.executionId === request.parent?.executionId ||
      !nonempty(result.sessionRef) || result.sessionRef === request.context?.parentSessionRef ||
      !isoTime(result.finishedAt)) fail('result');
  if (result.status === 'completed') {
    if (!refList(result.evidenceRefs) ||
        (!nonempty(result.outputRef) && !nonempty(result.output) && !record(result.output))) {
      fail('completed result requires output and evidence references');
    }
    if (result.output !== undefined && JSON.stringify(result.output).length > 32768) fail('result output size');
  } else if (result.evidenceRefs !== undefined && !refList(result.evidenceRefs, { allowEmpty: true })) {
    fail('result evidence references');
  }
  return result;
}
