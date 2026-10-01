-- The client allowlist keeps each role-scoped note hidden on older builds.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  (
    '2026-09-30-monday-plan-files', '2026-09-30', array[1,2,3], 'fix',
    'Get plans from Monday again',
    'Vuelve a traer planos de Monday',
    'The Get button on a job’s Plans page can bring Monday files onto the job again. If a file could not be brought in, open the job and try Get again.',
    'El botón Traer en la página de planos del trabajo vuelve a permitir importar archivos de Monday. Si un archivo no se pudo importar, abre el trabajo y vuelve a tocar Traer.',
    '/projects'
  ),
  (
    '2026-09-30-schedule-time-conflicts', '2026-09-30', array[2,3], 'fix',
    'Double-booking warnings check the hours',
    'Los avisos de doble reserva revisan las horas',
    'Scheduling now warns when the same person’s work times overlap, rather than just sharing a date. One job can end when another starts. Add both start and end times to check separate shifts; missing times still warn.',
    'La programación ahora avisa cuando los horarios de la misma persona se superponen, no solo por compartir una fecha. Un trabajo puede terminar cuando otro empieza. Agrega la hora de inicio y de fin para comprobar turnos separados; sin horas completas, el aviso permanece.',
    '/scheduling'
  )
on conflict (id) do nothing;
