-- Visible only on builds that include the supervisor/owner Jobs overview.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-jobs-overview', '2026-10-01', array[2,3], 'improvement',
  'Job overview is now in Jobs', 'El panorama de trabajos ahora está en Trabajos',
  'Open Jobs to see concerns needing attention, planned crews and recorded progress. Missing information is marked clearly. The separate Heartbeat screen has been removed; old links open Jobs. Use Job list for the existing job cards and ordering tools.',
  'Abre Trabajos para ver los asuntos que necesitan atención, las cuadrillas programadas y el avance registrado. La información faltante se indica claramente. Se eliminó la pantalla Heartbeat; los enlaces anteriores abren Trabajos. Usa Lista de trabajos para ver las tarjetas y herramientas de orden anteriores.',
  '/projects'
)
on conflict (id) do nothing;
