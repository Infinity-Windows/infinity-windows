-- Crew announcement for the monthly core-value review (20261106000000).
-- Audience: everyone with a crew login (installer and above) — this is a
-- personal task every active crew member gets, not a manager-only change.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-03-monthly-values-review', '2026-10-03', array[0,1,2,3], 'feature',
   'A monthly values review', 'Una revisión mensual de valores',
   'Once a month you score a few people you worked beside on the eight Horizon values — one score each, 1 to 10, plus an optional comment. It takes about a minute per person. Your own name is visible to the owner on your review; the person you score never sees who scored them or what you wrote. Find it under Settings → My values.',
   'Una vez al mes calificas a algunas personas con las que trabajaste en los ocho valores de Horizon: una puntuación cada uno, de 1 a 10, más un comentario opcional. Toma alrededor de un minuto por persona. Tu nombre es visible para el dueño en tu revisión; la persona que calificas nunca ve quién la calificó ni lo que escribiste. Encuéntralo en Configuración → Mis valores.',
   '/values')
on conflict (id) do nothing;
