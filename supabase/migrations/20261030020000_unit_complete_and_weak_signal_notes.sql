-- Crew announcements for two fixes that are already live but shipped without
-- a note (docs/app-updates.md): Unit complete in one tap (#648, made durable
-- offline by #650) and the screen that says it could not load on weak signal
-- (#638). Everyone who works a unit or opens a screen sees these, so both name
-- all four audiences. Button names are quoted exactly as the phone prints them
-- (currentWork.*, lazyRoute.* in lib/i18n/catalog.ts), so a person can find
-- them. "Save and start" is still untranslated on the unit form
-- (UnitEditor.tsx), which is why the Spanish quotes it in English.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-unit-complete','2026-09-25',array[0,1,2,3],'fix',
 'Unit complete in one tap, and it stays complete','Unidad terminada en un toque, y se queda terminada',
 'While you work a unit, tap Unit complete ✓. It ends your visit and marks the whole install done in one step, and the list shows ✓ Install complete. Before, the Save and start button quietly reopened it. The tap is saved on your phone first, so losing signal or closing the app won''t undo it. If someone else created the unit, you see Finished my part ✓ instead: it ends your visit, and the unit''s creator or a foreman marks the install done.',
 'Mientras trabajas una unidad, toca Unidad terminada ✓. Termina tu visita y marca toda la instalación como hecha en un solo paso, y la lista muestra ✓ Instalación terminada. Antes, el botón Save and start la volvía a abrir sin avisar. El toque se guarda primero en tu teléfono, así que perder la señal o cerrar la app no lo deshace. Si otra persona creó la unidad, ves Terminé mi parte ✓: termina tu visita, y quien creó la unidad o un capataz marca la instalación como hecha.',
 null) on conflict(id) do nothing;
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-weak-signal-screen','2026-09-25',array[0,1,2,3],'fix',
 'A screen that can''t load on weak signal now says so','Una pantalla que no carga con poca señal ahora te avisa',
 'On one bar of signal, a screen that can''t finish loading no longer spins forever. After 20 seconds it says This didn''t load on this signal, with Try again and Go to Work buttons.',
 'Con una sola barra de señal, una pantalla que no termina de cargar ya no se queda girando para siempre. Después de 20 segundos dice Esto no se cargó con esta señal, con los botones Intentar de nuevo e Ir a Trabajo.',
 null) on conflict(id) do nothing;
