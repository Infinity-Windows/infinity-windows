insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-04-work-data-exploration','2026-10-04',array[2,3],'improvement',
   'Explore recorded unit work in Data','Explora el trabajo registrado por unidad en Datos',
   'In the new design, Data can filter a job’s recorded units by category, subtype, material, floor and size, and open the original work details. Labor and area use the same eligible units. Missing facts stay unknown; General work stays separate.',
   'En el diseño nuevo, Datos permite filtrar las unidades registradas de una obra por categoría, subtipo, material, piso y tamaño, y abrir los detalles originales del trabajo. La mano de obra y el área usan las mismas unidades elegibles. Los datos faltantes siguen como desconocidos; el trabajo general se muestra por separado.',
   '/data')
on conflict(id) do nothing;
