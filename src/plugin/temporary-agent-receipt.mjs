import { validateTemporaryAgentContextReceipt } from '../core/temporary-agent-contract.mjs';
import { verifyTemporaryAgentSnapshot } from './temporary-agent-snapshot.mjs';

/** The one place that binds a durable launch to its frozen context and native run. */
export function assertTemporaryAgentLaunchContext(launch) {
  const request = launch?.data?.request;
  if (!request || !launch.companyId) throw new Error('Temporary Agent launch context missing');
  const snapshot = request.kind === 'shadow-agent'
    ? verifyTemporaryAgentSnapshot(launch.data.contextSnapshot,
      { request, companyId: launch.companyId }) : null;
  if (request.kind !== 'shadow-agent' && launch.data.contextSnapshot != null) {
    throw new Error('Fresh Sub-Agent cannot carry a Shadow snapshot');
  }
  if (snapshot) {
    const captured = Date.parse(snapshot.capturedAt);
    const requested = Date.parse(launch.data.requestedAt ?? '');
    // Compare durable events, not the recovering host's wall clock. New launches
    // already supply requestedAt before claim; clock rollback cannot stale one.
    if (launch.data.requestedAt && (!Number.isFinite(requested) || captured > requested)) {
      throw new Error('Shadow snapshot capture time is after the launch request');
    }
    if (launch.agentId && launch.agentId !== request.parent.agentId) {
      throw new Error('Shadow snapshot launch Agent differs from parent Agent');
    }
  }
  const receipt = launch.data.contextReceipt;
  if (receipt) {
    validateTemporaryAgentContextReceipt(receipt, request);
    if (receipt.sessionRef !== launch.sessionId ||
        receipt.executionId !== launch.executionId ||
        snapshot && (receipt.snapshotDigest !== snapshot.digest ||
          receipt.snapshotCapturedAt !== snapshot.capturedAt) ||
        !snapshot && (receipt.snapshotDigest !== undefined ||
          receipt.snapshotCapturedAt !== undefined)) {
      throw new Error('Temporary Agent durable context receipt mismatch');
    }
  } else if (launch.executionId) {
    throw new Error('Temporary Agent execution has no durable context receipt');
  }
  return snapshot;
}

/** Build the host-attested receipt after one exact native execution is known. */
export function temporaryAgentContextReceipt(launch, { sessionId, executionId }) {
  const snapshot = assertTemporaryAgentLaunchContext(launch);
  if (launch.sessionId && launch.sessionId !== sessionId ||
      launch.executionId && launch.executionId !== executionId) {
    throw new Error('Temporary Agent native execution differs from durable launch');
  }
  const request = launch.data.request;
  const receipt = { requestId: request.id, mode: request.context.mode,
    parentSessionRef: request.context.parentSessionRef,
    sessionRef: sessionId, executionId, creationMethod: 'new-session',
    ...(snapshot ? { snapshotDigest: snapshot.digest,
      snapshotCapturedAt: snapshot.capturedAt } : {}) };
  validateTemporaryAgentContextReceipt(receipt, request);
  return receipt;
}
