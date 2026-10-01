-- Shown only after a client containing the Jobs page search/recommendation flow is installed.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-jobs-search', '2026-10-01', array[0,1,2,3], 'improvement',
  'Search and your next job on the Jobs page', 'Busca y mira tu próximo trabajo en la página de Trabajos',
  'The Jobs page now has a search bar up top, a highlight for the next job on your own schedule, and All/Scheduled/Recent filters so you scroll less to find a job.',
  'La página de Trabajos ahora tiene una barra de búsqueda arriba, un aviso con tu próximo trabajo según tu horario, y filtros de Todos/Programados/Recientes para desplazarte menos al buscar un trabajo.',
  '/projects'
)
on conflict (id) do nothing;
