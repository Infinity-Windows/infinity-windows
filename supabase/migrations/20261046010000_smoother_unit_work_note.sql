-- Shown only after the installed client includes this note ID.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  (
    '2026-10-01-smoother-unit-work', '2026-10-01', array[0,1,2,3], 'fix',
    'Unit work responds faster',
    'El trabajo de unidades responde más rápido',
    'Finishing a unit no longer waits for an extra account check before saving on your phone. Starting or adding a unit also stays available while optional type suggestions load.',
    'Al terminar una unidad, ya no espera una verificación adicional de la cuenta antes de guardarse en tu teléfono. También puedes iniciar o agregar una unidad mientras se cargan las sugerencias opcionales de tipo.',
    null
  )
on conflict (id) do nothing;
