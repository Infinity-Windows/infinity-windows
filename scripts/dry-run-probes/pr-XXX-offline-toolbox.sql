-- Probe for offline toolbox signing (branch claude/offline-toolbox-signing):
-- sign_toolbox_talk from 20261033000000_offline_toolbox_signing.sql, called on
-- the real database as the QA installer login, then a keyed clock_in on the
-- practice job through the real toolbox gate, and rolled back. Each scenario
-- is one the phone's outbox will produce:
--   * a signature made with no signal, sent later today: filed at the phone's
--     time, and it opens today's clock-in;
--   * the same signature sent twice (a lost reply): ONE row;
--   * a phone clock running ahead: filed at arrival, noted phone_clock_ahead;
--   * a signature that arrives three days late: kept on its own day, noted
--     arrived_late — and it does NOT open today's clock-in;
--   * a talk deleted since the phone kept it: filed with no talk;
--   * nobody else can send it: another person, an anonymous caller, a path
--     in somebody else's folder — all refused;
--   * the crew note (20261033010000) is stored as written and readable by the
--     QA installer and the QA foreman.
-- The QA logins only; job codes and qa.* logins only in the output — the
-- repository and its logs are public.
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/offline-toolbox-signing \
--        -f migrations="supabase/migrations/20261033000000_offline_toolbox_signing.sql supabase/migrations/20261033010000_offline_toolbox_signing_note.sql" \
--        -f probe=scripts/dry-run-probes/pr-XXX-offline-toolbox.sql
do $$
declare
  v_who uuid;
  v_other uuid;
  v_job uuid;
  v_job_code text;
  v_cost_code uuid;
  v_talk uuid;
  v_role text;
  v_today date := (now() at time zone 'America/Denver')::date;
  v_earlier timestamptz;
  v_late_at timestamptz := now() - interval '3 days';
  v_ahead_at timestamptz := now() + interval '1 hour';
  v_row public.toolbox_completions;
  v_again public.toolbox_completions;
  v_late public.toolbox_completions;
  v_ahead public.toolbox_completions;
  v_orphan public.toolbox_completions;
  v_shift public.time_shifts;
  v_n int;
  v_ok boolean;
  v_msg text;
  v_sig text;
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
begin
  -- ---- setup, as the system -------------------------------------------------
  perform pg_temp.dry_run_as_system();
  v_who := pg_temp.dry_run_pick('installer');
  v_other := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();
  select job_code into v_job_code from public.projects where id = v_job;
  select id into v_cost_code from public.cost_codes order by active desc, code limit 1;
  -- Today's talk: the day's own row, or the one the rotation makes for it.
  select id into v_talk from public.safety_talks where talk_date = v_today order by created_at desc limit 1;
  if v_talk is null then
    select (public.get_or_create_toolbox_talk_for_date(v_today)).id into v_talk;
  end if;
  if v_talk is null then
    raise exception 'dry run: there is no toolbox talk for today and the rotation made none (empty library?), so there is nothing to sign.';
  end if;
  -- A clean day for this login, all of it rolled back: no signature of its
  -- own for today (so the clock-in below is opened by the probe's signature
  -- and nothing else), and no open shift.
  delete from public.toolbox_completions
   where profile_id = v_who and (signed_at at time zone 'America/Denver')::date = v_today;
  update public.time_shifts set clock_out_at = now(), status = 'submitted'
   where profile_id = v_who and status = 'open' and clock_out_at is null;
  -- An hour ago, or the start of the company's day if that is closer.
  v_earlier := greatest((v_today::timestamp at time zone 'America/Denver'), now() - interval '1 hour');
  perform pg_temp.dry_run_check('setup: the QA installer, the QA foreman, the practice job and today''s talk',
    v_who is not null and v_other is not null and v_job is not null and v_cost_code is not null and v_talk is not null,
    v_job_code);

  -- ---- the shape on the database -----------------------------------------------
  perform pg_temp.dry_run_check('schema: client_id, phone_signed_at and signed_at_note exist on toolbox_completions',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'toolbox_completions'
      and column_name in ('client_id', 'phone_signed_at', 'signed_at_note')) = 3, null);
  perform pg_temp.dry_run_check('schema: one signature per signer and client id (unique index)',
    exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'toolbox_completions'
      and indexname = 'toolbox_completions_client_id_key' and indexdef ilike '%unique%'), null);
  select exists (
    select 1 from pg_proc p where p.oid = 'public.sign_toolbox_talk(uuid,uuid,uuid,text,text,text,text,timestamptz)'::regprocedure
      and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%')
  ) into v_ok;
  perform pg_temp.dry_run_check('sign_toolbox_talk: security definer with a pinned search_path', v_ok, null);
  perform pg_temp.dry_run_check('sign_toolbox_talk: anon cannot execute it, authenticated can',
    not has_function_privilege('anon', 'public.sign_toolbox_talk(uuid,uuid,uuid,text,text,text,text,timestamptz)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.sign_toolbox_talk(uuid,uuid,uuid,text,text,text,text,timestamptz)', 'EXECUTE'),
    null);

  -- ---- a late signature first: kept on its day, and it opens nothing today -------
  v_role := pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('acting as the QA installer', v_role = 'installer' and current_user = 'authenticated', v_role);
  v_late := public.sign_toolbox_talk(v_c, v_who, v_talk, 'QA Installer',
    v_who::text || '/' || v_talk::text || '/late-' || v_c::text || '-signature.png', null, '{"title":"late"}', v_late_at);
  perform pg_temp.dry_run_check('three days late: kept on the day it was signed, noted arrived_late',
    v_late.signed_at = v_late_at and v_late.signed_at_note = 'arrived_late' and v_late.phone_signed_at = v_late_at,
    coalesce(v_late.signed_at_note, 'no note'));
  perform pg_temp.dry_run_expect_error('three days late: today''s clock-in is still refused on the toolbox gate',
    format('select public.clock_in(p_project_id => %L::uuid, p_cost_code_id => %L::uuid, p_photo => null, p_lat => null, p_lng => null, p_note => %L, p_mode => %L, p_client_id => %L::uuid, p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null)',
      v_job, v_cost_code, 'dry run', 'data', gen_random_uuid()),
    'toolbox talk');

  -- ---- signed offline earlier today, sent now; then sent again ------------------
  v_sig := v_who::text || '/' || v_talk::text || '/' || to_char(v_today, 'YYYY-MM-DD') || '-' || v_a::text || '-signature.png';
  v_row := public.sign_toolbox_talk(v_a, v_who, v_talk, 'QA Installer', v_sig,
    v_who::text || '/' || v_talk::text || '/' || to_char(v_today, 'YYYY-MM-DD') || '-' || v_a::text || '.pdf',
    '{"title":"today"}', v_earlier);
  perform pg_temp.dry_run_check('signed offline earlier today: filed at the phone''s time, no note, on today''s talk, as the signer',
    v_row.id is not null and v_row.signed_at = v_earlier and v_row.signed_at_note is null and v_row.talk_id = v_talk
      and v_row.profile_id = v_who and v_row.client_id = v_a and v_row.signed_via = 'self' and v_row.signed_by is null,
    'completion ' || v_row.id);
  v_again := public.sign_toolbox_talk(v_a, v_who, v_talk, 'Different Words', v_sig, null, '{"title":"again"}', now());
  perform pg_temp.dry_run_check('the same client id again answers with the same signature, unchanged',
    v_again.id = v_row.id and v_again.typed_name = 'QA Installer' and v_again.signed_at = v_earlier, 'completion ' || v_again.id);

  -- ---- a phone clock running ahead --------------------------------------------------
  v_ahead := public.sign_toolbox_talk(v_b, v_who, v_talk, 'QA Installer',
    v_who::text || '/' || v_talk::text || '/ahead-' || v_b::text || '-signature.png', null, '{"title":"ahead"}', v_ahead_at);
  perform pg_temp.dry_run_check('a phone an hour ahead: filed at arrival, noted phone_clock_ahead, its claim kept',
    v_ahead.signed_at = now() and v_ahead.signed_at_note = 'phone_clock_ahead' and v_ahead.phone_signed_at = v_ahead_at,
    coalesce(v_ahead.signed_at_note, 'no note'));

  -- ---- a talk deleted since the phone kept it ----------------------------------------
  v_orphan := public.sign_toolbox_talk(v_d, v_who, gen_random_uuid(), 'QA Installer',
    v_who::text || '/gone/' || v_d::text || '-signature.png', null, '{"title":"gone"}', v_earlier);
  perform pg_temp.dry_run_check('a talk that no longer exists: still filed, with no talk and its snapshot',
    v_orphan.id is not null and v_orphan.talk_id is null and v_orphan.talk_snapshot = '{"title":"gone"}', 'completion ' || v_orphan.id);

  -- ---- only the signer's own folder ------------------------------------------------------
  perform pg_temp.dry_run_expect_error('a signature pointing at somebody else''s folder is refused',
    format('select public.sign_toolbox_talk(%L::uuid, %L::uuid, %L::uuid, %L, %L, null, null, now())',
      gen_random_uuid(), v_who, v_talk, 'QA Installer', v_other::text || '/x/y-signature.png'),
    'own folder');

  -- ---- today's clock-in, through the real keyed clock_in and its toolbox gate -----------
  v_shift := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'dry run', p_mode => 'data', p_client_id => gen_random_uuid(),
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('the offline signature opens today''s clock-in on the practice job',
    v_shift.id is not null and v_shift.project_id = v_job, 'shift ' || v_shift.id);

  -- ---- nobody else can send it ---------------------------------------------------------
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_other);
  perform pg_temp.dry_run_expect_error('another person cannot file a signature as the QA installer',
    format('select public.sign_toolbox_talk(%L::uuid, %L::uuid, %L::uuid, %L, %L, null, null, now())',
      gen_random_uuid(), v_who, v_talk, 'Not Them', v_who::text || '/x/y-signature.png'),
    'someone else');
  perform pg_temp.dry_run_as_system();
  execute 'set local role anon';
  perform pg_temp.dry_run_expect_error('an anonymous caller cannot run sign_toolbox_talk at all',
    format('select public.sign_toolbox_talk(%L::uuid, %L::uuid, %L::uuid, %L, null, null, null, now())',
      gen_random_uuid(), v_who, v_talk, 'Nobody'),
    'permission denied');

  -- ---- the truth, as the system ----------------------------------------------------------
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.toolbox_completions where profile_id = v_who and client_id = v_a;
  perform pg_temp.dry_run_check('one row for the resent signature, not two', v_n = 1, v_n || ' row(s)');
  select count(*) into v_n from public.toolbox_completions
   where profile_id = v_who and (signed_at at time zone 'America/Denver')::date = v_today and client_id is not null;
  perform pg_temp.dry_run_check('today holds the earlier-today, the clock-ahead and the no-talk signatures, not the late one',
    v_n = 3, v_n || ' row(s) for today');
  select count(*) into v_n from public.toolbox_completions where profile_id = v_other and client_id is not null
    and signed_at > now() - interval '1 minute';
  perform pg_temp.dry_run_check('the refused attempt left nothing on the other person''s record', v_n = 0, v_n || ' row(s)');

  -- ---- the crew note ---------------------------------------------------------------------
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-offline-toolbox-signing'
     and audience = array[0,1,2,3] and kind = 'improvement'
     and published_on = date '2026-09-25' and withdrawn_at is null and href = '/safety'
     and length(title_en) > 0 and length(body_en) > 0 and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the crew note is stored as written', v_n = 1,
    format('expected 1 row for all four roles linking to /safety, got %s', v_n));
  perform pg_temp.dry_run_act_as(v_who);
  select count(*) into v_n from public.app_release_notes where id = '2026-09-25-offline-toolbox-signing';
  perform pg_temp.dry_run_check('the QA installer reads the note', v_n = 1, format('expected 1, got %s', v_n));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_other);
  select count(*) into v_n from public.app_release_notes where id = '2026-09-25-offline-toolbox-signing';
  perform pg_temp.dry_run_check('the QA foreman reads the note', v_n = 1, format('expected 1, got %s', v_n));
  perform pg_temp.dry_run_as_system();
end $$;
