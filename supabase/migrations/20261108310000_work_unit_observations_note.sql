insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-03-unit-size-history','2026-10-03',array[0,1,2,3],'improvement',
   'Unit size edits keep their history','Los cambios de tamaño conservan su historial',
   'Size edits preserve earlier values. You can edit dimensions on your own units; changing another person’s dimensions requires a supervisor, owner, or foreman with that job’s permission. Estimates remain unverified.',
   'Los cambios de tamaño conservan los valores anteriores. Puedes editar las dimensiones de tus propias unidades; para cambiar las de otra persona se requiere un supervisor, propietario o capataz con permiso para esa obra. Las estimaciones siguen sin verificar.',
   '/work')
on conflict(id) do nothing;
