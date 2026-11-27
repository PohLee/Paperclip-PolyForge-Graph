const key = (...parts) => JSON.stringify(parts);
const rate = (count, total) => ({ count, total, rate: total ? count / total : null });

export function automationMetrics(state, { projectId, from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (typeof projectId !== 'string' || !projectId.trim() || !Number.isFinite(start)
    || !Number.isFinite(end) || start >= end) throw new Error('Invalid automation metrics project or window');
  const inWindow = at => Date.parse(at) >= start && Date.parse(at) < end;
  const runs = new Map(Object.values(state.runs).filter(run => run.input.projectId === projectId).map(run => [run.id, run]));
  const ready = new Map(), firstCI = new Map(), reversals = new Set(), rework = new Map();
  const autoMerges = [];
  for (const event of state.audit) {
    if (!runs.has(event.runId)) continue;
    if (event.kind === 'gate.ready') ready.set(key(event.runId, event.nodeId, event.attemptNumber), event.at);
    if (event.kind === 'implementation.ci_result') {
      const pull = key(event.repository.toLowerCase(), event.pullNumber);
      if (!firstCI.has(pull) || Date.parse(event.at) < Date.parse(firstCI.get(pull).at)) firstCI.set(pull, event);
    }
    if (event.kind === 'implementation.reverted' && Date.parse(event.at) < end) {
      reversals.add(key(event.runId, event.mergeCommitSha));
    }
    if (!inWindow(event.at)) continue;
    if (event.kind === 'implementation.merged' && event.autoMerged === true) autoMerges.push(event);
    const isRework = event.kind === 'rework.started' || event.kind === 'work.rework_requested';
    if (!isRework && event.kind !== 'node.completed') continue;
    const nodeId = event.fromNodeId ?? event.nodeId;
    const graphId = runs.get(event.runId).graph.id;
    const node = key(graphId, nodeId);
    const counts = rework.get(node) ?? { graphId, nodeId, reworks: 0, completions: 0 };
    counts[isRework ? 'reworks' : 'completions']++;
    rework.set(node, counts);
  }
  const waits = [];
  for (const decision of state.decisions) {
    if (decision.status !== 'decided' || !inWindow(decision.at)) continue;
    const attempts = runs.get(decision.runId)?.nodeStates[decision.nodeId]?.attempts;
    const index = attempts?.findIndex(attempt => attempt.decisionId === decision.id);
    if (index == null || index < 0) continue;
    const at = ready.get(key(decision.runId, decision.nodeId, index + 1));
    const elapsed = Date.parse(decision.at) - Date.parse(at);
    if (elapsed >= 0) waits.push(elapsed);
  }
  const ci = [...firstCI.values()].filter(event => inWindow(event.at));
  const nodes = [...rework.values()];
  return {
    projectId, from, to,
    gateWaitTime: { count: waits.length, averageMilliseconds: waits.length ? waits.reduce((sum, value) => sum + value, 0) / waits.length : null },
    reworkRate: { ...rate(nodes.reduce((sum, node) => sum + node.reworks, 0),
      nodes.reduce((sum, node) => sum + node.reworks + node.completions, 0)),
      byNode: nodes.map(node => ({ ...node, ...rate(node.reworks, node.reworks + node.completions) })) },
    firstCIPassRate: rate(ci.filter(event => event.result === 'pass').length, ci.length),
    autoMergeRevertRate: rate(autoMerges.filter(event => reversals.has(key(event.runId, event.mergeCommitSha))).length, autoMerges.length),
  };
}
