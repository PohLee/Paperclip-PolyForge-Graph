const copy = value => structuredClone(value);

export function isIndependentReview(run, nodeId, phase = 'work') {
  const node = run.graph.nodes.find(item => item.id === nodeId);
  return Boolean(node && (phase === 'supervisor' || node.independentOf?.length));
}

// The first review sees the work product and pinned constraints, not the
// author's self-assessment, work decisions, or intermediate conversation.
export function reviewPacket(run, nodeId, phase = 'work') {
  if (!isIndependentReview(run, nodeId, phase)) return null;
  const node = run.graph.nodes.find(item => item.id === nodeId);
  const candidateIds = phase === 'supervisor' ? [nodeId] : node.independentOf;
  const candidates = candidateIds.map(id => {
    const state = run.nodeStates[id];
    const attempt = state?.attempts?.at(-1);
    return {
      nodeId: id, status: state?.status ?? 'pending',
      artifacts: copy(state?.artifacts ?? attempt?.artifacts ?? []),
      output: copy(attempt?.output ?? state?.output ?? null),
      evidence: copy(attempt?.evidence ?? state?.evidence ?? []),
    };
  });
  const sourceArtifacts = Object.entries(run.nodeStates)
    .filter(([id, state]) => !candidateIds.includes(id) && state.status === 'completed')
    .map(([id, state]) => ({ nodeId: id, artifacts: copy(state.artifacts ?? []) }))
    .filter(item => item.artifacts.length);
  return {
    schemaVersion: 1, runId: run.id, graphId: run.graph.id, graphVersion: run.graph.version,
    packId: run.packId, packVersion: run.packVersion, reviewNodeId: nodeId, phase,
    freshContextRequired: Boolean(node.freshContextRequired),
    requirementsAndConstraints: copy(run.input), candidates, sourceArtifacts,
    note: 'Read candidate artifacts and cited source evidence directly. Record findings with severity and location. Author self-review is available after the independent disposition.',
  };
}

export function projectReviewRun(run, nodeId, phase = 'work') {
  const packet = reviewPacket(run, nodeId, phase);
  if (!packet) return run;
  return {
    id: run.id, status: run.status, packId: run.packId, packVersion: run.packVersion,
    graph: { id: run.graph.id, version: run.graph.version,
      nodes: [run.graph.nodes.find(item => item.id === nodeId)], edges: [] },
    input: copy(run.input), reviewPacket: packet,
    nodeStates: Object.fromEntries(packet.candidates.map(candidate => [candidate.nodeId, candidate])),
  };
}

export function contextInventory(parts) {
  const components = Object.entries(parts).map(([name, value]) => ({
    name, characters: String(value ?? '').length,
    truncated: String(value ?? '').includes('[truncated;') || String(value ?? '').includes('[nested content omitted;'),
  }));
  return { unit: 'UTF-16 code units', components,
    totalCharacters: components.reduce((total, item) => total + item.characters, 0),
    modelRequestMeasured: false };
}

// Derived from the durable Graph state, so a new session can recover without
// trusting an agent-authored summary as the source of truth.
export function handoffSnapshot(run, { decisions = [], workItems = [] } = {}) {
  const completed = Object.entries(run.nodeStates)
    .filter(([, state]) => state.status === 'completed')
    .map(([nodeId, state]) => ({ nodeId, artifacts: copy(state.artifacts ?? []),
      evidence: copy(state.evidence ?? state.attempts?.at(-1)?.evidence ?? []) }));
  const pending = Object.entries(run.nodeStates)
    .filter(([, state]) => state.status !== 'completed')
    .map(([nodeId, state]) => ({ nodeId, status: state.status }));
  return { runId: run.id, graphId: run.graph.id, packVersion: run.packVersion,
    goalAndConstraints: copy(run.input), completed, pending,
    decisions: decisions.map(item => ({ id: item.id, type: item.type, outcome: item.outcome,
      reason: item.reason, evidence: copy(item.evidence ?? []) })),
    nextActions: workItems.map(item => ({ nodeId: item.nodeId, phase: item.phase,
      operation: item.operation, role: item.role, reason: item.reason })),
    unresolvedHumanDecision: copy(run.pendingHuman ?? null),
    fullStateRef: `graph-run:${run.id}` };
}
