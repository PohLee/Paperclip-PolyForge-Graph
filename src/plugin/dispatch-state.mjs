// These labels describe evidence, not an assumed Paperclip lifecycle.
export function normalizeDispatchState(row, { admitted = false } = {}) {
  if (row?.checkout_verified_at && row.agent_run_id) return 'started';
  if (row?.issue_id) return 'dispatched';
  if (admitted || row) return 'admitted';
  return 'requested';
}
