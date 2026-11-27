const list = value => Array.isArray(value) ? value : [];
const staleErrors = [
  'Run changed since validation; revalidate before applying',
  'Stale or missing human decision identity',
  'Stale or missing rework decision identity',
  'Decision is not waiting for human',
  'No rework limit awaiting human',
  'Conflict is not waiting for human',
  'Work is not awaiting supervisor review',
];

export function isStaleReviewError(error) {
  const message = String(error?.message ?? error ?? '').trim();
  return staleErrors.some(text => message === text || message.endsWith(`: ${text}`));
}

export function reviewRequest(run, work) {
  if (!run || !work) return null;
  const requests = {
    'resolve-human-gate': ['decision', run.pendingHuman?.escalationDecisionId],
    'resolve-rework-limit': ['rework_limit', run.pendingHuman?.decisionId],
    'resolve-conflict': ['conflict', work.conflictId],
    'resolve-takeover': ['takeover', run.takeover?.id],
    'resolve-product-decision': ['product_decision', work.proposalId],
  };
  const [kind, requestId] = requests[work.operation] ?? [work.operation, work.nodeId];
  return { kind, requestId, runId: run.id, nodeId: work.nodeId ?? null };
}

function sameRequest(current, other) {
  return Boolean(current?.requestId && current.requestId === other?.requestId &&
    current.runId === other.runId && current.kind === other.kind &&
    current.nodeId === (other.nodeId ?? null));
}

export function reviewHandoff(data, request, previous) {
  const scoped = list(data.nativeDecisions).filter(item => request?.kind === 'product_decision'
    ? item.kind === request.kind && item.runId === request.runId && item.proposalId === request.requestId
    : sameRequest(request, item));
  const staleItem = scoped.find(item => item.status === 'stale' || isStaleReviewError(item.syncError));
  const native = scoped.find(item => item.status === 'pending' && item.url && item.interactionId &&
    (request.kind === 'product_decision' ||
      (data.runDigest && item.runDigest === data.runDigest)));
  const outdated = sameRequest(request, previous) ? previous : staleItem && {
    ...request, runDigest: staleItem.runDigest, interactionId: staleItem.replacedInteractionId ?? staleItem.interactionId,
  };
  const replacement = Boolean(outdated && native &&
    (outdated.interactionId ? native.interactionId !== outdated.interactionId : native.runDigest !== outdated.runDigest));
  const refreshed = Boolean(outdated?.runDigest && data.runDigest && data.runDigest !== outdated.runDigest);
  return {
    native: !outdated || replacement ? native : null,
    syncError: scoped.find(item => item.syncError && !isStaleReviewError(item.syncError))?.syncError,
    outdated, replacement, refreshed,
    refreshNeeded: Boolean(outdated && !replacement && !refreshed),
  };
}

const artifactKey = (id, version) => JSON.stringify([id, version]);
const currentArtifacts = values => [...new Map(list(values).map(item => [item?.id, item])).values()]
  .filter(item => typeof item?.id === 'string' && item.id && typeof item.version === 'string' && item.version);

export function reviewCandidate(data, work, node, request) {
  const { run } = data;
  const supervisor = work.operation === 'review';
  const gate = ['decide', 'resolve-human-gate'].includes(work.operation);
  const candidateNodes = supervisor ? [work.nodeId] : gate ? list(node?.candidateNodes) : [];
  const states = candidateNodes.map(id => run.nodeStates[id]);
  const candidateKinds = gate ? list(node?.candidateKinds) : [];
  const artifacts = states.flatMap(state => {
    const attempt = state?.attempts?.at(-1);
    return supervisor ? currentArtifacts(attempt?.artifacts)
      : state?.status === 'completed' ? currentArtifacts(state.artifacts) : [];
  }).filter(item => supervisor || !candidateKinds.length || candidateKinds.includes(item.kind));
  const refs = new Set(artifacts.map(item => artifactKey(item.id, item.version)));
  const record = list(data.decisions).find(item => item.id === request?.requestId && item.runId === run.id);
  const sources = [
    ...list(record?.evidence),
    ...Object.entries(run.nodeStates).flatMap(([id, state]) => {
      if (state.status !== 'completed' && !(supervisor && id === work.nodeId)) return [];
      const attempt = state.attempts?.at(-1);
      const review = list(data.decisions).find(item => item.id === attempt?.supervisorReview?.decisionId &&
        item.runId === run.id && item.nodeId === id &&
        (item.attemptNumber == null || item.attemptNumber === state.attempts.length));
      return [...list(attempt?.evidence), ...list(review?.evidence)];
    }),
  ];
  const boundEvidence = sources.filter(item => list(item?.subjectRefs)
    .some(ref => refs.has(artifactKey(ref?.artifactId, ref?.version))));
  const evidence = [...new Map(boundEvidence.map(item => [JSON.stringify(item), item])).values()];
  return {
    question: record?.question ?? node?.purpose,
    proposal: request?.kind === 'product_decision' ? record?.outcome : null,
    reason: record?.reason,
    artifacts: [...new Map(artifacts.map(item => [artifactKey(item.id, item.version), item])).values()],
    missingArtifacts: !supervisor && (states.some(state => state?.status !== 'completed') ||
      candidateKinds.some(kind => !artifacts.some(item => item.kind === kind))),
    evidence,
  };
}

export function reviewSourceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
