-- Display after this client supports the reviewed action and live reports.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-01-ask-operations', '2026-10-01', array[1,2,3], 'improvement',
   'Ask can handle more field and crew requests',
   'Ask puede atender más solicitudes del equipo',
   'Foremen and leaders can ask who is clocked in, request a filed daily report or an hours-by-job export with named exclusions, and review unused mapped units before removing them. Forge checks permissions and preserves unit history.',
   'Los capataces y líderes pueden preguntar quién está trabajando, solicitar un informe diario o exportar horas por trabajo excluyendo personas nombradas, y revisar unidades sin uso antes de quitarlas. Forge verifica permisos y conserva el historial.',
   null)
on conflict (id) do nothing;
