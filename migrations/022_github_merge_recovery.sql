ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_receipts
  ADD COLUMN cleanup_attempt_at timestamptz;
CREATE INDEX github_merge_receipts_cleanup_due
  ON plugin_polyforge_graph_ff7d84e8bb.github_merge_receipts (cleanup_attempt_at, created_at, operation_key)
  WHERE cleanup_state = 'pending';

ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_journal
  DROP CONSTRAINT github_merge_journal_state_check,
  ADD CHECK (state IN ('claimed','intent','patched','recorded','acked','unresolved','abandoned')),
  ADD COLUMN patch_send_started boolean,
  ADD COLUMN recovery_delete_sha text CHECK (recovery_delete_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN recovery_json jsonb;

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_recovery (
  operation_key text PRIMARY KEY,
  repository_node_id text NOT NULL,
  company_id uuid NOT NULL,
  run_id text NOT NULL,
  node_id text NOT NULL,
  attempt_index integer NOT NULL,
  kind text NOT NULL,
  proof_json jsonb NOT NULL,
  publication_json jsonb NOT NULL,
  temp_ref text NOT NULL,
  merge_sha text,
  recovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_merge_recovery_subject
  ON plugin_polyforge_graph_ff7d84e8bb.github_merge_recovery (company_id,run_id,node_id,attempt_index,kind);
