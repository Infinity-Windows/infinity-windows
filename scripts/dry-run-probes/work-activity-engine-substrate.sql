-- Inactive private substrate on the installed schema, always forced rollback.
-- Existing QA identities only. No operational shift/session/profile writes.
-- Private helpers run as migration owner with the exact QA claim; the real
-- authenticated role is separately proved unable to execute them. This does
-- not claim public RPC, legacy cutover or paid setup source integration proof.
do $$
declare
  actor uuid; other_actor uuid; device uuid:=gen_random_uuid(); generation uuid:=gen_random_uuid();
  v_command_id uuid:=gen_random_uuid(); obs public.work_activity_observations;
  data jsonb; saved jsonb; replay jsonb; frame uuid; denied boolean;
  before_timing jsonb; after_timing jsonb; before_state public.personal_activity_state;
begin
  perform pg_temp.dry_run_as_system();
  actor:=pg_temp.dry_run_pick('installer'); other_actor:=pg_temp.dry_run_pick('foreman');
  perform pg_temp.dry_run_check('engine probe uses existing eligible QA identities',
    public.is_test_profile(actor) and public.is_test_profile(other_actor)
    and public._work_config_internal(actor) and public._work_config_internal(other_actor),'checked');
  select jsonb_build_object(
    'shifts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.time_shifts t where profile_id in(actor,other_actor)),
    'custom',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.custom_work_sessions t where profile_id in(actor,other_actor)),
    'unit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.unit_sessions t where profile_id in(actor,other_actor)),
    'task',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.task_sessions t where profile_id in(actor,other_actor)),
    'service',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.service_time_sessions t where profile_id in(actor,other_actor)),
    'clock',(select coalesce(jsonb_agg(to_jsonb(t) order by client_id),'[]') from public.time_clock_actions t where profile_id in(actor,other_actor))) into before_timing;
  perform pg_temp.dry_run_check('all six substrate tables private with RLS and revoked client privileges',
    (select count(*)=6 and bool_and(c.relrowsecurity)
      and bool_and(not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))
      and bool_and(not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE'))
      from pg_class c where c.oid in ('public.work_activity_observations'::regclass,'public.work_activity_streams'::regclass,
        'public.work_activity_transaction_context'::regclass,'public.work_activity_expected_mutations'::regclass,
        'public.work_setup_sessions'::regclass,'public.personal_activity_transition_sources'::regclass)),'checked');
  perform pg_temp.dry_run_check('retained engine identities have no operational parent cascades',
    not exists(select 1 from pg_constraint where contype='f'
      and conrelid in('public.work_activity_observations'::regclass,'public.work_activity_streams'::regclass,
        'public.work_setup_sessions'::regclass,'public.personal_activity_transition_sources'::regclass)
      and confrelid in('public.profiles'::regclass,'public.time_shifts'::regclass,'public.time_clock_actions'::regclass)),'checked');
  perform pg_temp.dry_run_act_as(actor);
  denied:=false;
  begin perform public._work_activity_observe(device); exception when insufficient_privilege then denied:=true; end;
  perform pg_temp.dry_run_check('real authenticated caller cannot execute private observe helper',denied,'checked');
  -- Preserve the real QA JWT claim while restoring only migration-owner role.
  execute 'reset role';
  obs:=public._work_activity_observe(device);
  select * into before_state from public.personal_activity_state where profile_id=actor;
  perform pg_temp.dry_run_check('installed observe records exact QA device revision and bounded server lease',
    obs.actor_id=actor and obs.device_id=device and obs.revision=before_state.revision
    and obs.expires_at>obs.issued_at and obs.expires_at<=obs.issued_at+interval '16 hours','checked');
  data:=jsonb_build_object('deviceId',device,'clientGeneration',generation,'clientSequence',0,
    'predecessorCommandId',null,'expectedRevision',obs.revision,'basis',jsonb_build_object('observationId',obs.id),
    'shiftRef',case when obs.shift_id is null then null else jsonb_build_object('kind','shift','id',obs.shift_id) end,
    'tappedAt','2026-10-04T00:00:00Z','clockCheckedAt',null,'clockSkewMs',null,
    'intent',jsonb_build_object('kind','establish_stream','previousGeneration',obs.current_generation,'previousHeadCommandId',obs.current_head_command_id));
  saved:=public._work_activity_establish_stream(v_command_id,data);
  replay:=public._work_activity_establish_stream(v_command_id,data);
  perform pg_temp.dry_run_check('installed stream establishment is a receipt-only exact replay with no personal revision',
    saved=replay and saved->>'status'='noop' and saved->>'beforeRevision'=obs.revision::text
    and saved->>'afterRevision'=obs.revision::text and saved->'transitionId'='null'::jsonb
    and (select count(*)=1 from public.personal_activity_commands where personal_activity_commands.command_id=v_command_id)
    and (select count(*)=1 from public.work_activity_streams where actor_id=actor and device_id=device and client_generation=generation),'checked');
  denied:=false;
  begin perform public._work_activity_establish_stream(v_command_id,data||jsonb_build_object('tappedAt','2026-10-04T00:01:00Z'));
  exception when check_violation then denied:=true; end;
  perform pg_temp.dry_run_check('changed receipt payload refused and original immutable receipt unchanged',
    denied and (select result=saved from public.personal_activity_commands where personal_activity_commands.command_id=v_command_id),'checked');
  denied:=false;
  begin update public.work_activity_observations set revision=revision+1 where id=obs.id;
  exception when check_violation then denied:=true; end;
  perform pg_temp.dry_run_check('server-issued observation refuses mutation',denied,'checked');
  frame:=public._work_activity_context_open('rollback_probe','stop',clock_timestamp());
  perform public._work_activity_context_close(frame);
  perform pg_temp.dry_run_check('installed actual backend frame closes without retained context or allowances',
    not exists(select 1 from public.work_activity_transaction_context where id=frame)
    and not exists(select 1 from public.work_activity_expected_mutations where frame_id=frame),'checked');
  perform pg_temp.dry_run_act_as(other_actor); execute 'reset role';
  denied:=false;
  begin perform public._work_activity_establish_stream(v_command_id,data); exception when check_violation then denied:=true; end;
  perform pg_temp.dry_run_check('different QA actor cannot obtain the private receipt',denied,'checked');
  perform pg_temp.dry_run_as_system();
  select jsonb_build_object(
    'shifts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.time_shifts t where profile_id in(actor,other_actor)),
    'custom',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.custom_work_sessions t where profile_id in(actor,other_actor)),
    'unit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.unit_sessions t where profile_id in(actor,other_actor)),
    'task',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.task_sessions t where profile_id in(actor,other_actor)),
    'service',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.service_time_sessions t where profile_id in(actor,other_actor)),
    'clock',(select coalesce(jsonb_agg(to_jsonb(t) order by client_id),'[]') from public.time_clock_actions t where profile_id in(actor,other_actor))) into after_timing;
  perform pg_temp.dry_run_check('QA payroll clock and all independent timed sources byte-identical after private probes',before_timing=after_timing,'checked');
end $$;
