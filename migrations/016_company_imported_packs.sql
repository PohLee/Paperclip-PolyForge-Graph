ALTER TABLE plugin_polyforge_graph_ff7d84e8bb.graph_imported_packs
  DROP CONSTRAINT graph_imported_packs_pkey,
  DROP CONSTRAINT graph_imported_packs_company_id_fkey,
  ADD PRIMARY KEY (company_id, pack_id, version),
  ADD FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
