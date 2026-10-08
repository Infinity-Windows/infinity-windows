-- Owner-selected saved-app icon; no business schema or access change.
insert into public.app_release_notes
 (id,published_on,audience,kind,title_en,title_es,body_en,body_es)
values ('2026-10-08-glass-shimmer-icon',date '2026-10-08',array[0,1,2,3],'improvement',
 'A new Glass Shimmer Home Screen icon','Nuevo ícono Glass Shimmer para la pantalla de inicio',
 'Newly saved Forge apps use the Glass Shimmer window icon and the short name Forge. Existing Home Screen icons may keep their previous appearance. Your work and app screens stay the same.',
 'Las nuevas instalaciones de Forge usan el ícono de ventana Glass Shimmer y el nombre corto Forge. Los íconos existentes pueden conservar su apariencia anterior. Tu trabajo y las pantallas de la app siguen igual.')
on conflict(id) do nothing;
