CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_dispatch_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  graph_run_id text NOT NULL,
  issue_id uuid NOT NULL,
  actor_user_id text NOT NULL,
  actor_roles jsonb NOT NULL,
  reason text NOT NULL,
  feature text,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  graph_id text NOT NULL,
  graph_version text NOT NULL,
  idempotency_key text,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX graph_dispatch_requests_company_run_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_dispatch_requests (company_id, graph_run_id, created_at DESC);
