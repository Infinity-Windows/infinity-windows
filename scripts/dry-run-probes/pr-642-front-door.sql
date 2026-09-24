-- Probe for PR #642 (branch claude/r1-front-door): Release 1, "the new front
-- door" — 20261031000000_new_front_door.sql tried on the real database as
-- the people who will use it, on BLACK22, and rolled back. In order:
--   * the two new company_settings columns and profiles.ui_design exist with
--     the defaults the migration promises: master switch ON (people may opt
--     in; every person starts on classic), paid-time date OFF (null);
--   * set_my_ui_design moves ONLY the caller's own row, trims and lower-cases,
--     refuses junk; the column cannot be written straight, for oneself or
--     for anyone else;
--   * set_new_design_switch and set_paid_time_rule_date refuse an installer,
--     a foreman and a supervisor; the owner flips them, an unknown release
--     and a date in the past are refused, and a person's choice survives the
--     master switch going off and on;
--   * every clock_in overload the migration re-issues (all five) is refused
--     with the plain sentence when the gate is closed (no signature today,
--     no date), clocks the installer in on BLACK22 when it is open, and —
--     with the date unset — records exactly today's times (arrival = now());
--   * with the owner's date set to today the same five overloads clock the
--     installer in UNSIGNED, still at arrival (the rule changes when a shift
--     may begin, never the time it records); a date still ahead, and the
--     date cleared, put today's timing back; no shift already on the record
--     is touched by any of it;
--   * unit work stays locked until the talk is signed (ADR-0012 §5) on EVERY
--     door, even on the shift the rule just opened unsigned:
--     start_opening_work, start_opening_phase, start_unit_session (both
--     roles), resume_opening_phase, custom_work_command's unit start and
--     answer_summon are each refused with the one plain sentence and write
--     nothing; Prep time (a start with no unit) still starts, on purpose;
--     signed, every door opens and does what it always did; and the database
--     shows exactly those six wired to _unit_work_gate;
--   * the three crew announcements exist for their audiences, in Spanish too.
--
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/r1-front-door \
--        -f migrations="supabase/migrations/20261031000000_new_front_door.sql" \
--        -f probe=scripts/dry-run-probes/pr-642-front-door.sql
--
-- MERGE-ORDER HAZARD (read before dispatching, and again before merging):
--   PR #640 (branch claude/r0-clock-integrity, migration 20261028000000)
--   merges FIRST. It adds a NEW keyed clock_in overload —
--     clock_in(p_project_id, p_cost_code_id, p_photo, p_lat, p_lng, p_note,
--              p_mode, p_client_id, p_tapped_at, p_clock_checked_at,
--              p_clock_skew_ms)
--   — whose body carries its own inline copy of the toolbox check, and it
--   leaves the five older overloads alone. This migration (20261031000000)
--   re-issues those five to call _toolbox_gate_open and knows nothing of the
--   keyed one. Once #640 is on master, the paid-time rule would open the
--   five doors the phone no longer uses and leave the keyed door — the one
--   startShiftOrQueue calls — shut. Before #642 merges:
--     1. rebase this branch onto master with #640 in it;
--     2. make 20261031000000 re-issue the keyed overload as well, with
--        `if not public._toolbox_gate_open(v_uid) then raise …` in place of
--        its inline `exists (select 1 from toolbox_completions …)`;
--     3. extend this probe: call the keyed overload as the installer with
--        the gate closed (refused), signed (clocks in) and unsigned with the
--        owner's date on (clocks in) — the same three rows the five below
--        get.
--   The check "clock_in: every overload on the database routes through
--   _toolbox_gate_open" below goes red by itself the moment #640's overload
--   is on the database without step 2, so a stale probe cannot pass by
--   accident. If #640 is not yet deployed when this is dispatched, the
--   database has five overloads and that check counts five.
--
-- THE INSTALLER IT ACTS AS: dry_run_pick('installer') takes the QA installer
-- login first (docs/test-account.md) — the account the database fences to
-- the sandbox, and the only login this probe should clock in and sign a talk
-- under. On 2026-09-23 that login's profile role still read 'foreman' by
-- mistake (the owner is fixing it); until it is fixed the picker returns a
-- REAL installer. The first thing the probe does is refuse to go on in that
-- case, out loud, rather than fail later on a sandbox guard nobody asked
-- about.
--
-- THE UNIT-WORK GATE, AND HOW IT IS CHECKED HERE: ADR-0012 §5 and the
-- migration's header say unit work stays refused until the talk is signed,
-- whatever the rule says about the shift. 20260969000000 had dropped the
-- signature check from start_opening_work, start_opening_phase and
-- start_unit_session on the strength of "an open shift proves the talk is
-- signed" — which the paid-time rule makes untrue, and which the first
-- version of this probe caught (verify-new-front-door.mjs was stubbing an
-- older body). 20261031000000 now puts the check back, through one helper
-- (_unit_work_gate), on every path that starts a timer on a unit: those
-- three, resume_opening_phase, custom_work_command's 'start' with a unit_id
-- (Current Work, the new Work screen, the Forge AI field tool) and
-- answer_summon. Block A checks the gate is wired into exactly those six on
-- the database; block D calls every one of them as the installer, clocked in
-- UNSIGNED under the rule (refused, nothing written), then signed (each opens
-- and does what it always did). Prep time — a 'start' with no unit — is
-- deliberately NOT gated (an owner question); block D proves it still starts.

-- ---------------------------------------------------------------------------
-- A. Setup, the loud early checks, and what the migration left in the schema
-- ---------------------------------------------------------------------------
do $$
declare
  v_who uuid;
  v_job uuid;
  v_is_test boolean;
  v_n int;
  v_total int;
  v_gated int;
  v_gated_names text;
  v_cs public.company_settings;
  v_col record;
begin
  perform pg_temp.dry_run_as_system();
  v_who := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_job('BLACK22');

  -- Loud and early: this probe clocks in and signs a talk, and does that
  -- only under a test login the database fences to the sandbox job.
  select coalesce(p.is_test, false) into v_is_test from public.profiles p where p.id = v_who;
  if not v_is_test then
    raise exception using message =
      'dry run: the installer picked is a REAL person, not the QA installer test login. '
      || 'dry_run_pick(''installer'') takes the QA login first only while its profile role is ''installer''; '
      || 'on 2026-09-23 that profile still read ''foreman''. Set the QA installer''s role back to installer '
      || '(docs/test-account.md) and dispatch again — nothing was checked.';
  end if;
  select count(*) into v_n from public.sandbox_projects where project_id = v_job;
  if v_n = 0 then
    raise exception using message =
      'dry run: BLACK22 is not in sandbox_projects, so the QA installer''s clock-ins on it would be '
      || 'refused by the sandbox guard for a reason that has nothing to do with this change. '
      || 'Put it back (set_project_test) and dispatch again — nothing was checked.';
  end if;
  perform pg_temp.dry_run_check('setup: acting on BLACK22 as the QA installer login (a test login, inside the sandbox)',
    true, 'installer ' || v_who || ', job ' || v_job);

  -- Start every clock scenario from a clean slate: no shift left open from
  -- before, and no signature today, so the gate is CLOSED until the probe
  -- opens it on purpose. Both are rolled back with everything else.
  update public.time_shifts set clock_out_at = now(), status = 'submitted'
   where profile_id = v_who and status = 'open' and clock_out_at is null;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('setup: the installer''s open shifts are closed for the run', true, v_n || ' open shift(s) closed');
  delete from public.toolbox_completions
   where profile_id = v_who
     and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('setup: the installer has no toolbox signature today', true, v_n || ' signature(s) removed for the run');

  -- profiles.ui_design: present, not null, classic by default, constrained.
  select c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'profiles' and c.column_name = 'ui_design';
  perform pg_temp.dry_run_check('schema: profiles.ui_design exists, not null, default classic',
    v_col.is_nullable = 'NO' and v_col.column_default like '%classic%',
    coalesce(v_col.is_nullable, 'missing') || ' / ' || coalesce(v_col.column_default, 'no default'));
  select count(*) into v_n from public.profiles where ui_design <> 'classic';
  perform pg_temp.dry_run_check('schema: every person on record starts on the classic design', v_n = 0, v_n || ' row(s) not classic');
  select count(*) into v_n from pg_constraint
   where conname = 'profiles_ui_design_check' and conrelid = 'public.profiles'::regclass;
  perform pg_temp.dry_run_check('schema: profiles_ui_design_check exists', v_n = 1, v_n || ' constraint(s)');
  perform pg_temp.dry_run_expect_error('schema: the constraint refuses a design that is neither classic nor new, even past the RPC',
    format('update public.profiles set ui_design = %L where id = %L::uuid', 'neon', v_who), 'profiles_ui_design_check');

  -- company_settings: the two owner columns and their live values.
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'company_settings' and c.column_name = 'new_design_r1_enabled';
  perform pg_temp.dry_run_check('schema: company_settings.new_design_r1_enabled is boolean, not null, default true',
    v_col.data_type = 'boolean' and v_col.is_nullable = 'NO' and v_col.column_default = 'true',
    coalesce(v_col.data_type, 'missing') || ' / ' || coalesce(v_col.column_default, 'no default'));
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'company_settings' and c.column_name = 'paid_time_from_start_day_on';
  perform pg_temp.dry_run_check('schema: company_settings.paid_time_from_start_day_on is a nullable date with no default',
    v_col.data_type = 'date' and v_col.is_nullable = 'YES' and v_col.column_default is null,
    coalesce(v_col.data_type, 'missing') || ' / ' || coalesce(v_col.column_default, 'no default'));
  select * into v_cs from public.company_settings where id = 1;
  perform pg_temp.dry_run_check('settings: on deploy the master switch is ON and the paid-time date is OFF (null), so nothing changes for anyone',
    v_cs.id = 1 and v_cs.new_design_r1_enabled = true and v_cs.paid_time_from_start_day_on is null,
    'switch ' || coalesce(v_cs.new_design_r1_enabled::text, 'no row') || ', date ' || coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));

  -- The functions, and who may call them.
  perform pg_temp.dry_run_check('schema: the four new functions exist with the signatures the app calls',
    to_regprocedure('public.set_my_ui_design(text)') is not null
    and to_regprocedure('public.set_new_design_switch(text, boolean)') is not null
    and to_regprocedure('public.set_paid_time_rule_date(date)') is not null
    and to_regprocedure('public._toolbox_gate_open(uuid)') is not null, null);
  perform pg_temp.dry_run_check('grants: signed-in crew may call the four; anon may call none',
    has_function_privilege('authenticated', 'public.set_my_ui_design(text)', 'execute')
    and has_function_privilege('authenticated', 'public.set_new_design_switch(text, boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.set_paid_time_rule_date(date)', 'execute')
    and has_function_privilege('authenticated', 'public._toolbox_gate_open(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.set_my_ui_design(text)', 'execute')
    and not has_function_privilege('anon', 'public.set_new_design_switch(text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.set_paid_time_rule_date(date)', 'execute')
    and not has_function_privilege('anon', 'public._toolbox_gate_open(uuid)', 'execute'), null);
  perform pg_temp.dry_run_check('grants: crew can read profiles.ui_design and not write it (like language, role, pin_hash)',
    has_column_privilege('authenticated', 'public.profiles', 'ui_design', 'select')
    and not has_column_privilege('authenticated', 'public.profiles', 'ui_design', 'update'), null);
  perform pg_temp.dry_run_check('grants: crew can read company_settings and not write it',
    has_table_privilege('authenticated', 'public.company_settings', 'select')
    and not has_table_privilege('authenticated', 'public.company_settings', 'update'), null);

  -- The five re-issued overloads, by signature, and the one-gate promise
  -- across EVERY clock_in on the database (see the merge-order hazard).
  perform pg_temp.dry_run_check('clock_in: the five overloads the migration re-issues are all present',
    to_regprocedure('public.clock_in(uuid, uuid, text, double precision, double precision)') is not null
    and to_regprocedure('public.clock_in(uuid, uuid, text, double precision, double precision, text)') is not null
    and to_regprocedure('public.clock_in(uuid, uuid, text, double precision, double precision, uuid)') is not null
    and to_regprocedure('public.clock_in(uuid, uuid, text, double precision, double precision, uuid, text)') is not null
    and to_regprocedure('public.clock_in(uuid, uuid, text, double precision, double precision, text, text)') is not null, null);
  select count(*) filter (where position('_toolbox_gate_open' in p.prosrc) > 0), count(*)
    into v_gated, v_total
    from pg_proc p
   where p.proname = 'clock_in' and p.pronamespace = 'public'::regnamespace;
  perform pg_temp.dry_run_check('clock_in: every overload on the database routes through _toolbox_gate_open (one that does not is the #640 merge-order hazard)',
    v_total >= 5 and v_gated = v_total, v_gated || ' of ' || v_total || ' overload(s) gated');

  -- The unit-work gate (ADR-0012 §5): the two helpers, who may call them,
  -- and EXACTLY the six doors wired to it — one dropped, or one added
  -- without it, changes this list by name.
  perform pg_temp.dry_run_check('unit work: _toolbox_signed_today and _unit_work_gate exist',
    to_regprocedure('public._toolbox_signed_today(uuid)') is not null
    and to_regprocedure('public._unit_work_gate(uuid)') is not null, null);
  perform pg_temp.dry_run_check('grants: signed-in crew may call the two unit-work helpers; anon may not',
    has_function_privilege('authenticated', 'public._toolbox_signed_today(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public._unit_work_gate(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._toolbox_signed_today(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._unit_work_gate(uuid)', 'execute'), null);
  select string_agg(p.proname, ', ' order by p.proname) into v_gated_names
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and position('_unit_work_gate' in p.prosrc) > 0;
  perform pg_temp.dry_run_check('unit work: exactly the six doors route through _unit_work_gate (answer_summon, custom_work_command, resume_opening_phase, start_opening_phase, start_opening_work, start_unit_session)',
    v_gated_names = 'answer_summon, custom_work_command, resume_opening_phase, start_opening_phase, start_opening_work, start_unit_session',
    coalesce(v_gated_names, 'none'));
  perform pg_temp.dry_run_check('unit work: the clock-in gate and the unit-work gate both read the one _toolbox_signed_today',
    exists (select 1 from pg_proc where proname = '_toolbox_gate_open' and pronamespace = 'public'::regnamespace and position('_toolbox_signed_today' in prosrc) > 0)
    and exists (select 1 from pg_proc where proname = '_unit_work_gate' and pronamespace = 'public'::regnamespace and position('_toolbox_signed_today' in prosrc) > 0), null);
end $$;

-- ---------------------------------------------------------------------------
-- B. The person's own front door: set_my_ui_design moves one row, theirs
-- ---------------------------------------------------------------------------
do $$
declare
  v_who uuid;
  v_foreman uuid;
  v_role text;
  v_design text;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_who := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');

  v_role := pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('acting as an installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_who and v_role = 'installer', v_role);
  select ui_design into v_design from public.profiles where id = auth.uid();
  perform pg_temp.dry_run_check('ui_design: an installer reads their own choice through the column grant, and starts on classic',
    v_design = 'classic', coalesce(v_design, 'null'));
  perform public.set_my_ui_design('new');
  select ui_design into v_design from public.profiles where id = auth.uid();
  perform pg_temp.dry_run_check('set_my_ui_design: an installer switches themselves to the new design', v_design = 'new', coalesce(v_design, 'null'));
  perform public.set_my_ui_design(' Classic ');
  select ui_design into v_design from public.profiles where id = auth.uid();
  perform pg_temp.dry_run_check('set_my_ui_design: trims and lower-cases what the phone sends', v_design = 'classic', coalesce(v_design, 'null'));
  perform pg_temp.dry_run_expect_error('set_my_ui_design: anything but classic or new is refused',
    'select public.set_my_ui_design(''neon'')', 'classic or new');
  perform pg_temp.dry_run_expect_error('ui_design: writing the column straight is refused, even on your own row',
    format('update public.profiles set ui_design = %L where id = %L::uuid', 'new', v_who), 'permission denied');
  perform pg_temp.dry_run_expect_error('ui_design: writing somebody else''s choice straight is refused',
    format('update public.profiles set ui_design = %L where id = %L::uuid', 'new', v_foreman), 'permission denied');
  perform public.set_my_ui_design('new');  -- leave the installer on the new design for the cross-checks below

  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as a foreman', v_role = 'foreman' and auth.uid() = v_foreman, v_role);
  select ui_design into v_design from public.profiles where id = auth.uid();
  perform pg_temp.dry_run_check('set_my_ui_design: the installer''s choice did not move the foreman''s row', v_design = 'classic', coalesce(v_design, 'null'));
  perform public.set_my_ui_design('new');
  select ui_design into v_design from public.profiles where id = auth.uid();
  perform pg_temp.dry_run_check('set_my_ui_design: a foreman switches themselves too', v_design = 'new', coalesce(v_design, 'null'));

  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.profiles where ui_design = 'new' and id in (v_who, v_foreman);
  perform pg_temp.dry_run_check('set_my_ui_design: both callers'' rows say new', v_n = 2, v_n || ' of 2');
  select count(*) into v_n from public.profiles where ui_design <> 'classic' and id not in (v_who, v_foreman);
  perform pg_temp.dry_run_check('set_my_ui_design: nobody else''s row moved', v_n = 0, v_n || ' other row(s) changed');
end $$;

-- ---------------------------------------------------------------------------
-- C. The owner's two switches: refused below owner, one job each for the owner
-- ---------------------------------------------------------------------------
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_supervisor uuid;
  v_owner uuid;
  v_role text;
  v_today date;
  v_flag boolean;
  v_design text;
  v_cs public.company_settings;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_owner := pg_temp.dry_run_pick_real('owner');
  -- A supervisor is the nearest role that must still be refused; the company
  -- may not have one on record, and that is a fact to report, not a failure.
  begin
    v_supervisor := pg_temp.dry_run_pick_real('supervisor');
  exception when others then
    v_supervisor := null;
  end;
  -- The company-local day, the way the function computes it: current_date
  -- is the session's (UTC) day and differs from Denver's every evening.
  v_today := (now() at time zone 'America/Denver')::date;

  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('set_new_design_switch: an installer is refused in one plain sentence',
    'select public.set_new_design_switch(''r1'', false)', 'Only an owner');
  perform pg_temp.dry_run_expect_error('set_paid_time_rule_date: an installer is refused in one plain sentence',
    format('select public.set_paid_time_rule_date(%L::date)', v_today), 'Only an owner');
  perform pg_temp.dry_run_expect_error('company_settings: an installer cannot write the master switch straight',
    'update public.company_settings set new_design_r1_enabled = false where id = 1', 'permission denied');
  perform pg_temp.dry_run_expect_error('company_settings: an installer cannot write the paid-time date straight',
    format('update public.company_settings set paid_time_from_start_day_on = %L::date where id = 1', v_today), 'permission denied');
  select new_design_r1_enabled into v_flag from public.company_settings where id = 1;
  perform pg_temp.dry_run_check('company_settings: an installer can READ the master switch (the app resolves the design from it)',
    v_flag = true, coalesce(v_flag::text, 'no row visible'));

  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('set_new_design_switch: a foreman is refused',
    'select public.set_new_design_switch(''r1'', false)', 'Only an owner');
  perform pg_temp.dry_run_expect_error('set_paid_time_rule_date: a foreman is refused',
    format('select public.set_paid_time_rule_date(%L::date)', v_today), 'Only an owner');

  if v_supervisor is not null then
    perform pg_temp.dry_run_act_as(v_supervisor);
    perform pg_temp.dry_run_expect_error('set_new_design_switch: a supervisor is refused (owner only, not lead)',
      'select public.set_new_design_switch(''r1'', false)', 'Only an owner');
    perform pg_temp.dry_run_expect_error('set_paid_time_rule_date: a supervisor is refused (owner only, not lead)',
      format('select public.set_paid_time_rule_date(%L::date)', v_today), 'Only an owner');
  else
    perform pg_temp.dry_run_check('set_new_design_switch / set_paid_time_rule_date: a supervisor is refused',
      true, 'not tried: nobody with the role supervisor on record to act as');
  end if;

  v_role := pg_temp.dry_run_act_as(v_owner);
  perform pg_temp.dry_run_check('acting as the owner', v_role = 'owner' and public.my_role_rank() = 3, v_role);
  v_cs := public.set_new_design_switch('r1', false);
  perform pg_temp.dry_run_check('set_new_design_switch: the owner turns Release 1 off for everyone at once, and the row says who',
    v_cs.new_design_r1_enabled = false and v_cs.updated_by = v_owner,
    'switch ' || coalesce(v_cs.new_design_r1_enabled::text, 'null'));
  v_cs := public.set_new_design_switch('r1', true);
  perform pg_temp.dry_run_check('set_new_design_switch: and back on', v_cs.new_design_r1_enabled = true,
    'switch ' || coalesce(v_cs.new_design_r1_enabled::text, 'null'));
  perform pg_temp.dry_run_expect_error('set_new_design_switch: an unknown release is refused in one sentence',
    'select public.set_new_design_switch(''r9'', true)', 'Unknown release');
  perform pg_temp.dry_run_expect_error('set_new_design_switch: on-or-off has to be said',
    'select public.set_new_design_switch(''r1'', null)', 'on or off');
  perform pg_temp.dry_run_expect_error('set_paid_time_rule_date: a day in the past is refused (the day would run under two rules)',
    format('select public.set_paid_time_rule_date(%L::date)', v_today - 1), 'cannot start in the past');
  v_cs := public.set_paid_time_rule_date(v_today + 7);
  perform pg_temp.dry_run_check('set_paid_time_rule_date: the owner books the rule for a day ahead',
    v_cs.paid_time_from_start_day_on = v_today + 7 and v_cs.updated_by = v_owner,
    coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));
  v_cs := public.set_paid_time_rule_date(null::date);
  perform pg_temp.dry_run_check('set_paid_time_rule_date: clearing the date switches the rule off',
    v_cs.paid_time_from_start_day_on is null, coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));

  perform pg_temp.dry_run_as_system();
  select ui_design into v_design from public.profiles where id = v_installer;
  perform pg_temp.dry_run_check('settings: a person''s choice survives the master switch going off and on (choices are kept)',
    v_design = 'new', coalesce(v_design, 'null'));
  select * into v_cs from public.company_settings where id = 1;
  perform pg_temp.dry_run_check('settings: after the owner''s round trip the row is back where the migration left it',
    v_cs.new_design_r1_enabled = true and v_cs.paid_time_from_start_day_on is null,
    'switch ' || v_cs.new_design_r1_enabled || ', date ' || coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- D. One gate, five doors: closed, opened by a signature, opened by the date —
--    and, on the shift the date opened unsigned, unit work locked on six more
-- ---------------------------------------------------------------------------
do $$
declare
  v_who uuid;
  v_job uuid;
  v_owner uuid;
  v_cost_code uuid;
  v_opening uuid;
  v_no_phase uuid;
  v_paused uuid;
  v_summon uuid;
  v_unit uuid := gen_random_uuid();
  v_prep uuid;
  v_custom uuid;
  v_kind text;
  v_stamp_before timestamptz;
  v_o public.project_openings;
  v_ph public.opening_phases;
  v_us public.unit_sessions;
  v_sh public.summon_helpers;
  v_today date;
  v_base text;
  v_nulls text;
  v_s1 public.time_shifts;
  v_s2 public.time_shifts;
  v_s3 public.time_shifts;
  v_s4 public.time_shifts;
  v_s5 public.time_shifts;
  v_again public.time_shifts;
  v_cs public.company_settings;
  v_n int;
  v_open int;
  v_pre_n int;
  v_pre_hash text;
  v_post_n int;
  v_post_hash text;
  v_cid_refused uuid := gen_random_uuid();
  v_cid1 uuid := gen_random_uuid();
  v_cid2 uuid := gen_random_uuid();
  v_cid3 uuid := gen_random_uuid();
  v_cid4 uuid := gen_random_uuid();
begin
  -- ---- setup, as the system ---------------------------------------------------
  perform pg_temp.dry_run_as_system();
  v_who := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_job('BLACK22');
  v_owner := pg_temp.dry_run_pick_real('owner');
  v_today := (now() at time zone 'America/Denver')::date;
  select id into v_cost_code from public.cost_codes order by active desc, code limit 1;
  -- An opening on the sandbox job that is clear of flashing, so a refusal
  -- below can only be about the signature.
  select o.id into v_opening from public.project_openings o
   where o.project_id = v_job and coalesce(public._flashing_outstanding(o.id), false) = false
   order by o.id limit 1;
  -- Two more openings for the doors that need a phase row of their own: one
  -- with no flashing phase yet (start_opening_phase inserts it), and one to
  -- carry a phase the installer paused yesterday (resume_opening_phase).
  select o.id into v_no_phase from public.project_openings o
   where o.project_id = v_job and o.removed_at is null and o.id is distinct from v_opening
     and not exists (select 1 from public.opening_phases ph where ph.opening_id = o.id and ph.kind = 'flashing')
   order by o.id limit 1;
  select o.id into v_paused from public.project_openings o
   where o.project_id = v_job and o.removed_at is null
     and o.id is distinct from v_opening and o.id is distinct from v_no_phase
     and not exists (select 1 from public.opening_phases ph where ph.opening_id = o.id and ph.kind = 'flashing')
   order by o.id limit 1;
  if v_paused is not null then
    insert into public.opening_phases (opening_id, kind, started_by, status, started_at, paused_at)
    values (v_paused, 'flashing', v_who, 'active', now() - interval '1 day', now() - interval '5 minutes');
  end if;
  -- A summon the owner put out on the installer's unit (the answerer must
  -- not be the caller), and a clean custom-work slate for the installer so a
  -- refusal below can only be about the signature.
  if v_opening is not null then
    insert into public.summons (project_id, opening_id, requested_by, needed)
    values (v_job, v_opening, v_owner, 1) returning id into v_summon;
    select work_started_at into v_stamp_before from public.project_openings where id = v_opening;
  end if;
  update public.custom_work_sessions set ended_at = now(), end_reason = 'stop'
   where profile_id = v_who and ended_at is null;
  -- Block A already did both of these; repeated here so this block stands
  -- on its own if it is ever run alone. Both are no-ops the second time.
  update public.time_shifts set clock_out_at = now(), status = 'submitted'
   where profile_id = v_who and status = 'open' and clock_out_at is null;
  delete from public.toolbox_completions
   where profile_id = v_who
     and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date;
  -- What is on the installer's record before any door opens. Every shift
  -- this run writes carries clock_in_at = now() (the transaction's one
  -- instant), so `clock_in_at < now()` is exactly the rows that were there
  -- already, and the same fingerprint at the end proves none of them moved.
  select count(*), coalesce(md5(string_agg(id::text || '|' || clock_in_at::text || '|' || coalesce(clock_out_at::text, '-') || '|' || coalesce(status, '-'), ',' order by id)), '-')
    into v_pre_n, v_pre_hash
    from public.time_shifts where profile_id = v_who and clock_in_at < now();
  perform pg_temp.dry_run_check('setup: gate closed, one cost code and (if BLACK22 has one) an opening clear of flashing picked',
    v_cost_code is not null, 'cost code ' || coalesce(v_cost_code::text, 'none') || ', opening ' || coalesce(v_opening::text, 'none clear of flashing') || ', ' || v_pre_n || ' shift(s) already on record');
  v_base := format('p_project_id => %L::uuid, p_cost_code_id => %L::uuid', v_job, v_cost_code);
  v_nulls := 'p_photo => null::text, p_lat => null::double precision, p_lng => null::double precision';

  -- ---- gate CLOSED (no signature, no date): every door refuses, in the same words ----
  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('gate: closed with no signature today and no paid-time date',
    public._toolbox_gate_open(auth.uid()) = false, public._toolbox_gate_open(auth.uid())::text);
  perform pg_temp.dry_run_expect_error('clock_in (project, cost code): refused unsigned with the plain sentence',
    'select public.clock_in(' || v_base || ')', 'complete today''s toolbox talk before clocking in');
  perform pg_temp.dry_run_expect_error('clock_in (+ note): refused unsigned with the plain sentence',
    'select public.clock_in(' || v_base || ', ' || v_nulls || ', p_note => ''dry run''::text)', 'complete today''s toolbox talk before clocking in');
  perform pg_temp.dry_run_expect_error('clock_in (+ client id, the offline one): refused unsigned with the plain sentence',
    'select public.clock_in(' || v_base || ', ' || v_nulls || format(', p_client_id => %L::uuid)', v_cid_refused), 'complete today''s toolbox talk before clocking in');
  perform pg_temp.dry_run_expect_error('clock_in (+ client id + note): refused unsigned with the plain sentence',
    'select public.clock_in(' || v_base || ', ' || v_nulls || format(', p_client_id => %L::uuid, p_note => ''dry run''::text)', v_cid_refused), 'complete today''s toolbox talk before clocking in');
  perform pg_temp.dry_run_expect_error('clock_in (+ note + mode, the one the app calls first): refused unsigned with the plain sentence',
    'select public.clock_in(' || v_base || ', ' || v_nulls || ', p_note => ''dry run''::text, p_mode => ''data''::text)', 'complete today''s toolbox talk before clocking in');

  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.time_shifts where profile_id = v_who and clock_in_at = now();
  perform pg_temp.dry_run_check('gate closed: five refusals wrote no shift', v_n = 0, v_n || ' shift(s)');
  select count(*) into v_n from public.time_shifts where client_id = v_cid_refused;
  perform pg_temp.dry_run_check('gate closed: the refused offline id claimed no row', v_n = 0, v_n || ' row(s)');

  -- ---- gate OPENED BY A SIGNATURE, date unset: today's behaviour, every door ----
  insert into public.toolbox_completions (profile_id, signed_at) values (v_who, now());
  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('gate: open once today''s talk is on the record',
    public._toolbox_gate_open(auth.uid()) = true, public._toolbox_gate_open(auth.uid())::text);
  v_s1 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code);
  perform pg_temp.dry_run_check('clock_in (project, cost code): signed, clocks in on BLACK22 at arrival',
    v_s1.id is not null and v_s1.project_id = v_job and v_s1.profile_id = v_who and v_s1.status = 'open' and v_s1.clock_in_at = now(),
    'shift ' || coalesce(v_s1.id::text, 'none'));
  v_s2 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_note => 'dry run 2'::text);
  perform pg_temp.dry_run_check('clock_in (+ note): signed, clocks in at arrival with the note kept',
    v_s2.id is not null and v_s2.id <> v_s1.id and v_s2.project_id = v_job and v_s2.note = 'dry run 2' and v_s2.clock_in_at = now(),
    'shift ' || coalesce(v_s2.id::text, 'none'));
  v_s3 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid1);
  perform pg_temp.dry_run_check('clock_in (+ client id): signed, clocks in at arrival carrying the id',
    v_s3.id is not null and v_s3.project_id = v_job and v_s3.client_id = v_cid1 and v_s3.clock_in_at = now(),
    'shift ' || coalesce(v_s3.id::text, 'none'));
  v_again := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid1);
  perform pg_temp.dry_run_check('clock_in (+ client id): the same id resent answers with the same shift, not a second one',
    v_again.id = v_s3.id, 'shift ' || coalesce(v_again.id::text, 'none'));
  v_s4 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid2, p_note => 'dry run 4'::text);
  perform pg_temp.dry_run_check('clock_in (+ client id + note): signed, clocks in at arrival with both kept',
    v_s4.id is not null and v_s4.project_id = v_job and v_s4.client_id = v_cid2 and v_s4.note = 'dry run 4' and v_s4.clock_in_at = now(),
    'shift ' || coalesce(v_s4.id::text, 'none'));
  v_again := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid2, p_note => 'other words'::text);
  perform pg_temp.dry_run_check('clock_in (+ client id + note): the same id resent answers with the original shift, note unchanged',
    v_again.id = v_s4.id and v_again.note = 'dry run 4', 'shift ' || coalesce(v_again.id::text, 'none'));
  v_s5 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_note => 'dry run 5'::text, p_mode => 'data'::text);
  perform pg_temp.dry_run_check('clock_in (+ note + mode): signed, clocks in at arrival in data mode',
    v_s5.id is not null and v_s5.project_id = v_job and v_s5.job_mode = 'data' and v_s5.clock_in_at = now(),
    'shift ' || coalesce(v_s5.id::text, 'none'));

  perform pg_temp.dry_run_as_system();
  select count(*), count(*) filter (where status = 'open' and clock_out_at is null) into v_n, v_open
    from public.time_shifts where profile_id = v_who and clock_in_at = now();
  perform pg_temp.dry_run_check('date unset: five doors made five shifts, each closing the one before it, as today',
    v_n = 5 and v_open = 1, v_n || ' shift(s), ' || v_open || ' open');

  -- ---- gate OPENED BY THE DATE, unsigned: the owner's rule, every door ----
  delete from public.toolbox_completions
   where profile_id = v_who
     and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date;
  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('gate: closed again once the signature is gone (date still unset)',
    public._toolbox_gate_open(auth.uid()) = false, public._toolbox_gate_open(auth.uid())::text);
  perform pg_temp.dry_run_expect_error('clock_in (+ note + mode): unsigned and no date, still refused',
    'select public.clock_in(' || v_base || ', ' || v_nulls || ', p_note => ''dry run''::text, p_mode => ''data''::text)', 'complete today''s toolbox talk before clocking in');

  perform pg_temp.dry_run_act_as(v_owner);
  v_cs := public.set_paid_time_rule_date(v_today);
  perform pg_temp.dry_run_check('set_paid_time_rule_date: the owner starts the rule today',
    v_cs.paid_time_from_start_day_on = v_today, coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));

  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('gate: open with NO signature once the owner''s date has arrived',
    public._toolbox_gate_open(auth.uid()) = true, public._toolbox_gate_open(auth.uid())::text);
  v_s1 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code);
  perform pg_temp.dry_run_check('clock_in (project, cost code): unsigned under the rule, clocks in — still at arrival',
    v_s1.id is not null and v_s1.project_id = v_job and v_s1.status = 'open' and v_s1.clock_in_at = now(),
    'shift ' || coalesce(v_s1.id::text, 'none'));
  v_s2 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_note => 'dry run 7'::text);
  perform pg_temp.dry_run_check('clock_in (+ note): unsigned under the rule, clocks in — still at arrival',
    v_s2.id is not null and v_s2.project_id = v_job and v_s2.clock_in_at = now(), 'shift ' || coalesce(v_s2.id::text, 'none'));
  v_s3 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid3);
  perform pg_temp.dry_run_check('clock_in (+ client id): unsigned under the rule, clocks in — still at arrival',
    v_s3.id is not null and v_s3.project_id = v_job and v_s3.client_id = v_cid3 and v_s3.clock_in_at = now(), 'shift ' || coalesce(v_s3.id::text, 'none'));
  v_s4 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_client_id => v_cid4, p_note => 'dry run 9'::text);
  perform pg_temp.dry_run_check('clock_in (+ client id + note): unsigned under the rule, clocks in — still at arrival',
    v_s4.id is not null and v_s4.project_id = v_job and v_s4.client_id = v_cid4 and v_s4.clock_in_at = now(), 'shift ' || coalesce(v_s4.id::text, 'none'));
  v_s5 := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null::text,
    p_lat => null::double precision, p_lng => null::double precision, p_note => 'dry run 10'::text, p_mode => 'data'::text);
  perform pg_temp.dry_run_check('clock_in (+ note + mode): unsigned under the rule, clocks in — still at arrival, data mode',
    v_s5.id is not null and v_s5.project_id = v_job and v_s5.job_mode = 'data' and v_s5.clock_in_at = now(), 'shift ' || coalesce(v_s5.id::text, 'none'));

  -- ---- clocked in UNSIGNED under the rule: unit work is locked on every door (ADR-0012 §5) ----
  -- The saved custom unit the custom-work door needs. Recording a unit
  -- starts nothing, so the 'unit' action is rightly not gated.
  perform public.custom_work_command(gen_random_uuid(), 'unit', jsonb_build_object(
    'id', v_unit, 'revision', 0, 'project_id', v_job, 'opening_id', null, 'label', 'dry run unit',
    'type_label', 'Dry run', 'facts', '{}'::jsonb, 'reason', 'dry run'));
  if v_opening is not null then
    perform pg_temp.dry_run_expect_error('start_opening_work: unit work is refused until the talk is signed, even though the shift began under the rule (ADR-0012 §5)',
      format('select public.start_opening_work(%L::uuid)', v_opening), 'toolbox talk');
    perform pg_temp.dry_run_expect_error('start_opening_phase: refused unsigned on the shift the rule opened',
      format('select public.start_opening_phase(%L::uuid, ''flashing'')', v_opening), 'toolbox talk');
    perform pg_temp.dry_run_expect_error('start_unit_session (install): refused unsigned on the shift the rule opened',
      format('select public.start_unit_session(%L::uuid, ''install'')', v_opening), 'toolbox talk');
    perform pg_temp.dry_run_expect_error('start_unit_session (helper): refused unsigned on the shift the rule opened',
      format('select public.start_unit_session(%L::uuid, ''helper'')', v_opening), 'toolbox talk');
    perform pg_temp.dry_run_expect_error('custom_work_command start (a unit — Current Work, the new Work screen, Forge AI start_unit_work): refused unsigned on the shift the rule opened',
      format('select public.custom_work_command(%L::uuid, ''start'', %L::jsonb)', gen_random_uuid(),
        jsonb_build_object('id', gen_random_uuid(), 'unit_id', v_unit, 'shift_id', v_s5.id, 'project_id', v_job,
          'expected_session_id', null, 'stage', 'Installing', 'participation', 'install', 'description', '')::text),
      'toolbox talk');
    perform pg_temp.dry_run_expect_error('answer_summon: refused unsigned on the shift the rule opened (the answer would open a helper session)',
      format('select public.answer_summon(%L::uuid)', v_summon), 'toolbox talk');
  else
    perform pg_temp.dry_run_check('unit work: the five doors on an opening are refused unsigned under the rule (ADR-0012 §5)',
      false, 'not proved: BLACK22 has no opening clear of flashing to try them on');
  end if;
  if v_paused is not null then
    perform pg_temp.dry_run_expect_error('resume_opening_phase: a phase paused yesterday is refused unsigned today',
      format('select public.resume_opening_phase(%L::uuid, ''flashing'')', v_paused), 'toolbox talk');
  else
    perform pg_temp.dry_run_check('resume_opening_phase: a phase paused yesterday is refused unsigned today',
      false, 'not proved: BLACK22 has no second opening without a flashing phase to pause');
  end if;

  -- The refusals wrote nothing. Every row this transaction writes carries
  -- now() as its start, so "started now" is exactly "written by this run".
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.unit_sessions where profile_id = v_who and started_at = now();
  perform pg_temp.dry_run_check('unit work refused: no unit session was opened', v_n = 0, v_n || ' row(s)');
  select count(*) into v_n from public.task_sessions where profile_id = v_who and started_at = now();
  perform pg_temp.dry_run_check('unit work refused: no task session was opened', v_n = 0, v_n || ' row(s)');
  select count(*) into v_n from public.opening_phases where started_by = v_who and started_at = now();
  perform pg_temp.dry_run_check('unit work refused: no phase was started', v_n = 0, v_n || ' row(s)');
  select count(*) into v_n from public.custom_work_sessions where profile_id = v_who and kind = 'unit' and started_at = now();
  perform pg_temp.dry_run_check('unit work refused: no custom unit session was opened', v_n = 0, v_n || ' row(s)');
  select count(*) into v_n from public.summon_helpers where profile_id = v_who and joined_at = now();
  perform pg_temp.dry_run_check('unit work refused: no summon was answered', v_n = 0, v_n || ' row(s)');
  if v_opening is not null then
    perform pg_temp.dry_run_check('unit work refused: the opening was not stamped as started',
      (select work_started_at from public.project_openings where id = v_opening) is not distinct from v_stamp_before, null);
  end if;
  if v_paused is not null then
    perform pg_temp.dry_run_check('unit work refused: the paused phase is still paused',
      (select paused_at from public.opening_phases where opening_id = v_paused and kind = 'flashing') is not null, null);
  end if;

  -- Prep time — a 'start' with NO unit — is deliberately not gated (owner
  -- question, TODO in the migration): it starts unsigned, as it always has.
  perform pg_temp.dry_run_act_as(v_who);
  begin
    v_prep := public.custom_work_command(gen_random_uuid(), 'start', jsonb_build_object(
      'id', gen_random_uuid(), 'unit_id', null, 'shift_id', v_s5.id, 'expected_session_id', null, 'description', 'dry run prep'));
  exception when others then
    perform pg_temp.dry_run_check('prep time: a start with no unit is not gated — it starts unsigned (owner question)', false, 'refused: ' || sqlstate || ' ' || sqlerrm);
  end;
  if v_prep is not null then
    perform pg_temp.dry_run_as_system();
    select kind into v_kind from public.custom_work_sessions where id = v_prep;
    perform pg_temp.dry_run_check('prep time: a start with no unit is not gated — it starts unsigned (owner question)',
      v_kind = 'idle', coalesce(v_kind, 'no session'));
    perform pg_temp.dry_run_act_as(v_who);
    perform public.custom_work_command(gen_random_uuid(), 'stop', jsonb_build_object('expected_session_id', v_prep, 'outcome', 'finished'));
  end if;

  -- ---- signed: every door opens, and does what it always did ----
  perform pg_temp.dry_run_as_system();
  insert into public.toolbox_completions (profile_id, signed_at) values (v_who, now());
  perform pg_temp.dry_run_act_as(v_who);
  if v_opening is not null then
    v_o := public.start_opening_work(v_opening);
    perform pg_temp.dry_run_check('start_opening_work: signed, opens and stamps the unit as started — as before',
      v_o.id = v_opening and v_o.work_started_at is not null, null);
  end if;
  if v_no_phase is not null then
    v_ph := public.start_opening_phase(v_no_phase, 'flashing');
    perform pg_temp.dry_run_check('start_opening_phase: signed, starts the phase — as before',
      v_ph.status = 'active' and v_ph.started_by = v_who, 'phase ' || coalesce(v_ph.id::text, 'none'));
  else
    perform pg_temp.dry_run_check('start_opening_phase: signed, starts the phase — as before',
      true, 'not tried: BLACK22 has no opening without a flashing phase');
  end if;
  if v_opening is not null then
    v_us := public.start_unit_session(v_opening, 'install');
    perform pg_temp.dry_run_check('start_unit_session: signed, opens the installer''s session — as before',
      v_us.profile_id = v_who and v_us.role = 'install' and v_us.ended_at is null, 'session ' || coalesce(v_us.id::text, 'none'));
    v_custom := public.custom_work_command(gen_random_uuid(), 'start', jsonb_build_object(
      'id', gen_random_uuid(), 'unit_id', v_unit, 'shift_id', v_s5.id, 'project_id', v_job,
      'expected_session_id', null, 'stage', 'Installing', 'participation', 'install', 'description', ''));
    perform pg_temp.dry_run_check('custom_work_command start (a unit): signed, opens the custom session — as before',
      v_custom is not null, 'session ' || coalesce(v_custom::text, 'none'));
  end if;
  if v_paused is not null then
    v_ph := public.resume_opening_phase(v_paused, 'flashing');
    perform pg_temp.dry_run_check('resume_opening_phase: signed, picks the paused phase back up and books the pause — as before',
      v_ph.paused_at is null and v_ph.paused_seconds >= 299, coalesce(v_ph.paused_seconds::text, 'null') || ' paused second(s)');
  end if;
  if v_opening is not null then
    begin
      v_sh := public.answer_summon(v_summon);
      perform pg_temp.dry_run_check('answer_summon: signed, the answer lands — as before',
        v_sh.profile_id = v_who and v_sh.summon_id = v_summon, 'row ' || coalesce(v_sh.id::text, 'none'));
    exception when others then
      perform pg_temp.dry_run_check('answer_summon: signed, the answer lands — as before', false, 'refused: ' || sqlstate || ' ' || sqlerrm);
    end;
  end if;
  perform pg_temp.dry_run_as_system();
  if v_opening is not null then
    select count(*) into v_n from public.unit_sessions
     where profile_id = v_who and role = 'helper' and opening_id = v_opening and ended_at is null;
    perform pg_temp.dry_run_check('answer_summon: the trigger opened the helper unit session once the talk was signed', v_n = 1, v_n || ' row(s)');
  end if;
  -- Unsigned again for the checks that follow; the signature was this run's own.
  delete from public.toolbox_completions
   where profile_id = v_who
     and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date;

  -- ---- a date still ahead, then the date cleared: today's timing comes back ----
  perform pg_temp.dry_run_act_as(v_owner);
  v_cs := public.set_paid_time_rule_date(v_today + 1);
  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('gate: a date still ahead keeps it closed for the unsigned',
    public._toolbox_gate_open(auth.uid()) = false, public._toolbox_gate_open(auth.uid())::text);
  perform pg_temp.dry_run_expect_error('clock_in (+ note + mode): a date still ahead means today''s timing — refused unsigned',
    'select public.clock_in(' || v_base || ', ' || v_nulls || ', p_note => ''dry run''::text, p_mode => ''data''::text)', 'complete today''s toolbox talk before clocking in');
  perform pg_temp.dry_run_act_as(v_owner);
  v_cs := public.set_paid_time_rule_date(null::date);
  perform pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_expect_error('clock_in (project, cost code): the date cleared puts today''s timing back — refused unsigned',
    'select public.clock_in(' || v_base || ')', 'complete today''s toolbox talk before clocking in');

  -- ---- the truth, as the system ------------------------------------------------
  perform pg_temp.dry_run_as_system();
  select count(*), count(*) filter (where status = 'open' and clock_out_at is null) into v_n, v_open
    from public.time_shifts where profile_id = v_who and clock_in_at = now();
  perform pg_temp.dry_run_check('this run wrote ten shifts on BLACK22 (five signed, five under the rule) and left one open',
    v_n = 10 and v_open = 1, v_n || ' shift(s), ' || v_open || ' open');
  select count(*) into v_n from public.time_shifts
   where profile_id = v_who and clock_out_at is not null and clock_out_at < clock_in_at;
  perform pg_temp.dry_run_check('no shift on the installer''s record ends before it starts', v_n = 0, v_n || ' bad row(s)');
  select count(*), coalesce(md5(string_agg(id::text || '|' || clock_in_at::text || '|' || coalesce(clock_out_at::text, '-') || '|' || coalesce(status, '-'), ',' order by id)), '-')
    into v_post_n, v_post_hash
    from public.time_shifts where profile_id = v_who and clock_in_at < now();
  perform pg_temp.dry_run_check('the rule going on and off, and ten clock-ins, left every shift already on the record exactly as it was',
    v_post_n = v_pre_n and v_post_hash = v_pre_hash, v_pre_n || ' before, ' || v_post_n || ' after');
  select * into v_cs from public.company_settings where id = 1;
  perform pg_temp.dry_run_check('settings: the paid-time date is null again at the end', v_cs.paid_time_from_start_day_on is null,
    coalesce(v_cs.paid_time_from_start_day_on::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- E. Tell the crew: the three announcements, for their audiences, in Spanish too
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
  v_audience int[];
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.app_release_notes
   where id in ('2026-09-23-new-design-choice', '2026-09-23-prep-time', '2026-09-23-new-design-owner-switches')
     and withdrawn_at is null
     and length(btrim(title_es)) > 10 and length(btrim(body_es)) > 40;
  perform pg_temp.dry_run_check('announcements: the three release notes exist, live, with Spanish titles and bodies', v_n = 3, v_n || ' of 3');
  select audience into v_audience from public.app_release_notes where id = '2026-09-23-new-design-owner-switches';
  perform pg_temp.dry_run_check('announcements: the owner-switches note is for owners only', v_audience = array[3], coalesce(v_audience::text, 'no row'));
  select count(*) into v_n from public.app_release_notes
   where id in ('2026-09-23-new-design-choice', '2026-09-23-new-design-owner-switches') and href = '/settings';
  perform pg_temp.dry_run_check('announcements: the two design notes point at Settings', v_n = 2, v_n || ' of 2');
end $$;
