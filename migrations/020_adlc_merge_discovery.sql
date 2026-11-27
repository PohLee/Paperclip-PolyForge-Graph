CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_requests (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  node_id text NOT NULL,
  attempt_index integer NOT NULL CHECK (attempt_index > 0),
  kind text NOT NULL,
  fingerprint text NOT NULL,
  request_json jsonb NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('admitted', 'rejected-admission', 'fingerprint-conflict')),
  reason text,
  observed_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, run_id, node_id, attempt_index, kind)
);

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.adlc_merge_discovery (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  last_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
