-- A phone shows this note only after its client build includes the matching ID.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-30-ask-timing-readiness','2026-09-30',array[0,1,2,3],'improvement',
   'Ask shows when Start now must wait','Ask muestra cuándo Empezar ahora debe esperar',
   'If your phone still has a clock or unit-timer change to send, Ask shows Waiting to sync and pauses Start now. It checks again when the phone syncs. You still choose when to start the unit.',
   'Si tu teléfono todavía tiene un cambio de reloj o temporizador de unidad por enviar, Ask muestra Esperando sincronización y pausa Empezar ahora. Vuelve a revisar cuando el teléfono se sincroniza. Tú sigues eligiendo cuándo empezar la unidad.',
   '/ask')
on conflict (id) do nothing;
