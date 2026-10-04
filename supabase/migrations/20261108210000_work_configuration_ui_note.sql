begin;
insert into public.app_release_notes(id,published_on,kind,title_en,title_es,body_en,body_es,href,audience)
values ('2026-10-03-work-configuration-controls','2026-10-03','improvement',
  'Work menus and job permissions', 'Menús de trabajo y permisos de obra',
  'Owners and supervisors can propose company activities and menus in Settings. Owners publish versions. The job overview lets authorized people choose a published menu and lets owners and supervisors grant specific foreman permissions for that job.',
  'Dueños y supervisores pueden proponer actividades y menús de empresa en Ajustes. Los dueños publican versiones. En el resumen de obra, las personas autorizadas pueden elegir un menú publicado y los dueños y supervisores pueden dar permisos específicos a capataces para esa obra.',
  '/projects', array[1,2,3])
on conflict(id) do nothing;
commit;
