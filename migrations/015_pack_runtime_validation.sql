CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_pack_runtime_validation (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  graph_run_id text NOT NULL,
  validation_revision bigint NOT NULL,
  validation_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('valid', 'invalid')),
  source_graph_revision bigint NOT NULL,
  source_digest text NOT NULL,
  adapter_identity jsonb,
  previous_identity jsonb,
  actor jsonb NOT NULL,
  reason text NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  validated_subject_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, graph_run_id, validation_revision)
);
