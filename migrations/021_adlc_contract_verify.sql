ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests
  ADD COLUMN execution_state text CHECK (execution_state IN ('verified', 'verification-failed', 'recorded', 'merged-unverified')),
  ADD COLUMN execution_reason text,
  ADD COLUMN verification_status jsonb;
