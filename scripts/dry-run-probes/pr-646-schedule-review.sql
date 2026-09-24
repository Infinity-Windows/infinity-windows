-- Probe for PR #646 (branch claude/r2-schedule-review): the supervisor and
-- owner announcement from 20261032000000_ai_schedule_review_note.sql, read
-- back as the system after the migration ran, then rolled back with it.
-- Nothing here acts as a person: there is no QA supervisor login
-- (docs/test-account.md), and acting as a real supervisor — even inside a
-- rollback — is what the practice-run rules forbid. The card's own writes
-- are the board's existing paths (delete, publish) with their own tests;
-- the reason the AI stores rides on schedule_events' existing jsonb payload,
-- and this probe reads that schema as it stands on the live database.
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/r2-schedule-review \
--        -f migrations="supabase/migrations/20261032000000_ai_schedule_review_note.sql" \
--        -f probe=scripts/dry-run-probes/pr-646-schedule-review.sql
do $$
declare
  v_note public.app_release_notes;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  select * into v_note from public.app_release_notes where id = '2026-09-24-ai-schedule-review';
  perform pg_temp.dry_run_check('the announcement row exists after the migration',
    v_note.id is not null, coalesce(v_note.id, 'missing'));
  perform pg_temp.dry_run_check('audience: supervisors and owners only (ranks 2 and 3)',
    v_note.audience = array[2, 3], coalesce(v_note.audience::text, 'null'));
  perform pg_temp.dry_run_check('it opens Scheduling',
    v_note.href = '/scheduling', coalesce(v_note.href, 'null'));
  perform pg_temp.dry_run_check('published 2026-09-24 as an improvement',
    v_note.published_on = date '2026-09-24' and v_note.kind = 'improvement',
    coalesce(v_note.published_on::text, 'null') || ' ' || coalesce(v_note.kind, 'null'));
  perform pg_temp.dry_run_check('title and body in both languages, translated',
    length(trim(v_note.title_en)) > 0 and length(trim(v_note.title_es)) > 0
    and length(trim(v_note.body_en)) > 0 and length(trim(v_note.body_es)) > 0
    and v_note.title_es <> v_note.title_en and v_note.body_es <> v_note.body_en, null);
  select count(*) into v_n from public.app_release_notes where id = '2026-09-24-ai-schedule-review';
  perform pg_temp.dry_run_check('exactly one row (on conflict do nothing holds)', v_n = 1, v_n || ' row(s)');
  -- What the card reads, on the live schema: the flag, and the payload the reason rides on.
  perform pg_temp.dry_run_check('schema: schedule_assignments.created_via is there for the card to read',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'schedule_assignments' and column_name = 'created_via'), null);
  perform pg_temp.dry_run_check('schema: schedule_events.payload is jsonb, where the AI''s reason rides',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'schedule_events' and column_name = 'payload' and data_type = 'jsonb'), null);
  perform pg_temp.dry_run_as_system();
end $$;
