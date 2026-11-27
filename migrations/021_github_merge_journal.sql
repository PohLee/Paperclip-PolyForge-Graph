CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_journal (
  repository_node_id text PRIMARY KEY,
  repository_id bigint NOT NULL UNIQUE CHECK (repository_id > 0),
  app_id bigint NOT NULL CHECK (app_id > 0),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  company_id uuid NOT NULL,
  run_id text NOT NULL,
  node_id text NOT NULL,
  attempt_index integer NOT NULL CHECK (attempt_index > 0),
  kind text NOT NULL,
  pull_number integer NOT NULL CHECK (pull_number > 0),
  operation_key text NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  fence bigint NOT NULL CHECK (fence > 0),
  claim_id uuid NOT NULL,
  claim_until timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed','intent','patched','recorded','acked','unresolved')),
  base_sha text CHECK (base_sha ~ '^[a-f0-9]{40}$'),
  head_sha text CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  temp_ref text,
  merge_sha text CHECK (merge_sha ~ '^[a-f0-9]{40}$'),
  publication_json jsonb,
  authorization_revision bigint,
  observe_after timestamptz,
  missing_fact text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'claimed' OR
    (base_sha IS NOT NULL AND head_sha IS NOT NULL AND temp_ref IS NOT NULL
      AND publication_json IS NOT NULL AND authorization_revision IS NOT NULL AND observe_after IS NOT NULL)),
  CHECK (state NOT IN ('patched','recorded','acked') OR merge_sha IS NOT NULL),
  CHECK ((state = 'unresolved') = (missing_fact IS NOT NULL))
);
CREATE INDEX github_merge_journal_due ON plugin_polyforge_graph_ff7d84e8bb.github_merge_journal (state, observe_after, updated_at);
CREATE INDEX github_merge_journal_subject ON plugin_polyforge_graph_ff7d84e8bb.github_merge_journal (company_id,run_id,node_id,attempt_index,kind);

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.github_merge_receipts (
  repository_node_id text NOT NULL REFERENCES plugin_polyforge_graph_ff7d84e8bb.github_merge_journal (repository_node_id),
  pull_number integer NOT NULL,
  operation_key text NOT NULL UNIQUE,
  company_id uuid NOT NULL,
  run_id text NOT NULL,
  receipt_json jsonb NOT NULL,
  temp_ref text NOT NULL,
  cleanup_state text NOT NULL DEFAULT 'pending'
    CHECK (cleanup_state IN ('pending','complete','ref-changed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_node_id,pull_number)
);

ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN execution_state text CHECK (execution_state IN
  ('blocked-config','backoff','needs-new-approval','reconciling','recording','recorded','unresolved'));
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN execution_version bigint NOT NULL DEFAULT 0;
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN execution_reason text;
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN next_try_at timestamptz;
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN operation_key text;
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests ADD COLUMN receipt_json jsonb;
CREATE INDEX adlc_contract_publication_due ON plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests (next_try_at,updated_at)
  WHERE disposition='admitted' AND kind IN
    ('contract_publication_request','technical_publication_request','design_publication_request');
