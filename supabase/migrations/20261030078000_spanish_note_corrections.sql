-- Two words the crew sees in Spanish changed in this release: the sync status
-- now reads "Todo sincronizado" (was the English "All synced") and Stuck writes
-- is "Envíos atascados" (was "Escrituras atascadas", which reads as property
-- deeds). The live note for #639 quoted the old words, so its Spanish is
-- corrected in place. Same id on purpose: a correction, not news, so nobody
-- sees the popup again (docs/app-updates.md). English is unchanged.
update public.app_release_notes
   set title_es = replace(title_es, 'All synced', 'Todo sincronizado'),
       body_es = replace(replace(body_es, 'All synced', 'Todo sincronizado'),
                         'Escrituras atascadas', 'Envíos atascados')
 where id = '2026-09-25-unit-photos-send';
