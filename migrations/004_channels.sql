CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_channel_config (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_notification_delivery (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notification_id text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  receipt jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, notification_id, channel)
);
