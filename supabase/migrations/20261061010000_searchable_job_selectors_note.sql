insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-01-searchable-supply-jobs', '2026-10-01', array[0,1,2,3], 'fix',
   'Find supply jobs faster', 'Encuentra trabajos de suministros más rápido',
   'Supplies now has a searchable job dropdown in alphabetical order. Find a job by its code or name when requesting or taking supplies.',
   'Suministros ahora tiene una lista desplegable de trabajos con búsqueda y en orden alfabético. Busca por código o nombre al solicitar o tomar suministros.', '/supplies'),
  ('2026-10-01-searchable-costing-jobs', '2026-10-01', array[3], 'fix',
   'Search jobs in Job Costing', 'Busca trabajos en Costos del trabajo',
   'Job Costing now uses a searchable alphabetical job dropdown instead of a wall of job buttons. The comparison table still selects a job when tapped.',
   'Costos del trabajo ahora usa una lista desplegable de trabajos con búsqueda y en orden alfabético en lugar de muchos botones. La tabla comparativa sigue seleccionando un trabajo al tocarlo.', '/costing')
on conflict (id) do nothing;
