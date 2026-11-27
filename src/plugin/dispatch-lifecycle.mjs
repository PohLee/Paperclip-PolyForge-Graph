// Facts must come from the host adapter; graph declarations only select policy.
export async function assessDispatchLifecycle({ host, companyId, run, node, attempt, phase }) {
  const privileged = phase !== 'supervisor' && node.hostLifecycle?.privileged === true;
  const assess = host.assessGraphDispatchLifecycle;
  if (typeof assess !== 'function') return {
    managed: false, workStatus: run.nodeStates[node.id]?.status ?? 'unknown', executionStage: phase,
    dependencyReadiness: 'unmanaged', reviewPath: phase === 'supervisor' ? 'supervisor' : 'work',
    workspaceFinalize: 'unmanaged', admission: privileged ? 'blocked' : 'unmanaged',
    reason: privileged ? 'trusted_lifecycle_unavailable' : undefined,
  };
  const facts = await assess({ companyId, runId: run.id, nodeId: node.id, attempt, phase });
  const dependencies = facts?.dependencies;
  const valid = Array.isArray(dependencies) && dependencies.every((item) =>
    ['before_work', 'before_review', 'after_review'].includes(item?.applyAt) &&
    ['ready', 'blocked', 'unknown'].includes(item?.status));
  const applicable = valid ? dependencies.filter((item) =>
    item.applyAt === (phase === 'supervisor' ? 'before_review' : 'before_work') ||
    (privileged && item.applyAt === 'after_review')) : [];
  const dependencyReadiness = !valid ? 'unknown' : applicable.some((item) => item.status === 'blocked') ? 'blocked'
    : applicable.some((item) => item.status === 'unknown') ? 'unknown' : 'ready';
  const finalize = ['confirmed_success', 'confirmed_failure', 'unknown'].includes(facts?.workspaceFinalize)
    ? facts.workspaceFinalize : 'unknown';
  const blocked = dependencyReadiness !== 'ready' || (privileged && finalize !== 'confirmed_success');
  return { managed: true, workStatus: run.nodeStates[node.id]?.status ?? 'unknown', executionStage: phase,
    dependencyReadiness, reviewPath: phase === 'supervisor' ? 'supervisor' : 'work', workspaceFinalize: finalize,
    admission: blocked ? 'blocked' : 'admitted',
    reason: dependencyReadiness !== 'ready' ? 'dependency_' + dependencyReadiness
      : privileged && finalize !== 'confirmed_success' ? 'workspace_finalize_' + finalize : undefined };
}
