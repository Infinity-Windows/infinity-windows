-- Crew announcement for #659 (docs/app-updates.md): the owner, dictating a
-- daily log in Ask on an iPhone (2026-09-24), lost the recording bar off the
-- bottom of the page, had the action cards he had put away open again every
-- time he used the microphone, and had to scroll up past them to find each
-- reply. All three are fixed in the same change as this note. Every role
-- uses Ask, so it names all four audiences.
-- Button and bar words are quoted exactly as the phone prints them
-- (field.cards.hide, field.cards.reopen, field.newMessage in
-- app/src/components/ask/fieldCatalog.ts), so a person can find them; the
-- tab bar says Ask in both languages (lib/nav.ts), so the Spanish does too.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-ask-latest-in-view','2026-09-25',array[0,1,2,3],'fix',
 'Ask keeps your recording and the newest reply in view','Ask mantiene a la vista tu grabación y la respuesta más nueva',
 'While you record in Ask, the recording bar with the square Stop button stays at the bottom of the screen as you scroll, so you can see it is recording and stop it from anywhere. Your message and the reply now scroll into view on their own, so you no longer scroll up to find the answer. If you scrolled up to read earlier messages, a New message button takes you to the newest one. Tap Hide actions to put the action cards away; they stay hidden when you record or send, until you tap Actions.',
 'Mientras grabas en Ask, la barra de grabación con el botón cuadrado de detener se queda abajo en la pantalla aunque te desplaces, así que siempre ves que está grabando y puedes detener la grabación desde cualquier parte. Tu mensaje y la respuesta ahora se desplazan solos a la vista, así que ya no tienes que subir para buscar la respuesta. Si subiste para leer mensajes anteriores, un botón Mensaje nuevo te lleva al más reciente. Toca Ocultar acciones para esconder las tarjetas de acciones; siguen ocultas cuando grabas o envías, hasta que tocas Acciones.',
 '/ask') on conflict(id) do nothing;
