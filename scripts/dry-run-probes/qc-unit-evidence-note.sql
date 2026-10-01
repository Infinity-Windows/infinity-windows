-- Release-note verification only. The harness forces rollback of this batch.
do $$
declare v_count integer;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
    where id = '2026-10-01-qc-unit-evidence'
      and published_on = date '2026-10-01' and audience = array[1,2,3]
      and kind = 'improvement' and href = '/qc'
      and length(title_en) > 0 and length(title_es) > 0
      and length(body_en) > 0 and length(body_es) > 0 and withdrawn_at is null;
  perform pg_temp.dry_run_check('QC unit evidence: bilingual foreman-and-above release note',
    v_count = 1, format('expected 1, got %s', v_count));
end $$;
