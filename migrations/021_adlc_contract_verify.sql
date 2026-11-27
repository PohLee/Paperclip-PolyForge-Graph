ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests
  ADD COLUMN execution_state text CHECK (execution_state IN ('verified', 'verification-failed', 'recorded', 'merged-unverified')),
  ADD COLUMN execution_reason text,
  ADD COLUMN verification_status jsonb;


CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_contract_statuses (
  repository_id bigint NOT NULL,
  app_id bigint NOT NULL,
  head_sha text NOT NULL,
  context text NOT NULL,
  pending boolean NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('success', 'failure')),
  desired_description text NOT NULL,
  state text CHECK (state IN ('success', 'failure')),
  description text,
  PRIMARY KEY (repository_id, app_id, head_sha, context)
);
