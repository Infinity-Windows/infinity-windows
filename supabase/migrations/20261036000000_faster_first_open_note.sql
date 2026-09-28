-- Crew announcement for the first-screen loading work (docs/app-updates.md):
-- html5-qrcode (the camera scanner) and pdf.js's operator-list reader now
-- load only once they're actually used, instead of riding along with every
-- screen, and three rarely-opened job tabs (Dispatch, the estimate ladder,
-- the warehouse plan-packages panel) now load on demand the same way
-- MapsInteractive and Custom Data already did. All crew-visible (everyone
-- who opens the app benefits from a smaller first load), so all four
-- audiences. Deliberately does NOT say the scanner was broken before — it
-- wasn't; this is a loading-speed change, not a bug fix, so it's an
-- 'improvement' with no /scan link implying otherwise.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-28-faster-first-open','2026-09-28',array[0,1,2,3],'improvement',
 'Smaller first download','Descarga inicial más pequeña',
 'Forge now downloads less code before showing the first screen, especially helpful on a slow signal. The camera scanner and a few rarely used job tabs load their extra pieces when you open them.',
 'Forge ahora descarga menos código antes de mostrar la primera pantalla, lo que ayuda especialmente con señal débil. El escáner de cámara y algunas pestañas de trabajo poco usadas cargan sus partes adicionales cuando las abres.',
 null) on conflict(id) do nothing;
