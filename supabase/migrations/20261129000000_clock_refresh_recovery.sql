-- Failed refreshes must not present an old saved shift as current.
insert into public.app_release_notes
 (id,published_on,audience,kind,title_en,title_es,body_en,body_es)
values ('2026-10-20-clock-refresh-recovery',date '2026-10-20',array[0,1,2,3],'fix',
 'A clearer clock when signal drops','Un reloj más claro cuando falla la conexión',
 'Forge now asks you to check your clock when it cannot confirm an old saved shift. Tap Check again to load your current shift. Recent offline shifts are labeled Saved clock, and saved punches stay on your phone.',
 'Ahora Forge te pide verificar el reloj cuando no puede confirmar un turno antiguo guardado. Toca Verificar de nuevo para cargar tu turno actual. Los turnos recientes sin conexión indican Reloj guardado, y tus marcajes se conservan en el teléfono.')
on conflict(id) do nothing;
