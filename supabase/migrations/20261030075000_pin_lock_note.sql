-- Crew announcement for the device lock with no signal (#651, live), split out
-- of #654's combined note so the lock change is announced now; #654's note
-- keeps only staying signed in (docs/app-updates.md). Everyone may have a PIN
-- on their phone, so all four audiences. The numbers are offlinePin.ts's own
-- (OFFLINE_PIN_TTL_MS = 12 h, OFFLINE_PIN_MAX_TRIES = 5), and the quoted words
-- are pin.notChecked / pin.tryAgain in lib/i18n/catalog.ts.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-pin-lock','2026-09-25',array[0,1,2,3],'fix',
 'Your PIN lock with no signal','Tu bloqueo con PIN sin señal',
 'If your phone has a PIN, Forge asks for it even with no signal, and never opens without it. Once you''ve entered it correctly with signal, the same PIN opens Forge with no signal for the next 12 hours, only for you and only until you sign out. Five wrong tries and it needs signal again. If Forge can''t check your PIN, it stays locked and says Forge couldn''t check your PIN. Try again. Signing out, or someone else signing in, always locks it again.',
 'Si tu teléfono tiene un PIN, Forge te lo pide aunque no haya señal, y nunca se abre sin él. Después de ponerlo bien con señal, el mismo PIN abre Forge sin señal durante las siguientes 12 horas, solo para ti y solo hasta que cierres sesión. Con cinco intentos equivocados necesita señal otra vez. Si Forge no puede revisar tu PIN, se queda bloqueado y dice Forge no pudo revisar tu PIN. Inténtalo de nuevo. Cerrar sesión, o que otra persona inicie sesión, siempre lo vuelve a bloquear.',
 null) on conflict(id) do nothing;
