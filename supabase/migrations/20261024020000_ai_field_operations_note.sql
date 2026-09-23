-- Crew announcements for Forge AI field work (docs/app-updates.md). Three
-- audiences: everyone who can use it, leads who can file crew records, and the
-- supervisors/owners who receive new-field-job notices.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-22-ai-field-work','2026-09-22',array[0,1,2,3],'improvement',
 'Set up jobs and units with Forge AI','Configura trabajos y unidades con Forge AI',
 'In Ask, type or record what you are working on. Forge AI finds the job and unit, shows the questions still unanswered, and can start your unit timer on your current job clock. Anything that changes a saved unit, ends a break or joins someone else''s unit waits for you to tap a choice. Clock in, breaks and clock out stay on the job clock.',
 'En Preguntar, escribe o graba en qué estás trabajando. Forge AI encuentra el trabajo y la unidad, muestra las preguntas pendientes y puede iniciar el temporizador de tu unidad con tu reloj de trabajo actual. Todo lo que cambie una unidad guardada, termine un descanso o te una a la unidad de otra persona espera a que toques una opción. Entrada, descansos y salida siguen en el reloj de trabajo.',
 '/ask') on conflict(id) do nothing;
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-22-ai-crew-records','2026-09-22',array[1,2,3],'improvement',
 'Record crew work by asking Forge AI','Registra el trabajo del equipo preguntando a Forge AI',
 'Tell Forge AI who worked on a unit and when, and it files the same crew record as Current Work. You can now choose people marked Off today. Crew records never add payroll hours or approve QC.',
 'Dile a Forge AI quién trabajó en una unidad y cuándo, y registrará el mismo registro del equipo que en Trabajo actual. Ahora puedes elegir a personas marcadas como Libre hoy. Los registros del equipo nunca agregan horas de nómina ni aprueban calidad.',
 '/ask') on conflict(id) do nothing;
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-22-field-job-notices','2026-09-22',array[2,3],'improvement',
 'New jobs created in the field','Trabajos nuevos creados en campo',
 'When a crew member creates a job through Forge AI, you are mentioned in that job''s chat with its name and location. The job is usable right away and starts as Not ready; add the customer, schedule and supervisor from the job page.',
 'Cuando alguien del equipo crea un trabajo con Forge AI, se te menciona en el chat de ese trabajo con su nombre y ubicación. El trabajo se puede usar de inmediato y empieza como No listo; agrega el cliente, el horario y el supervisor desde la página del trabajo.',
 '/projects') on conflict(id) do nothing;
