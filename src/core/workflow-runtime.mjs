import { projectWorkflowOutput } from './workflow-contracts.mjs';

/** A trusted embedding facade. Authentication and issue access remain Host responsibilities. */
export function createWorkflowRuntime({ engine, dispatch } = {}) {
  if (!engine || typeof engine.startRun !== 'function' || typeof engine.getRun !== 'function') {
    throw new Error('Workflow runtime requires a GraphEngine');
  }
  if (dispatch !== undefined && typeof dispatch !== 'function') throw new Error('dispatch must be a function');

  async function statusOf(run, seen = new Set()) {
    if (seen.has(run.id)) throw new Error('Recursive workflow run linkage');
    seen.add(run.id);
    if (run.parentWorkflow && run.status === 'running') {
      let descendant = run;
      const lineage = new Set([run.id]);
      while (descendant.parentWorkflow) {
        const { runId, nodeId, attempt } = descendant.parentWorkflow;
        if (lineage.has(runId)) throw new Error('Recursive workflow run linkage');
        lineage.add(runId);
        const parent = await engine.getRun(runId), link = parent?.nodeStates?.[nodeId];
        if (parent?.status === 'paused') return 'paused';
        if (parent?.status === 'failed') return 'failed';
        if (parent?.status !== 'running' || link?.childRunId !== descendant.id ||
            link.attempts?.[attempt - 1]?.childRunId !== descendant.id || link.status !== 'waiting_child') return 'blocked';
        descendant = parent;
      }
    }
    if (run.status === 'completed') return 'completed';
    if (run.status === 'stopped' || run.status === 'failed') return run.status;
    if (run.status === 'rework_required') return 'rework_required';
    if (run.status === 'paused') {
      const work = await engine.getWorkItems(run.id);
      return work.some(item => item.kind === 'human') || run.graph.nodes.some(node => node.type === 'end' &&
        node.output === 'human_decision_pending' && run.nodeStates[node.id]?.status === 'completed')
        ? 'waiting_for_human' : 'paused';
    }
    for (const node of run.graph.nodes.filter(item => item.type === 'workflow')) {
      const ns = run.nodeStates[node.id];
      if (ns?.status === 'child_blocked') return ['rework_required', 'failed'].includes(ns.childStatus) ? ns.childStatus : 'blocked';
      if (ns?.status !== 'waiting_child') continue;
      const child = await engine.getRun(ns.childRunId);
      if (!child || child.parentWorkflow?.runId !== run.id || child.parentWorkflow.nodeId !== node.id ||
          child.parentWorkflow.attempt !== ns.attempts.length) return 'blocked';
      const childStatus = await statusOf(child, seen);
      if (['waiting_for_human', 'paused', 'rework_required', 'blocked', 'stopped', 'failed'].includes(childStatus)) {
        return childStatus === 'stopped' ? 'blocked' : childStatus;
      }
    }
    const work = await engine.getWorkItems(run.id);
    if (work.some(item => item.kind === 'human')) return 'waiting_for_human';
    if (work.some(item => item.kind === 'blocked')) return 'blocked';
    if ((await engine.getBlockedNodes(run.id)).length) return 'blocked';
    return 'running';
  }

  async function result(run) {
    const handle = { runId: run.id, status: await statusOf(run), workflow: {
      packId: run.packId, packVersion: run.packVersion, graphId: run.graph.id, graphVersion: run.graph.version,
    } };
    if (run.status === 'completed' && run.graph.workflowContract) {
      handle.output = projectWorkflowOutput(run);
    }
    return { run, handle };
  }

  return {
    async start(args) {
      const run = await engine.startRun(args);
      if (dispatch) await dispatch(run);
      return result(await engine.getRun(run.id));
    },
    async inspect(runId) {
      const run = await engine.getRun(runId);
      if (!run) throw new Error('Run not found');
      return result(run);
    },
    async reconcile(runId, actor) {
      if (actor?.kind !== 'system') throw new Error('Workflow reconciliation requires a trusted system actor');
      let run = await engine.getRun(runId);
      if (!run) throw new Error('Run not found');
      if (run.status !== 'running') return result(run);
      for (const node of run.graph.nodes.filter(item => item.type === 'workflow')) {
        const ns = run.nodeStates[node.id];
        let child = null;
        if (ns?.status === 'pending' && (await engine.getReadyNodes(runId)).some(item => item.id === node.id)) {
          child = await engine.startChildWorkflow({ runId, nodeId: node.id, actor });
        } else if (ns?.status === 'waiting_child') {
          child = await engine.getRun(ns.childRunId);
        }
        // A retry presents the same durable child identity to the host. The host owns
        // dispatch reservations because Core cannot infer whether a prior call ran.
        if (dispatch && child?.status === 'running' && await engine.isDispatchEligible(child.id)) {
          await dispatch(child);
        }
        run = await engine.reconcileChildWorkflow({ runId, nodeId: node.id, actor });
        if (run.status !== 'running') break;
      }
      return result(run);
    },
  };
}
