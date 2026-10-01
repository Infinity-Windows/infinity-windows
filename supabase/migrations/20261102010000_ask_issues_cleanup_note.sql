insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-01-ask-ai-issues','2026-10-01',array[0,1,2,3],'fix',
   'A cleaner Ask chat','Un chat más claro',
   'Setup checklists close after a confirmed save. Ask has cleaner controls. If AI cannot finish your request, review and forward that exchange to App Issues → AI using Report an AI issue.',
   'Las listas de datos se cierran después de confirmar que se guardaron. Preguntar tiene controles más claros. Si la IA no termina tu solicitud, revisa y envía ese intercambio a Problemas de la app → IA con Reportar un problema de IA.','/ask'),
  ('2026-10-01-learning-rounds','2026-10-01',array[0,1,2,3],'fix',
   'Better learning rounds','Mejores rondas de aprendizaje',
   'Learning rounds use different questions and keep the correct score when you start another round. Door procedure steps show consecutive numbers without changing the procedure.',
   'Las rondas de aprendizaje usan preguntas distintas y conservan el resultado correcto al empezar otra ronda. Los pasos de instalación de puertas muestran números consecutivos sin cambiar el procedimiento.','/learn'),
  ('2026-10-01-model-contrast','2026-10-01',array[0,1,2,3],'fix',
   'Clearer model colors','Colores más claros en el modelo',
   'Model walls, roofs and glass are easier to distinguish. Colored frames still show the same installation and QC statuses.',
   'Es más fácil distinguir paredes, techos y vidrio en el modelo. Los marcos de colores siguen mostrando los mismos estados de instalación y calidad.','/projects'),
  ('2026-10-01-schedule-date-inputs','2026-10-01',array[2,3],'fix',
   'Edit schedule dates safely','Edita las fechas sin errores',
   'Clearing an assignment date no longer crashes Scheduling. Enter valid Start and End dates before saving; your other draft details stay in place.',
   'Borrar una fecha de asignación ya no causa un error en Programación. Ingresa fechas válidas de inicio y fin antes de guardar; los demás detalles del borrador se conservan.','/scheduling')
on conflict (id) do nothing;
