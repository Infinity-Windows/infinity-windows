-- Crew announcement for offline toolbox signing (docs/app-updates.md;
-- 20261033000000). Everyone who clocks in signs today's talk, so all four
-- audiences. Only what ships in the same change: signing with no signal, the
-- clock-in and unit work opening right after, the talks kept ahead, and where
-- a refused signature shows. The roster's group sign-in still needs signal —
-- that is a supervisor-only screen, so it is not in a note every installer
-- reads (the screen says it itself). The quoted words are the phone's own:
-- toolbox.status.pending / toolbox.status.sent, and the Stuck writes title
-- (stuck.title) in lib/i18n/catalog.ts.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-offline-toolbox-signing','2026-09-25',array[0,1,2,3],'improvement',
 'Sign today''s toolbox talk with no signal','Firma la charla de seguridad de hoy sin señal',
 'You can now sign today''s toolbox talk with no signal. Your phone keeps the signature and sends it as soon as it has signal; until then the talk says Signed — waiting to send, and then Signed ✓. You can clock in and start unit work right after signing: your clock-in waits on the phone and goes in right after the signature. Whenever it has signal, your phone also saves today''s talk and the next three days'' talks, so you can sign in the morning even if your last signal was the day before. If Forge doesn''t accept a signature, it shows on Stuck writes with the reason, and your clock-in waits for it there.',
 'Ahora puedes firmar la charla de seguridad de hoy sin señal. Tu teléfono guarda la firma y la envía en cuanto tiene señal; mientras tanto la charla dice Firmado — esperando enviar, y después Firmado ✓. Puedes marcar entrada y empezar el trabajo de una unidad justo después de firmar: tu entrada espera en el teléfono y se envía justo después de la firma. Cada vez que tiene señal, tu teléfono también guarda la charla de hoy y las de los próximos tres días, así que puedes firmar en la mañana aunque tu última señal haya sido el día anterior. Si Forge no acepta una firma, aparece en Escrituras atascadas con el motivo, y tu entrada la espera ahí.',
 '/safety') on conflict(id) do nothing;
