// Stable DAG positioning shared by the definition and pinned-run views.
export function layoutGraph(graph) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const known = new Set(nodes.map(node => node.id));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const children = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    children.get(edge.from).push(edge.to);
  }
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const depth = new Map(nodes.map(node => [node.id, 0]));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of children.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1));
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  if (queue.length !== nodes.length) return { error: 'This definition contains a cycle. Its nodes are listed below.', nodes: [], edges: [] };
  const levels = [];
  for (const node of nodes) (levels[depth.get(node.id)] ??= []).push(node);
  const width = Math.max(620, ...levels.map(level => level.length * 240 + 72));
  const positioned = levels.flatMap((level, row) => level.map((node, column) => ({
    ...node, x: (width - level.length * 240) / 2 + column * 240 + 12, y: row * 142 + 30, width: 216, height: 82,
  })));
  const positions = new Map(positioned.map(node => [node.id, node]));
  const links = [...edges.map(edge => ({ ...edge, rework: false })), ...nodes.filter(node => node.reworkTarget && known.has(node.reworkTarget)).map(node => ({ from: node.id, to: node.reworkTarget, when: 'Rework', rework: true }))];
  return { width, height: Math.max(150, levels.length * 142), nodes: positioned, edges: links.filter(edge => positions.has(edge.from) && positions.has(edge.to)).map((edge, index) => ({ ...edge, key: `${edge.from}:${edge.to}:${index}`, source: positions.get(edge.from), target: positions.get(edge.to) })) };
}

export function graphNodeState(nodeId, { run, ready = [], blocked = [] } = {}) {
  if (!run) return 'definition';
  if (blocked.some(item => item.id === nodeId || item.nodeId === nodeId)) return 'blocked';
  const state = run.nodeStates?.[nodeId]?.status ?? 'pending';
  if (run.status === 'completed' && state === 'pending') return 'not_run';
  if (run.status === 'running' && ready.some(item => item.id === nodeId || item.nodeId === nodeId) && state === 'pending') return 'ready';
  return state;
}
