CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_issue_assignment (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  request jsonb,
  outcome text NOT NULL CHECK (outcome IN ('unknown','confirmed_success','confirmed_failure')),
  result jsonb,
  generation bigint NOT NULL DEFAULT 0,
  retirement_owners jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(retirement_owners)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, operation_id)
);
