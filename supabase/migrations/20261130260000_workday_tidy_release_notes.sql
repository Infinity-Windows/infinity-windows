-- What the crew is told about the Workday tidy-up that followed the first day
-- on the new look (Ammon's list, 2026-11-22). One note for everyone, kept as
-- high level as the release's own notes: the buttons that moved are the thing a
-- person will go looking for. Announcement row only; no schema or access change.
insert into public.app_release_notes
 (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
 ('2026-11-22-workday-tidy',date '2026-11-22',array[0,1,2,3],'improvement',
  'A tidier Workday','Una jornada más ordenada',
  'Choosing a job on your Workday now takes you straight to clocking in. Daily log and Report a problem are under Capture, Supplies is in the menu, and the menu opens from More at the bottom. Receipts you add go to the office.',
  'Al elegir una obra en Mi jornada ahora pasas directo a marcar tu entrada. Registro diario y Reportar un problema están en Capturar, Suministros está en el menú, y el menú se abre con Más, abajo. Los recibos que agregas van a la oficina.',
  null)
on conflict(id) do nothing;
