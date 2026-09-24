-- Release 1 — the new front door (crew redesign spec, owner-approved
-- 2026-09-23: K-X2 rollout, K1.3 Start day / paid-time rule, K1.5 Prep time).
--
-- Four things, additive only, idempotent throughout:
--
--   1. profiles.ui_design + set_my_ui_design — the person's own choice of
--      front door ("classic" or "new"), the same shape as profiles.language.
--   2. company_settings.new_design_r1_enabled + set_new_design_switch — the
--      owner's master switch per release, and
--      company_settings.paid_time_from_start_day_on + set_paid_time_rule_date —
--      the one date (Q69) from which paid time starts at the Start day tap.
--   3. _toolbox_gate_open — ONE copy of "may this person clock in without
--      today's signature", replacing five inline copies in the clock_in
--      overloads. The bodies below are the latest ones (20260813000000 for
--      the four older overloads, 20260970000000 for the p_mode one), extracted
--      verbatim with ONLY the gate's condition moved into the helper.
--   4. The crew announcements (docs/app-updates.md).
--
-- THE PAID-TIME RULE, plainly: today the first clock-in of the day is refused
-- until the toolbox talk is signed, so the talk is read off the clock. The
-- owner's rule ("paid time starts the moment someone starts the toolbox
-- talk") means clocking in FIRST and signing on the clock. It switches on for
-- everyone at once, on a date the owner picks at the start of a pay period,
-- and NOT before — default off, so nothing changes on deploy. It changes only
-- when a shift may begin; unit work (start_opening_work, start_opening_phase)
-- still refuses until the talk is signed, and no shift on record is touched.
--
-- Coordination note for Release 0 (clock integrity): any later overload of
-- clock_in — a client id, a tap time — keeps its gate as
-- `if not public._toolbox_gate_open(auth.uid()) then raise …`, so the rule
-- cannot be forgotten by one path.
--
-- Timezone: 'America/Denver' spelled out, the company-local day every clock
-- gate has used since 20260813000000.

-- ---------------------------------------------------------------------------
-- 1. profiles.ui_design — the person's own front door
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists ui_design text not null default 'classic';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_ui_design_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_ui_design_check
      check (ui_design in ('classic', 'new'));
  end if;
end;
$$;

comment on column public.profiles.ui_design is
  'Which front door this person chose: ''classic'' or ''new'' (Release 1, crew redesign K-X2). Written only through set_my_ui_design(); the authenticated role holds SELECT but not UPDATE on it, matching language, role and pin_hash. The owner''s master switch (company_settings.new_design_r1_enabled) overrides it app-wide.';

-- Readable, never directly writable (20260729200000 made grants per column).
grant select (ui_design) on table public.profiles to authenticated;
revoke update (ui_design) on table public.profiles from anon, authenticated;

create or replace function public.set_my_ui_design(p_design text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v text := lower(coalesce(trim(p_design), ''));
begin
  if auth.uid() is null then
    raise exception 'sign in before choosing a design' using errcode = '42501';
  end if;

  if v not in ('classic', 'new') then
    raise exception 'design must be classic or new' using errcode = '22023';
  end if;

  update public.profiles
     set ui_design = v, updated_at = now()
   where id = auth.uid();
end;
$$;

comment on function public.set_my_ui_design(text) is
  'Set the calling user''s own front door (''classic'' or ''new''). SECURITY DEFINER and scoped to auth.uid(); the only client-reachable writer of profiles.ui_design (Release 1, K-X2).';

revoke all on function public.set_my_ui_design(text) from public, anon;
grant execute on function public.set_my_ui_design(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The owner's two release settings
-- ---------------------------------------------------------------------------
alter table public.company_settings
  add column if not exists new_design_r1_enabled boolean not null default true;
alter table public.company_settings
  add column if not exists paid_time_from_start_day_on date;

comment on column public.company_settings.new_design_r1_enabled is
  'Release 1 master switch (crew redesign K-X2). False sends everyone back to the classic screens at once, whatever they chose; their choices are kept. Owner-only through set_new_design_switch().';
comment on column public.company_settings.paid_time_from_start_day_on is
  'The company-local day from which the first clock-in of the day no longer waits for the toolbox signature — paid time starts at the Start day tap and the talk is signed on the clock (K1.3, Q69: one date for everyone, picked at the start of a pay period). Null = off, today''s timing applies. Read by _toolbox_gate_open(); never applied to a shift already recorded.';

-- The switch is keyed by release so the next release adds one branch here
-- rather than a second function. Only 'r1' exists today.
create or replace function public.set_new_design_switch(p_release text, p_enabled boolean)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can turn a new design on or off for everyone.'
      using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Say whether the new design is on or off.' using errcode = '22023';
  end if;

  if p_release = 'r1' then
    update company_settings
       set new_design_r1_enabled = p_enabled,
           updated_at = now(),
           updated_by = auth.uid()
     where id = 1
    returning * into v_row;
  else
    raise exception 'Unknown release "%". The only new design so far is r1.', p_release
      using errcode = '22023';
  end if;

  return v_row;
end;
$$;

comment on function public.set_new_design_switch(text, boolean) is
  'Owner only: turn a release''s new design on or off for everyone at once (K-X2). p_release names the release (''r1''); anything else is refused in one plain sentence.';

revoke all on function public.set_new_design_switch(text, boolean) from public, anon;
grant execute on function public.set_new_design_switch(text, boolean) to authenticated;

create or replace function public.set_paid_time_rule_date(p_on date)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can set when paid time starts at Start day.'
      using errcode = '42501';
  end if;
  -- A past date would switch the rule on retroactively for today's shifts
  -- already punched under the old timing — nothing is recalculated, but the
  -- day would then run under two rules. Today or later only; null turns it off.
  if p_on is not null and p_on < (now() at time zone 'America/Denver')::date then
    raise exception 'Pick today or a later day — the rule cannot start in the past.'
      using errcode = '22023';
  end if;

  update company_settings
     set paid_time_from_start_day_on = p_on,
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_paid_time_rule_date(date) is
  'Owner only: the day the paid-time rule starts for everyone (K1.3, Q69), or null to switch it off. Today or later; never rewrites a recorded shift.';

revoke all on function public.set_paid_time_rule_date(date) from public, anon;
grant execute on function public.set_paid_time_rule_date(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. One gate, five doors
-- ---------------------------------------------------------------------------
-- Invoker rights on purpose: the caller reads their OWN toolbox_completions
-- rows and the crew-readable company_settings row, both of which every clock
-- gate already read inline. Nothing is widened by moving the condition here.
create or replace function public._toolbox_gate_open(p_uid uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
      select 1 from toolbox_completions
      where profile_id = p_uid
        and (signed_at at time zone 'America/Denver')::date
          = (now() at time zone 'America/Denver')::date
    )
    or exists (
      select 1 from company_settings
      where id = 1
        and paid_time_from_start_day_on is not null
        and paid_time_from_start_day_on <= (now() at time zone 'America/Denver')::date
    );
$$;

comment on function public._toolbox_gate_open(uuid) is
  'May this person''s shift begin right now? Yes once today''s toolbox talk is on their record, or — from the owner''s date in company_settings.paid_time_from_start_day_on — before it, because paid time then starts at the Start day tap and the talk is signed on the clock (K1.3). Unit work keeps its own signature gate.';

revoke all on function public._toolbox_gate_open(uuid) from public, anon;
grant execute on function public._toolbox_gate_open(uuid) to authenticated;

-- 3a. The five-argument overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3b. The note overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3c. The offline client-id overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if p_client_id is not null then
    select * into v_shift from time_shifts
      where client_id = p_client_id and profile_id = auth.uid();
    if v_shift.id is not null then
      return v_shift;
    end if;
  end if;

  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     client_id)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng, p_client_id)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3d. The offline client-id + note overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid,
  p_note text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if p_client_id is not null then
    select * into v_shift from time_shifts
      where client_id = p_client_id and profile_id = auth.uid();
    if v_shift.id is not null then
      return v_shift;
    end if;
  end if;

  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     client_id, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     p_client_id, nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3e. The note + mode overload (20260970000000) — the one the app calls first.
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text,
  p_mode text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     note, job_mode)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''),
     case when p_mode in ('data', 'tracking') then p_mode else null end)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Tell the crew (docs/app-updates.md)
-- ---------------------------------------------------------------------------
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-new-design-choice','2026-09-23',array[0,1,2,3],'improvement',
 'Try the new Forge — your choice','Prueba el nuevo Forge: tú eliges',
 'Settings has a new "Use the new design" switch. The new design puts your clock, today''s job and your next unit on one Work screen, with a Start day button that opens today''s toolbox talk, a Schedule tab, and a "Clocked in" badge at the top of every screen for breaks and clock-out. Your work saves the same either way, and you can switch back any time.',
 'Ajustes tiene un nuevo interruptor "Usar el nuevo diseño". El nuevo diseño pone tu reloj, el trabajo de hoy y tu siguiente unidad en una sola pantalla de Trabajo, con un botón Iniciar el día que abre la charla de seguridad de hoy, una pestaña Horario y una etiqueta "Entrada" arriba de cada pantalla para descansos y salida. Tu trabajo se guarda igual de las dos formas y puedes volver cuando quieras.',
 '/settings'),
('2026-09-23-prep-time','2026-09-23',array[0,1,2,3],'improvement',
 'Idle time is now called Prep time','El tiempo inactivo ahora se llama Tiempo de preparación',
 'Job work that isn''t on one unit — gathering, hauling, setup, errands, cleanup — is now called Prep time everywhere in the app, with one-tap reasons. Nothing about your recorded hours changed; older records simply show the new name.',
 'El trabajo del proyecto que no es de una sola unidad — juntar material, acarrear, preparar, mandados, limpieza — ahora se llama Tiempo de preparación en toda la app, con razones de un toque. Nada cambió en tus horas registradas; los registros anteriores solo muestran el nuevo nombre.',
 NULL),
('2026-09-23-new-design-owner-switches','2026-09-23',array[3],'improvement',
 'Owner switches for the new design and paid-time start','Interruptores del dueño para el nuevo diseño y el inicio del tiempo pagado',
 'Settings has two owner-only controls: a master switch that turns Release 1''s new design off for everyone at once, and the date from which paid time starts at the Start day tap (before the toolbox talk is signed). The date is off until you set it; pick the start of a pay period.',
 'Ajustes tiene dos controles solo para el dueño: un interruptor general que apaga el nuevo diseño del Lanzamiento 1 para todos de una vez, y la fecha desde la cual el tiempo pagado empieza al tocar Iniciar el día (antes de firmar la charla de seguridad). La fecha está apagada hasta que la fijes; elige el inicio de un periodo de pago.',
 '/settings')
on conflict(id) do nothing;
