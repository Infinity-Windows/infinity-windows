-- Only clients containing the phone layout repair include this announcement.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-job-phone-layout', '2026-10-01', array[0,1,2,3], 'fix',
  'Job details fit your phone', 'Los detalles del trabajo caben en tu teléfono',
  'The job overview stays centered as you scroll. Long details wrap within the cards, and job actions are easier to read on small screens.',
  'El resumen del trabajo permanece centrado al desplazarte. Los detalles largos se ajustan dentro de las tarjetas y las acciones del trabajo son más fáciles de leer en pantallas pequeñas.',
  '/projects'
)
on conflict (id) do nothing;
