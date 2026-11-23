-- What the crew is told about the Jobs search and the fuller Upcoming work
-- list (Matt, 2026-11-22). One short note for everyone. Viewing as a real
-- person is an owner's tool and is not announced. Announcement row only; no
-- schema or access change.
insert into public.app_release_notes
 (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
 ('2026-11-23-job-search-upcoming',date '2026-11-23',array[0,1,2,3],'improvement',
  'Search your jobs','Busca tus obras',
  'The Jobs page has a search: type part of a job''s name, code or address to find it. Upcoming work on your Workday now also lists jobs you are scheduled on, even before anyone has planned the day.',
  'La página de Obras tiene un buscador: escribe parte del nombre, código o dirección de una obra para encontrarla. Próximos trabajos en Mi jornada ahora también muestra las obras en las que estás programado, aunque nadie haya planificado el día.',
  '/projects')
on conflict(id) do nothing;
