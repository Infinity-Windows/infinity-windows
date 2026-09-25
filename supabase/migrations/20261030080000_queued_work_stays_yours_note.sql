-- Crew announcement (docs/app-updates.md) for the outbox owner binding: work
-- saved on a phone with no signal now goes out only under the name of the
-- person who saved it (Codex review of #654, finding 3). Anyone can hand a
-- phone to someone else, so all four audiences. The words the phone prints
-- are quoted exactly as lib/i18n/catalog.ts has them ("saved by someone
-- else" / "de otra persona" on the pill; Stuck writes / Escrituras
-- atascadas), so a person can find them.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-queued-work-stays-yours','2026-09-25',array[0,1,2,3],'fix',
 'Work saved on a shared phone goes out under the right name','Lo que guardas en un teléfono compartido se envía a tu nombre',
 'If you save work with no signal, like a clock-in or photos, and then someone else signs in on the same phone, your work now waits for you. It is never sent under their name. It stays on the phone and goes out when you sign in again. Until then, the bar at the top says saved by someone else, and Stuck writes lists it.',
 'Si guardas trabajo sin señal, como una entrada o fotos, y luego otra persona inicia sesión en el mismo teléfono, ahora tu trabajo te espera. Nunca se envía a nombre de otra persona. Se queda en el teléfono y se envía cuando vuelvas a iniciar sesión. Mientras tanto, la barra de arriba dice de otra persona, y Escrituras atascadas lo muestra.',
 null) on conflict(id) do nothing;
