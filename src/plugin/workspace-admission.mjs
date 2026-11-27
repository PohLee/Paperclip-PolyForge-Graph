import { WorkspaceLeaseError, assertWorkspaceHostCapabilities, authorizeWorkspaceIdentity } from '../host/workspace-lease.mjs';

/** Check pinned policy without consuming an Agent slot or starting a child workflow. */
export async function checkPinnedWorkspacePolicy({ companyId, run, nodeId, attempt, phase }) {
  const node = run.graph.nodes.find(candidate => candidate.id === nodeId);
  if (!node) throw new Error('Dispatch node is not in the pinned graph');
  const declarations = [node.workspace?.writeAccess, run.pack?.workspace?.writeAccess];
  if (declarations.some(value => value !== undefined && !['none', 'exclusive'].includes(value))) {
    return { admitted: false, status: 'blocked', reason: 'invalid_workspace_declaration' };
  }
  try {
    await admitDeclaredWorkspaceWrite({
      declaration: declarations.includes('exclusive') ? 'exclusive' : undefined,
      // Admission stays closed until fencing and slot release have an atomic or
      // compensating lifecycle. A policy check must never acquire a lease.
      host: null,
      context: { companyId, runId: run.id, nodeId, attempt, phase },
    });
    return { admitted: true };
  } catch (error) {
    if (!(error instanceof WorkspaceLeaseError)) throw error;
    return { admitted: false, status: 'blocked', reason: 'workspace_admission_unavailable', code: error.code };
  }
}

/** Only explicit write declarations opt into managed admission; all other dispatches remain legacy unmanaged. */
export async function admitDeclaredWorkspaceWrite({ declaration, host, context }) {
  if (declaration !== 'exclusive') return { mode: 'legacy_unmanaged' };
  assertWorkspaceHostCapabilities(host?.workspaceCapabilities);
  if (typeof host?.admitFencedWorkspace !== 'function' || typeof host?.resolveTrustedWorkspace !== 'function') {
    throw new WorkspaceLeaseError('host_capability_missing', 'Host workspace admission is unavailable');
  }
  const trusted = await host.resolveTrustedWorkspace(context);
  const identity = await authorizeWorkspaceIdentity(trusted?.identity, trusted?.allowedRoots);
  const receipt = await host.admitFencedWorkspace({ ...context, identity });
  if (!receipt || receipt.enforced !== true || !/^[a-f0-9]{64}$/.test(receipt.workspaceKey ?? '') ||
      receipt.workspaceKey !== identity.key || !/^\d+$/.test(String(receipt.fence ?? '')) || Number(receipt.fence) < 1 ||
      !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= Date.now() ||
      ['companyId', 'runId', 'nodeId', 'attempt', 'phase'].some(key => receipt[key] !== context[key])) {
    throw new WorkspaceLeaseError('identity_mismatch', 'Host workspace admission returned an invalid receipt');
  }
  return { mode: 'fenced', workspaceKey: receipt.workspaceKey, fence: String(receipt.fence) };
}
