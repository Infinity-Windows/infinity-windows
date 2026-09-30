-- These notes appear only in a client build that allowlists their IDs. The
-- live voice pilot is deliberately omitted while its switches remain off.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-30-voice-descriptions','2026-09-30',array[0,1,2,3],'improvement',
   'Voice descriptions understand more job terms','Las descripciones de voz reconocen más términos de obra',
   'Voice descriptions now use English or Spanish hints and window-installation terms. Check the words before saving; your original recording still follows the normal path.',
   'Las descripciones de voz ahora usan pistas en inglés o español y términos de instalación de ventanas. Revisa las palabras antes de guardar; la grabación original sigue su proceso habitual.',
   '/ask'),
  ('2026-09-30-qc-photo-suggestions','2026-09-30',array[1,2,3],'improvement',
   'Get a second look at an after photo','Consulta una segunda opinión sobre la foto final',
   'On QC, ask for a short AI review of the saved after photo. It points out visible details and questions; you still decide Pass or Callback.',
   'En Control de calidad, pide una revisión breve de la foto final guardada. Señala detalles visibles y preguntas; tú sigues decidiendo Aprobado o Corrección.',
   '/qc'),
  ('2026-09-30-safety-picture-review','2026-09-30',array[1,2,3],'improvement',
   'Review safety pictures before sharing','Revisa las imágenes de seguridad antes de compartirlas',
   'On Safety, leads can revise an illustration prompt, make one new picture, and approve it for the crew. New pictures stay hidden until approved; your edited talk text is protected.',
   'En Seguridad, los responsables pueden revisar la descripción de una imagen, crear una nueva y aprobarla para el equipo. Las imágenes nuevas quedan ocultas hasta su aprobación; el texto editado de la charla se conserva.',
   '/safety')
on conflict (id) do nothing;
