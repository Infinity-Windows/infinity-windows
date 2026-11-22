-- What the crew is told about the Workday release (Matt, 2026-11-22: "there are
-- many changes, so just keep it incredibly high level and simple").
--
-- Two notes, because the two groups got different things: everyone gets the
-- new look and the Workday; foremen and above also get the Plan and the
-- activity review. Announcement rows only; no schema or access change.
insert into public.app_release_notes
 (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
 ('2026-11-22-new-look-workday',date '2026-11-22',array[0,1,2,3],'improvement',
  'A new look and a simpler workday','Una nueva apariencia y una jornada más simple',
  'Forge has a new look. Your day now runs from one Workday screen: choose your job, start a unit or an activity, take your break and clock out. It always shows whether you are on the clock. You can switch back to the original look in Settings.',
  'Forge tiene una nueva apariencia. Tu día ahora se maneja desde una sola pantalla, Mi jornada: elige tu obra, inicia una unidad o una actividad, toma tu descanso y marca tu salida. Siempre muestra si estás en turno. Puedes volver a la apariencia original en Ajustes.',
  null),
 ('2026-11-22-plan-and-activities',date '2026-11-22',array[1,2,3],'improvement',
  'Plan the job and review the day','Planifica la obra y revisa el día',
  'Each job has a Plan where you lay out units and activities by day and by person, and the crew sees it on their Workday. Recent activities shows what was recorded, and lets you correct an activity or add one that was missed.',
  'Cada obra tiene un Plan donde organizas las unidades y actividades por día y por persona, y la cuadrilla lo ve en su jornada. Actividades recientes muestra lo registrado y te permite corregir una actividad o agregar una que faltó.',
  '/activities')
on conflict(id) do nothing;
