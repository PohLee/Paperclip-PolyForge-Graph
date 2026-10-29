ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch
  DROP CONSTRAINT IF EXISTS graph_shadow_launch_status_check;
ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch
  ADD CONSTRAINT graph_shadow_launch_status_check CHECK (status IN (
    'claimed','creating','session-created','reserved','starting','active',
    'closing','closed','needs-repair'));

CREATE UNIQUE INDEX graph_shadow_launch_parent_open_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch
  (company_id,parent_run_id,parent_task_id) WHERE status<>'closed';

CREATE INDEX graph_shadow_launch_runtime_open_idx
  ON plugin_polyforge_graph_ff7d84e8bb.graph_shadow_launch (company_id,status,updated_at)
  WHERE status<>'closed';
