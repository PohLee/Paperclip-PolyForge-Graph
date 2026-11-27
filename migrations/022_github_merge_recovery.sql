ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_receipts
  ADD COLUMN cleanup_attempt_at timestamptz;
CREATE INDEX github_merge_receipts_cleanup_due
  ON plugin_polyforge_graph_ff7d84e8bb.github_merge_receipts (cleanup_attempt_at, created_at, operation_key)
  WHERE cleanup_state = 'pending';
