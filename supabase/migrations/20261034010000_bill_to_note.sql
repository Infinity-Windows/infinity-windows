-- Supervisor and owner announcement for the per-job bill-to
-- (20261034000000, docs/app-updates.md), in the same change as the feature.
-- Audiences [2,3] only: supervisors and the owner are the people who set it,
-- and who a job bills to is money that installers and foremen do not see. The
-- menu names the page "Cost codes" in both languages, so the Spanish quotes it
-- in English; "Bill To" and "Bill To QuickBooks ID" are the export's exact
-- column headers, kept in English for the same reason.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-27-bill-to','2026-09-27',array[2,3],'improvement',
 'Each job now says who it bills to','Cada trabajo ahora dice a quién se le cobra',
 'Every job starts billed to STG Windows and Doors. Change it on the job''s GC card. The customer list, with each QuickBooks ID, is on the Cost codes page. The Job timecards export now ends with Bill To and Bill To QuickBooks ID.',
 'Todos los trabajos empiezan cobrándose a STG Windows and Doors. Cámbialo en la tarjeta del GC del trabajo. La lista de clientes, con el ID de QuickBooks de cada uno, está en la página "Cost codes". La exportación de horas por trabajo ahora termina con Bill To y Bill To QuickBooks ID.',
 '/cost-codes') on conflict(id) do nothing;
