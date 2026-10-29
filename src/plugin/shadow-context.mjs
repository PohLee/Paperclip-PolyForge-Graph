import { createHash } from 'node:crypto';

const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

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
    goalContext: run.goalContext ?? null, candidates };
  const snapshotId = createHash('sha256').update(canonical(packet)).digest('hex');
  return { ...packet, snapshotId };
}
