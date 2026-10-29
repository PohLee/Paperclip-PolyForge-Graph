CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  agent_id uuid NOT NULL,
  parent_run_id text NOT NULL,
  parent_task_id text NOT NULL,
  session_id text,
  shadow_id text,
  execution_id text,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed','session-created','reserved','active','closed','needs-repair')),
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, request_key)
);
CREATE INDEX graph_shadow_launch_open_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch (company_id, status, updated_at)
  WHERE status IN ('claimed','session-created','reserved','active','needs-repair');
