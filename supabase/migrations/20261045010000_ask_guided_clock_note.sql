-- A phone shows this note only after its client build includes the matching ID.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-30-ask-guided-clock','2026-09-30',array[0,1,2,3],'improvement',
   'Ask opens the right job clock','Ask abre el reloj de la obra correcta',
   'When Ask says a unit needs a different job clock, tap its clock button. Review the selected job and confirm your clock change. Forge returns to Ask, where you can tap Start now. A queued offline clock change must sync first.',
   'Cuando Ask diga que una unidad necesita el reloj de otra obra, toca el botón del reloj. Revisa la obra seleccionada y confirma el cambio. Forge vuelve a Ask, donde puedes tocar Iniciar ahora. Si el cambio quedó pendiente sin conexión, primero debe sincronizarse.',
   '/ask')
on conflict (id) do nothing;
