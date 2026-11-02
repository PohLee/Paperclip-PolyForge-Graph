CREATE TABLE plugin_polyforge_graph_ff7d84e8bb.graph_dispatch_slot (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  delivery_key text NOT NULL,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 5),
  attempt_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, delivery_key, slot),
  UNIQUE (company_id, delivery_key, attempt_key)
);
