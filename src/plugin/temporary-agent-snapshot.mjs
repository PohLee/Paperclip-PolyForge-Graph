import { createHash } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const isoTime = (value) => nonempty(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_ADVISORY_BYTES = 8 * 1024;
const digestFor = (payload) => `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;

export function validateSnapshotAdvisory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['objective', 'currentState', 'conclusions',
        'openQuestions', 'evidenceRefs'].includes(key)) ||
      !nonempty(value.objective) || !nonempty(value.currentState) ||
      value.objective.length > 1500 || value.currentState.length > 3000 ||
      !Array.isArray(value.conclusions) || value.conclusions.length > 20 ||
      value.conclusions.some((item) => !nonempty(item) || item.length > 1000) ||
      !Array.isArray(value.openQuestions) || value.openQuestions.length > 20 ||
      value.openQuestions.some((item) => !nonempty(item) || item.length > 1000) ||
      !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > 30 ||
      value.evidenceRefs.some((ref) => !ref || typeof ref !== 'object' || Array.isArray(ref) ||
        Object.keys(ref).some((key) => !['kind', 'id', 'artifactId', 'url',
          'version', 'digest'].includes(key)) ||
        !nonempty(ref.kind) || ![ref.id, ref.artifactId, ref.url].some(nonempty))) {
    throw new Error('Invalid Shadow snapshot advisory summary or evidence references');
  }
  if (Buffer.byteLength(canonical(value) ?? '') > MAX_ADVISORY_BYTES) {
    throw new Error('Shadow snapshot advisory exceeds bounded limit');
  }
  return structuredClone(value);
}

export function createTemporaryAgentSnapshot({ request, companyId, parentSessionRef,
  run = null, projectId: issueProjectId = null, decisions, control,
  capturedAt = new Date().toISOString() }) {
  if (request?.kind !== 'shadow-agent' || request.context?.mode !== 'snapshot' ||
      !nonempty(companyId) || !nonempty(parentSessionRef) ||
      !nonempty(request.parent?.agentId) || !nonempty(request.parent?.executionId) ||
      !nonempty(request.parent?.taskId) || !Array.isArray(decisions) ||
      !control || control.companyId !== companyId ||
      !Array.isArray(control.escalations) || !Array.isArray(control.knowledge) ||
      !Array.isArray(control.feedback) || !Array.isArray(control.plans) ||
      !isoTime(capturedAt)) {
    throw new Error('Invalid Shadow snapshot source');
  }
  const advisory = validateSnapshotAdvisory(request.context.snapshot);
  const source = { companyId, agentId: request.parent.agentId,
    executionId: request.parent.executionId, taskId: request.parent.taskId,
    runId: run?.id ?? null, nodeId: request.parent.nodeId ?? null,
    projectId: run?.input?.projectId ?? issueProjectId,
    parentSessionRef };
  const feature = run?.input?.feature ?? null;
  const projectId = source.projectId;
  const selected = decisions.filter((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || !nonempty(record.id)) {
      throw new Error('Invalid authoritative Decision Record');
    }
    if (record.type === 'product') return !feature || record.feature === feature;
    if (run?.id && record.runId === run.id) return true;
    if (record.issueId === source.taskId || record.taskId === source.taskId) return true;
    if (projectId && record.projectId === projectId) return true;
    // Records with no scope are company-wide controls. Product decisions
    // without a matching feature never become a company-wide constraint.
    return record.type !== 'product' && !record.runId && !record.issueId &&
      !record.taskId && !record.projectId;
  });
  const product = selected.filter((item) => item.type === 'product');
  const superseded = new Set(product.filter((item) => item.status === 'approved')
    .map((item) => item.supersedes).filter(Boolean));
  const activeProductDecisionIds = product.filter((item) =>
    item.status === 'approved' && !superseded.has(item.id)).map((item) => item.id);
  const planIds = new Set(control.plans.filter((plan) => plan.projectId === projectId)
    .map((plan) => plan.id));
  const subjectIds = new Set([companyId, source.agentId, source.taskId,
    source.runId, projectId, ...planIds].filter(nonempty));
  const escalations = control.escalations.filter((item) => subjectIds.has(item.subjectId));
  const knowledge = projectId ? control.knowledge.filter((item) => item.projectId === projectId) : [];
  const feedback = projectId ? control.feedback.filter((item) => item.projectId === projectId) : [];
  const payload = { schema: 'polyforge.temporary-agent.snapshot.v1', capturedAt,
    source, advisory, authority: { feature, projectId, decisions: structuredClone(selected),
      activeProductDecisionIds,
      scope: { productHistory: feature ? 'feature' : 'all-company',
        decisionRecords: 'run-issue-project-and-company',
        controlRecords: 'matching-subject-or-project' },
      escalations: structuredClone(escalations),
      knowledge: structuredClone(knowledge), feedback: structuredClone(feedback) } };
  if (Buffer.byteLength(canonical(payload) ?? '') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Authoritative Shadow snapshot exceeds bounded limit');
  }
  return { ...payload, digest: digestFor(payload) };
}

export function verifyTemporaryAgentSnapshot(snapshot, { request, companyId }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !/^sha256:[a-f0-9]{64}$/.test(snapshot.digest ?? '')) {
    throw new Error('Shadow snapshot missing or malformed');
  }
  const { digest, ...payload } = snapshot;
  if (payload.schema !== 'polyforge.temporary-agent.snapshot.v1' ||
      !isoTime(payload.capturedAt) ||
      Buffer.byteLength(canonical(payload) ?? '') > MAX_SNAPSHOT_BYTES ||
      digestFor(payload) !== digest ||
      payload.source?.companyId !== companyId ||
      payload.source?.agentId !== request?.parent?.agentId ||
      payload.source?.executionId !== request?.parent?.executionId ||
      payload.source?.taskId !== request?.parent?.taskId ||
      payload.source?.parentSessionRef !== request?.context?.parentSessionRef ||
      payload.source?.runId !== (request?.parent?.runId ?? null) ||
      payload.source?.nodeId !== (request?.parent?.nodeId ?? null) ||
      canonical(payload.advisory) !== canonical(request?.context?.snapshot)) {
    throw new Error('Shadow snapshot source or digest mismatch');
  }
  validateSnapshotAdvisory(payload.advisory);
  if (!Array.isArray(payload.authority?.decisions) ||
      !Array.isArray(payload.authority?.activeProductDecisionIds) ||
      !Array.isArray(payload.authority?.escalations) ||
      !Array.isArray(payload.authority?.knowledge) ||
      !Array.isArray(payload.authority?.feedback)) {
    throw new Error('Shadow snapshot authority missing');
  }
  return snapshot;
}
