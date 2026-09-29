-- Crew-facing changes in the September 29 phone Work release. The map note
-- describes the lower-memory loading behavior, not an unverified diagnosis
-- of a particular person's clock-in record.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-29-phone-work-unit-plan','2026-09-29',array[0,1,2,3],'improvement',
   'Add a unit from Work','Agregar una unidad desde Trabajo',
   'You can add a unit from Work even when another unit is suggested. Save its number and type, or save and start working on it. The bottom bar now follows the visible phone screen, and large plan sheets open with less work up front.',
   'Puedes agregar una unidad desde Trabajo aunque se sugiera otra. Guarda su número y tipo, o guárdala y comienza a trabajar. La barra inferior ahora sigue la pantalla visible del teléfono, y los planos grandes se abren con menos carga inicial.',
   '/')
on conflict (id) do nothing;
