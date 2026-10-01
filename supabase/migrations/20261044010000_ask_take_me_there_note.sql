-- A phone shows this note only after its client build includes the matching ID.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-30-ask-take-me-there','2026-09-30',array[0,1,2,3],'improvement',
   'Ask can take you to the right screen','Ask puede llevarte a la pantalla correcta',
   'When Ask identifies your exact job and unit, tap Open unit under its answer. Ask can also show Open my schedule. Opening a screen does not change your job clock or save a unit.',
   'Cuando Ask identifica el trabajo y la unidad exactos, toca Abrir unidad debajo de la respuesta. Ask también puede mostrar Abrir mi horario. Abrir una pantalla no cambia tu reloj de trabajo ni guarda una unidad.',
   '/ask')
on conflict (id) do nothing;
