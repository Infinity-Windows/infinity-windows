-- Crew announcements for Release 0, "trust the clock" (docs/app-updates.md).
-- Two audiences: everyone who punches a clock, and the foremen and up who read
-- the new "time needs review" mark on a timecard.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-clock-counts-once','2026-09-23',array[0,1,2,3],'fix',
 'Clock taps count once, even on bad signal','Los toques del reloj cuentan una sola vez, aun con mala señal',
 'When your phone has no signal, your clock-in, breaks and clock-out are saved on the phone and sent when signal returns. Sending one twice can no longer double a punch or move your time, and your hours use the time you tapped, not the time the signal came back. If the app can''t find the start of a break you''re ending, it tells you and your foreman checks it.',
 'Cuando tu teléfono no tiene señal, tu entrada, tus descansos y tu salida se guardan en el teléfono y se envían cuando vuelve la señal. Enviar uno dos veces ya no puede duplicar una marcación ni mover tu hora, y tus horas usan la hora en que tocaste, no la hora en que volvió la señal. Si la app no encuentra el inicio de un descanso que estás terminando, te lo dice y tu capataz lo revisa.',
 '/clock') on conflict(id) do nothing;
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-time-needs-review','2026-09-23',array[1,2,3],'improvement',
 'Punches that need a look','Marcaciones que requieren revisión',
 'A punch now shows "time needs review" when the phone''s tap time could not be trusted — its clock was off or had not been checked in a day — or when a break end had no matching start. In those cases the hours use the time the punch reached Forge. The reason is written under the punch and in its edit history.',
 'Una marcación ahora muestra "tiempo por revisar" cuando no se pudo confiar en la hora del toque del teléfono — su reloj estaba mal o no se había verificado en un día — o cuando un fin de descanso no tenía un inicio correspondiente. En esos casos las horas usan la hora en que la marcación llegó a Forge. El motivo queda escrito debajo de la marcación y en su historial de cambios.',
 '/team-timecards') on conflict(id) do nothing;
