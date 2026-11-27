CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_workspace_lease (
  workspace_key text PRIMARY KEY,
  owner text NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  expires_at timestamptz NOT NULL,
  released boolean NOT NULL DEFAULT false
);
