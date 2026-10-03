insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-03-crew-goal', '2026-10-03', array[0,1,2,3], 'improvement',
  'See your crew hour goal', 'Consulta la meta de horas del equipo',
  'Open a job or Work to see its approved crew hour goal, recorded hours, and running time. The available hours are not an estimate of work left.',
  'Abre un trabajo o Trabajo para ver la meta aprobada de horas del equipo, las horas registradas y el tiempo en curso. Las horas disponibles no estiman el trabajo pendiente.',
  '/projects'
) on conflict (id) do nothing;
