-- Crew announcement for the toolbox talk signing fix (docs/app-updates.md),
-- in the same change as the fix. A crew member reported on 2026-09-06 that
-- signing failed with "Couldn't save: WinAnsi cannot encode ...". The signed
-- record's font had no check mark for the talk's Do list, so every talk with
-- Do and Don't lists (all the generated ones) could not be signed, and without
-- today's signature nobody can clock in. Everyone signs the talk, so all four
-- audiences. The body says "an error" because the two places to sign word it
-- differently (the Safety page prefixes "Couldn't save:", the clock-in card
-- does not). The talk card prints its Do and Don't headings in English in both
-- languages (components/safety/TalkContent.tsx), which is why the Spanish
-- quotes them in English; "charla de seguridad" and "marcar entrada" are the
-- catalog's own words.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-toolbox-signing','2026-09-25',array[0,1,2,3],'fix',
 'Signing a toolbox talk no longer fails on days whose talk has Do and Don''t lists','Firmar la charla de seguridad ya no falla los días en que la charla trae listas Do y Don''t',
 'On those days signing stopped with an error, so you could not clock in. Those talks now sign like any other.',
 'Esos días, al firmar salía un error y no podías marcar entrada. Ahora esas charlas se firman como cualquier otra.',
 '/safety') on conflict(id) do nothing;
