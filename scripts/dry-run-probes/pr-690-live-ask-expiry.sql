-- Apply the new expiry migration on the real database, verify its due-only
-- cron job and private ledger, and roll every change back with the harness.
-- No provider session is created and no external request is sent in this run.
do $$
declare
  v_count integer;
  v_installer uuid;
  v_role text;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from cron.job
    where jobname = 'live-ask-expiry'
      and schedule = '* * * * *'
      and command like '%functions/v1/live-ask-expiry%';
  perform pg_temp.dry_run_check('expiry cron: one due-only minute job', v_count = 1, v_count || ' job(s)');

  perform pg_temp.dry_run_check('expiry ledger: RLS is enabled',
    (select relrowsecurity from pg_class where oid = 'public.live_ask_provider_sessions'::regclass), null);
  perform pg_temp.dry_run_check('expiry ledger: only the service role has table access',
    has_table_privilege('service_role', 'public.live_ask_provider_sessions', 'insert')
    and has_table_privilege('service_role', 'public.live_ask_provider_sessions', 'select')
    and not has_table_privilege('authenticated', 'public.live_ask_provider_sessions', 'select')
    and not has_table_privilege('anon', 'public.live_ask_provider_sessions', 'select'), null);

  insert into public.live_ask_provider_sessions(id, expires_at)
    values ('live_dry_run_probe', now() - interval '1 minute');
  select count(*) into v_count from public.live_ask_provider_sessions
    where id = 'live_dry_run_probe' and closed_at is null and expires_at <= now();
  perform pg_temp.dry_run_check('expiry ledger: a due session is selectable by the system', v_count = 1, v_count || ' row(s)');

  v_installer := pg_temp.dry_run_pick('installer');
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('expiry ledger: acting as the QA installer', v_role = 'installer', v_role);
  perform pg_temp.dry_run_expect_error('expiry ledger: installer cannot create a provider session',
    $q$insert into public.live_ask_provider_sessions(id, expires_at) values ('live_not_allowed', now())$q$);
  perform pg_temp.dry_run_as_system();
end $$;
