-- Crew announcement for the monthly core-value review (20261106000000).
-- Audience: everyone with a crew login (installer and above) — this is a
-- personal task every active crew member gets, not a manager-only change.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-03-monthly-values-review', '2026-10-03', array[0,1,2,3], 'improvement',
   'A monthly values review', 'Una revisión mensual de valores',
   'When monthly reviews are enabled, your assigned reviews appear under Settings → My values. Score all eight core values from 1 to 10, with an optional comment. Your name and answers are visible to the owner; the person you score sees only qualifying combined scores, without reviewer names or comments. Scheduling starts off until the owner enables it.',
   'Cuando se habilitan las revisiones mensuales, tus revisiones asignadas aparecen en Configuración → Mis valores. Califica los ocho valores del 1 al 10, con un comentario opcional. El dueño puede ver tu nombre y respuestas; la persona que calificas solo ve puntuaciones combinadas que cumplen los requisitos, sin nombres de evaluadores ni comentarios. La programación comienza desactivada hasta que el dueño la active.',
   '/values')
on conflict (id) do nothing;
