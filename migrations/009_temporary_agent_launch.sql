CREATE TABLE IF NOT EXISTS plugin_polyforge_graph_ff7d84e8bb.graph_temporary_agent_launch (
  company_id uuid NOT NULL,
  request_key text NOT NULL,
  temporary_agent_id uuid NOT NULL DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL,
  parent_agent_id uuid NOT NULL,
  parent_execution_id text NOT NULL,
  agent_id uuid NOT NULL,
  parent_slot integer NOT NULL,
  session_id text,
  execution_id text,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  outcome text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, request_key),
  UNIQUE (company_id, temporary_agent_id),
  CHECK (status IN ('claimed','creating','created','sending','active','stopping','closing','closed','needs-repair'))
);
CREATE INDEX IF NOT EXISTS graph_temporary_agent_parent_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_temporary_agent_launch
  (company_id, parent_agent_id, parent_execution_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS graph_temporary_agent_active_slot_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_temporary_agent_launch
  (company_id, parent_agent_id, parent_execution_id, parent_slot)
  WHERE status<>'closed';
