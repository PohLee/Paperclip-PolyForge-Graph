CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  document jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_dispatch (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  graph_run_id text NOT NULL,
  node_id text NOT NULL,
  attempt integer NOT NULL,
  phase text NOT NULL,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  agent_run_id uuid,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, graph_run_id, node_id, attempt, phase)
);

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_config (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  role_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
