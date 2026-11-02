ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_config
  ADD COLUMN delivery_limits jsonb NOT NULL DEFAULT '{}'::jsonb;
