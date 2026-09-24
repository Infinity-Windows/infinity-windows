-- A probe with a check that is wrong on purpose, so the harness test can see a
-- false check travel out through the forced error and fail the run.
do $$
declare v_job uuid;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_job('BLACK22');
  perform pg_temp.dry_run_check('a check that passes', true, null);
  perform pg_temp.dry_run_check('a check that is wrong on purpose', false, 'expected 3, got 2');
end $$;
