insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-01-ask-saved-history','2026-10-01',array[0,1,2,3],'fix',
   'Saved setup stays complete','Los datos guardados siguen completos',
   'After a confirmed save, Ask keeps the completed setup checklist closed when you return to the conversation or ask another question. A changed draft still stays visible until it is saved.',
   'Después de confirmar que se guardaron los datos, Preguntar mantiene cerrada la lista al volver a la conversación o hacer otra pregunta. Un borrador modificado sigue visible hasta que se guarde.','/ask')
on conflict (id) do nothing;
