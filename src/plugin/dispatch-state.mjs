// These labels describe evidence, not an assumed Paperclip lifecycle.
export function normalizeDispatchState(row, { admitted = false, assignment } = {}) {
  if (row?.checkout_verified_at && row.agent_run_id) return 'started';
  if (row?.issue_id && (row.state === 'woken' || row.agent_run_id || assignment?.outcome === 'confirmed_success')) return 'dispatched';
  if (admitted || row) return 'admitted';
  return 'requested';
}
