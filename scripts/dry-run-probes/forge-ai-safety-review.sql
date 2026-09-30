-- Rolled-back check for the safety-talk illustration UPDATE policy.
-- The talk is synthetic and exists only inside the dry-run transaction.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_talk uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  insert into public.safety_talks(title, body, talk_date, visual_aids_json)
    values ('Dry-run picture review', 'Synthetic test record', date '2099-01-01',
      '[{"prompt":"test","approved":false}]'::jsonb)
    returning id into v_talk;

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
    where id in ('2026-09-30-voice-descriptions','2026-09-30-qc-photo-suggestions','2026-09-30-safety-picture-review');
  perform pg_temp.dry_run_check('installer sees only the voice note', v_n = 1,
    format('expected 1 visible release note, got %s', v_n));
  update public.safety_talks
    set visual_aids_json = '[{"prompt":"test","approved":true}]'::jsonb
    where id = v_talk;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('installer cannot approve a talk picture', v_n = 0,
    format('expected 0 updated rows, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
    where id in ('2026-09-30-voice-descriptions','2026-09-30-qc-photo-suggestions','2026-09-30-safety-picture-review');
  perform pg_temp.dry_run_check('foreman sees all three field notes', v_n = 3,
    format('expected 3 visible release notes, got %s', v_n));
  update public.safety_talks
    set visual_aids_json = '[{"prompt":"test","approved":true}]'::jsonb
    where id = v_talk;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('foreman can approve a talk picture', v_n = 1,
    format('expected 1 updated row, got %s', v_n));
  perform pg_temp.dry_run_as_system();
end $$;
