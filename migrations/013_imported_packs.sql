CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_imported_packs (
  pack_id text NOT NULL,
  version text NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  document text NOT NULL,
  source jsonb NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version)
);
