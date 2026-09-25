-- Crew announcement for staying signed in with no signal (#654) and the
-- device lock with no signal (#651), one note for the release that carries
-- both (docs/app-updates.md). Everyone opens Forge, so all four audiences.
--
-- The PIN sentences describe the lock as #651 ships it: it stays shut when it
-- cannot check, and the offline unlock belongs to the person who entered the
-- PIN with signal, for twelve hours, until anyone signs out. The last sentence
-- is the notice App.tsx shows when the auth server ends a sign-in
-- (signin.signedOut in lib/i18n/catalog.ts).
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-signed-in-offline','2026-09-25',array[0,1,2,3],'fix',
 'Stay signed in, and on your clock, with no signal','Sigue con tu sesión y tu reloj aunque no haya señal',
 'Opening Forge where there''s no signal no longer drops you at the sign-in screen: you stay signed in, your clock works, and what you save goes out by itself when you''re back in signal. If your phone has a PIN, Forge still asks for it. Once you''ve entered it correctly with signal, the same PIN opens Forge with no signal for the next 12 hours — only for you, and only until you sign out. If Forge can''t check your PIN, it stays locked. And if your sign-in is ended for you (for example, your login was removed), the sign-in screen now says so.',
 'Abrir Forge donde no hay señal ya no te deja en la pantalla de inicio de sesión: sigues con tu sesión abierta, tu reloj funciona, y lo que guardes se envía solo cuando vuelvas a tener señal. Si tu teléfono tiene un PIN, Forge todavía te lo pide. Después de ponerlo bien con señal, el mismo PIN abre Forge sin señal durante las siguientes 12 horas — solo para ti, y solo hasta que cierres sesión. Si Forge no puede revisar tu PIN, se queda bloqueado. Y si alguien cierra tu sesión (por ejemplo, si quitaron tu acceso), la pantalla de inicio de sesión ahora te lo dice.',
 null) on conflict(id) do nothing;
