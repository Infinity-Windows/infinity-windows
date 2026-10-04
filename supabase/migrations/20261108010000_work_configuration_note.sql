-- Owner/supervisor progress notice. Configuration screens remain forthcoming;
-- the dormant client and versioned API do not activate capture or timing.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-03-work-configuration-preparation','2026-10-03',array[2,3],'improvement',
   'Work configuration is in preparation','La configuración de Trabajo está en preparación',
   'The next Work configuration screens will let supervisors draft activity and menu changes and owners publish versioned choices. Foreman management permissions will apply to specific jobs. These screens are still being built.',
   'Las próximas pantallas de configuración de Trabajo permitirán a los supervisores preparar cambios de actividades y menús, y a los propietarios publicar opciones con un historial de versiones. Los permisos de gestión de los capataces se aplicarán a obras específicas. Estas pantallas siguen en desarrollo.',
   '/settings')
on conflict(id) do nothing;
