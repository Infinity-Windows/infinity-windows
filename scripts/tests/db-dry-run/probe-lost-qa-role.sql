-- The incident of 2026-09-23/24, replayed end to end: qa.installer's role had
-- been set to foreman, and a probe picked its installer the usual way. The
-- run must stop right there, in words that name the login to fix, and the
-- verdict must say the change was not tried — rather than act as the real
-- installer, who is refused on a testing job with a sentence that reads like
-- the change is broken. The role change is part of the batch, so the forced
-- error rolls it back too.
do $$
declare v_installer uuid;
begin
  perform pg_temp.dry_run_as_system();
  update public.profiles set role = 'foreman' where id = '00000000-0000-4000-8000-000000000001';
  v_installer := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_check('never reached: the pick above stops the run', false, v_installer::text);
end $$;
