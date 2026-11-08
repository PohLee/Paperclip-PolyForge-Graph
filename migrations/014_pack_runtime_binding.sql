CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_pack_runtime (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  graph_run_id text NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  pack_digest text NOT NULL,
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  adapter_bundle_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, graph_run_id)
);
