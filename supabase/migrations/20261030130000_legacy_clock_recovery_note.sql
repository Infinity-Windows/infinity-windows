-- A legacy clock punch may have been saved before the phone recorded its
-- owner. The app now keeps that punch on the phone and gives the crew its
-- factual recovery record for a foreman to reconcile manually. All four
-- internal roles can encounter or help resolve one on a shared phone.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-28-legacy-clock-recovery','2026-09-28',array[0,1,2,3],'fix',
 'Review clock punches saved before an update','Revisa marcas de reloj guardadas antes de una actualización',
 'If a clock punch was saved before Forge recorded who made it, Stuck writes now shows its original time and lets you save a recovery record. The punch stays on this phone; it is not sent or deleted. Give the record to a foreman to verify the person and existing timecard before any manual correction.',
 'Si una marca de entrada, salida o descanso se guardó antes de que Forge anotara quién la hizo, Escrituras atascadas muestra la hora original y permite guardar un registro de recuperación. La marca permanece en este teléfono; no se envía ni se borra. Entrega el registro a un capataz para que verifique a la persona y el registro de horas existente antes de cualquier corrección manual.',
 '/stuck') on conflict(id) do nothing;
