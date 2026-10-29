import { createHash } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

const MAX_PACKET_BYTES = 48 * 1024;
const MAX_FIELD_CHARS = 8 * 1024;
const OMIT = /(?:secret|token|password|credential|private.?key|self.?review|conversation|decision)/i;
function bounded(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.length > MAX_FIELD_CHARS) throw new Error('Shadow source field exceeds the review limit');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 30) throw new Error('Shadow source array exceeds the review limit');
    return value.map((item) => bounded(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= 12 || Object.keys(value).length > 30) throw new Error('Shadow source object exceeds the review limit');
    return Object.fromEntries(Object.entries(value).filter(([key]) => !OMIT.test(key))
      .map(([key, item]) => [key, bounded(item, depth + 1)]));
  }
  return value;
}

/** Completed candidate work and pinned requirements; no author self assessment. */
function reviewInputs(run, candidates) {
  const relevant = ['requirements', 'constraints', 'versioned_requirement', 'product_decision_refs',
    'implementation_candidate', 'acceptanceCriteria', 'successCriteria'];
  const requirements = Object.fromEntries(relevant.filter((key) => run.input?.[key] !== undefined)
    .map((key) => [key, bounded(run.input[key])]));
  const material = candidates.map((ref) => {
    const state = run.nodeStates[ref.sourceNodeId];
    const artifact = (state.artifacts ?? []).find((item) => item.id === ref.id &&
      item.version === ref.version && item.digest === ref.digest);
    const attempt = state.attempts?.at(-1);
    const evidence = attempt?.evidence ?? state.evidence;
    return { sourceNodeId: ref.sourceNodeId, candidateRef: { id: ref.id, version: ref.version,
      digest: ref.digest, kind: ref.kind },
      artifact: bounded(Object.fromEntries(Object.entries(artifact ?? {}).filter(([key]) =>
        ['content', 'text', 'body', 'url', 'uri', 'path', 'sourceRef', 'description', 'summary'].includes(key)))),
      output: bounded(attempt?.output ?? state.output ?? null),
      evidence: bounded((Array.isArray(evidence) ? evidence : []).filter((entry) =>
        !/self.?review|author.?review|conversation|decision/i.test(String(entry?.kind ?? '')))) };
  });
  return { requirements, material };
}

/** A shadow may inspect only completed, versioned candidate evidence from its parent run. */
export function shadowReviewPacket(run, taskId) {
  if (!run?.id || !taskId) throw new Error('Parent run and task are required');
  const task = run.graph?.nodes?.find((node) => node.id === taskId);
  const state = run.nodeStates?.[taskId];
  if (!task || !state || state.status === 'completed') throw new Error('Active parent task required');
  const sourceIds = task.candidateNodes?.length ? task.candidateNodes :
    run.graph.edges.filter((edge) => edge.to === taskId).map((edge) => edge.from);
  const candidates = sourceIds.flatMap((sourceId) => {
    const source = run.nodeStates[sourceId];
    if (source?.status !== 'completed') return [];
    return (source.artifacts ?? []).filter((item) => item.id && item.version && item.digest &&
      (!task.candidateKinds?.length || task.candidateKinds.includes(item.kind)))
      .map((item) => ({ sourceNodeId: sourceId, kind: item.kind, id: item.id,
        version: item.version, digest: item.digest }));
  });
  if (!candidates.length) throw new Error('No completed, versioned parent candidate is available for shadow review');
  const packet = { sourceRunId: run.id, packId: run.packId, packVersion: run.packVersion,
    graphId: run.graph.id, taskId, projectId: run.input?.projectId ?? null,
    goalContext: bounded(run.goalContext ?? null), candidates,
    sourcePolicy: { redactedFields: ['secrets', 'credentials', 'private keys',
      'author self-review', 'conversations', 'author decisions'], truncated: false },
    reviewInputs: reviewInputs(run, candidates) };
  if (Buffer.byteLength(canonical(packet)) > MAX_PACKET_BYTES) {
    throw new Error('Shadow review packet exceeds the bounded source limit');
  }
  const snapshotId = createHash('sha256').update(canonical(packet)).digest('hex');
  return { ...packet, snapshotId };
}
