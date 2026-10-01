insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-semimonthly-pay-periods', '2026-10-01', array[0,1,2,3], 'fix',
  'Correct pay period dates', 'Fechas correctas de los períodos de pago',
  'Timecards now use the 1st–15th and the 16th–last day of each month. Pay period arrows, reports and payroll exports follow those dates. Weekly approvals and overtime still follow calendar weeks.',
  'Las tarjetas de tiempo ahora usan del 1 al 15 y del 16 al último día de cada mes. Las flechas, los informes y las exportaciones de nómina siguen esas fechas. Las aprobaciones y las horas extra siguen las semanas del calendario.',
  '/timecard'
)
on conflict (id) do nothing;
