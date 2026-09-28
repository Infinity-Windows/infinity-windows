-- Combined release-note probe. Run under the existing always-rolled-back harness.
-- Each constituent probe restores system role; no production business records are written.

-- PR #660: one crew note (docs/app-updates.md), in
-- supabase/migrations/20261030110000_queued_work_stays_yours_note.sql. Read it
-- as the system to prove it was stored exactly as written, then through row
-- security as the QA installer and the QA foreman: the same read the "What's
-- new" popup makes.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');

  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-queued-work-stays-yours'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-25' and withdrawn_at is null and href is null
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the note is stored as written', v_n = 1,
    format('expected 1 row for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-queued-work-stays-yours';
  perform pg_temp.dry_run_check('the QA installer reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-queued-work-stays-yours';
  perform pg_temp.dry_run_check('the QA foreman reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;


-- PR #654: the crew note for staying signed in with no signal (and the device
-- lock, #651) — docs/app-updates.md. Read it as the system to prove it was
-- stored exactly as written, then through row security as the QA installer and
-- the QA foreman: the same read the "What's new" popup makes.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');

  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-signed-in-offline'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-25' and withdrawn_at is null and href is null
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the note is stored as written', v_n = 1,
    format('expected 1 row for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-signed-in-offline';
  perform pg_temp.dry_run_check('the QA installer reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-signed-in-offline';
  perform pg_temp.dry_run_check('the QA foreman reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;


-- The legacy-clock recovery announcement (docs/app-updates.md). The harness
-- applies the new migration inside a transaction that it always rolls back.
-- Check the stored note and read visibility through installer and foreman RLS.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');

  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-28-legacy-clock-recovery'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-28' and withdrawn_at is null and href = '/stuck'
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the legacy-clock note is stored for all four roles', v_n = 1,
    format('expected 1 row, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-28-legacy-clock-recovery';
  perform pg_temp.dry_run_check('the QA installer reads the legacy-clock note', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-28-legacy-clock-recovery';
  perform pg_temp.dry_run_check('the QA foreman reads the legacy-clock note', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
