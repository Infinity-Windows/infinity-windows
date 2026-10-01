-- Shown only after a client containing the draft flow is installed.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-daily-log-drafts', '2026-10-01', array[0,1,2,3], 'improvement',
  'Continue a daily log draft', 'Continúa un borrador del registro diario',
  'If you close a daily log before sending it, reopen the same job and day to resume or discard the draft saved on your phone. Forge also asks you to review changes if someone else updated the shared log.',
  'Si cierras un registro diario antes de enviarlo, vuelve a abrir el mismo trabajo y día para continuar o descartar el borrador guardado en tu teléfono. Forge también te pide revisar los cambios si otra persona actualizó el registro compartido.',
  null
)
on conflict (id) do nothing;
