ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_config
  ADD COLUMN default_mode text NOT NULL DEFAULT 'manual'
  CHECK (default_mode IN ('manual', 'assisted', 'autonomous'));
