CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_channel_intake (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel text NOT NULL,
  source_key text NOT NULL,
  fingerprint text NOT NULL,
  intake_id text,
  issue_id text,
  status text NOT NULL DEFAULT 'claimed',
  reply_to_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, source_key),
  UNIQUE (channel, source_key)
);
