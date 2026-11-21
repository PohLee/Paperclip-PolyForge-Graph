// Dashboard projections can settle separately after a callback or Host restart.
// Select one response that supplies all state and policy evidence for the gate.
export function manualReviewReady(value) {
  const run = value?.run, assessment = run?.nodeStates?.['assess-request'];
  return run?.status === 'running' && run.mode === 'manual' &&
    assessment?.status === 'awaiting_supervisor_review' && assessment.attempts?.length === 1 &&
    assessment.artifacts?.length > 0 && assessment.attempts[0].supervisorReview === null &&
    run.nodeStates['triage-disposition']?.attempts?.length === 0 &&
    value.work?.some(item => item.nodeId === 'assess-request' && item.phase === 'supervisor' &&
      item.kind === 'human' && item.operation === 'review') === true;
}

export function assistedAcceptanceReady(value) {
  const run = value?.run, gate = run?.nodeStates?.['acceptance-gate'];
  return run?.status === 'running' && run.mode === 'assisted' &&
    gate?.status === 'pending' && gate.attempts?.length === 0 &&
    run.nodeStates.qa?.status === 'completed' &&
    value.ready?.some(node => node.id === 'acceptance-gate') === true &&
    value.work?.some(item => item.nodeId === 'acceptance-gate' &&
      item.kind === 'human' && item.operation === 'decide') === true;
}
