ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_dispatch
  ADD COLUMN checkout_verified_at timestamptz;

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_external_effect (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  request jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('unknown','confirmed_success','confirmed_failure')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, operation_id)
);
