-- Supervisor and owner announcement for K2.8 of the crew redesign (Release
-- 2, "the AI"): the Review AI drafts card on Scheduling, with the reason
-- Forge AI now gives for each draft row, and the publish sheet saying so
-- when a publish is refused. A supervisor-only control gets its own
-- announcement (docs/app-updates.md): the audience is ranks 2 and 3 alone —
-- installers and foremen never see the card and are not told about it.
-- No schema change here: the reason rides on schedule_events' existing
-- payload, and created_via (20260955010000) is the flag the card reads.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-24-ai-schedule-review','2026-09-24',array[2,3],'improvement',
 'Review what Forge AI drafted before you publish','Revisa lo que Forge AI propuso antes de publicar',
 'Scheduling now has a Review AI drafts card: every draft the AI wrote, with its reason for that person on that job that day. Keep or drop each one, then publish the way you always have — nothing reaches the crew until you publish. If a publish is refused, the sheet now says so instead of staying quiet.',
 'Programación tiene ahora una tarjeta Revisar borradores de la IA: cada borrador que escribió la IA, con su motivo para esa persona en esa obra ese día. Conserva o descarta cada uno y luego publica como siempre; nada llega al equipo hasta que publiques. Si una publicación es rechazada, ahora la hoja lo dice en vez de quedarse callada.',
 '/scheduling') on conflict(id) do nothing;
