-- A hard spend cap on every AI call, enforced in the database.
--
-- WHY THIS EXISTS (docs/ask-infinity-token-free.md, Part 5): the normal AI bill
-- for this company is $17–$115 a month, which is nothing. The problem is that
-- nothing stood in the way of a runaway: no rate limit, no ceiling, no role
-- check. One signed-in account tapping send every ten seconds for a working day
-- is $79; a month of that is $1,661. Nobody would decide to do that, but a
-- leaked login, a retry loop or a stuck client gets there on its own.
--
-- The control is deliberately in SQL rather than in the edge function, for one
-- reason: the runaway scenario is *rapid fire*. A read-then-write check
-- ("count today's calls, then decide") loses exactly when it matters, because
-- fifty concurrent invocations all read the same pre-limit count and all decide
-- yes. So the counter bump and the limit test are ONE statement — an
-- `insert … on conflict do update … where` — which takes a row lock, so
-- concurrent callers serialise and the (N+1)th genuinely sees N.
--
-- Additive and idempotent: every object is `if not exists` / `or replace`, no
-- existing table or policy is touched, and the app degrades to "no cap" if this
-- has not been applied yet (the edge-function guard fails open on a missing RPC
-- so a migration lag can never take the assistant offline).
--
-- Numbered 20260729230000 rather than …210000, which is where this file started.
-- `supabase_migrations.schema_migrations` is keyed by VERSION, not filename, and
-- …210000 is taken by revoke_truncate_from_clients. Sharing a version means
-- `supabase db push` sees the version already applied and skips this file
-- silently — no error, no tables, no reserve function, and a spend cap that
-- looks shipped and is not there. The guard degrades quietly to the local brain
-- when the RPC is missing, so nothing would have complained. See the version
-- uniqueness check in scripts/test_supabase_merge.py.

-- ---------------------------------------------------------------------------
-- Role rank, as its own predicate
-- ---------------------------------------------------------------------------
-- The ladder itself lives in ONE place: public.role_rank(text), added by
-- 20260729200000_profiles_rls_lockdown.sql, which mirrors roleRank() in
-- app/src/lib/install/types.ts including the legacy aliases and the installer
-- floor. A second copy of a ladder that decides who may spend money is a
-- drift risk, so this only does the part role_rank cannot: look up an
-- arbitrary user's role.
--
-- That difference is why my_role_rank() is not enough. The meter judges the
-- user the edge function was called *for*, and it runs on the service-role
-- key, so auth.uid() is null there.
--
-- SECURITY DEFINER with a pinned search_path so it reads profiles regardless
-- of the caller's own RLS. It returns one integer about one account and is
-- readable by signed-in users only.
create or replace function public.ai_role_rank(p_uid uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.role_rank((select role from profiles where id = p_uid));
$$;

-- ---------------------------------------------------------------------------
-- The one settings row the owner can change without a code release
-- ---------------------------------------------------------------------------
create table if not exists ai_spend_limits (
  id integer primary key default 1 check (id = 1),

  -- Per-user, per-day cap on *questions* (the crew-curiosity path). 40 is the
  -- investigation's number: the heaviest plausible real user asks 20 a day, so
  -- this is 2x headroom, and it puts a hard $1.08 lid on what any single
  -- account can spend in a day on Ask.
  per_user_daily_calls integer not null default 40
    check (per_user_daily_calls >= 0),

  -- Company-wide ceiling for the calendar month, in whole cents. $150 covers
  -- the investigation's worst *legitimate* month ($115) with headroom, while
  -- catching the runaway ($1,661) at under a tenth of it.
  monthly_cap_cents integer not null default 15000
    check (monthly_cap_cents >= 0),

  -- Write-time work (extracting a planset, transcribing a memo, synthesising
  -- tips) is owner-triggered, bounded by how much content the company creates,
  -- and produces something reusable and reviewable. Hard-stopping a planset
  -- extraction halfway through a job costs far more than the AI does, so that
  -- traffic gets this multiple of the ceiling before it is refused. Crew
  -- questions get no multiplier at all.
  content_multiplier numeric(4, 2) not null default 2.00
    check (content_multiplier >= 1),

  -- Minimum role for an AI-backed *answer*. Installers keep the free local
  -- brain, which the investigation found answers most real questions anyway.
  min_role text not null default 'foreman'
    check (min_role in ('installer', 'foreman', 'supervisor', 'owner')),

  -- Warn the owner at this percentage of the monthly ceiling, so hitting it is
  -- something they are told about within hours, not something they discover on
  -- a bill.
  alert_at_pct integer not null default 80 check (alert_at_pct between 1 and 100),

  -- Kill switch. false = log usage but never refuse (for an owner who wants the
  -- meter without the brake).
  enforced boolean not null default true,

  -- The company's local day/month boundary. Counting "today" in UTC would reset
  -- a crew member's quota at 5pm their time, mid-afternoon.
  timezone text not null default 'America/Denver',

  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into ai_spend_limits (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Per-user, per-day counter — the rapid-fire brake
-- ---------------------------------------------------------------------------
create table if not exists ai_usage_days (
  user_id uuid not null,
  usage_day date not null,
  calls integer not null default 0,
  cost_micros bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_day)
);

-- ---------------------------------------------------------------------------
-- Company month totals — the money ceiling
-- ---------------------------------------------------------------------------
-- Two figures, and the difference matters. `reserved_micros` is booked BEFORE
-- the paid call using an estimate, and is what the ceiling is tested against;
-- `spent_micros` is the truth, reconciled from the token counts the provider
-- returns. Testing the ceiling against reserved rather than spent is what stops
-- rapid fire slipping through: fifty calls in flight have already booked their
-- estimated cost, so the fifty-first is measured against them, not against a
-- total that will not exist until they all come back.
--
-- Costs are in micro-dollars (millionths). Cents would round the interesting
-- numbers to zero: synthesising tips for one window type costs $0.0009.
create table if not exists ai_spend_months (
  usage_month date primary key,
  calls integer not null default 0,
  reserved_micros bigint not null default 0,
  spent_micros bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The audit log: who, which function, when, tokens, cost
-- ---------------------------------------------------------------------------
-- Deliberately NOT a foreign key to profiles: this is an audit trail that must
-- survive a crew member being removed, and adding a reference would take a lock
-- on a table another change is reworking.
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  function_name text not null,
  -- 'question' = read time, a person asking out of curiosity, unbounded and
  -- repetitive. 'content' = write time, owner-triggered, produces something
  -- reusable. They get different treatment; see content_multiplier above.
  kind text not null default 'question' check (kind in ('question', 'content')),
  provider text,
  model text,
  outcome text not null check (
    outcome in (
      'allowed',
      'denied_role',
      'denied_user_daily',
      'denied_monthly_cap',
      'released'
    )
  ),
  input_tokens integer,
  output_tokens integer,
  estimate_micros bigint not null default 0,
  cost_micros bigint not null default 0,
  usage_day date not null,
  usage_month date not null,
  settled_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_month_idx
  on ai_usage_events (usage_month, created_at desc);
create index if not exists ai_usage_events_user_day_idx
  on ai_usage_events (user_id, usage_day);

-- ---------------------------------------------------------------------------
-- Ceiling alerts — fired once per month per threshold
-- ---------------------------------------------------------------------------
create table if not exists ai_spend_alerts (
  id uuid primary key default gen_random_uuid(),
  usage_month date not null,
  -- 'warn' = crossed alert_at_pct of the ceiling. 'cap' = the ceiling is now
  -- refusing calls.
  level text not null check (level in ('warn', 'cap')),
  reserved_micros bigint not null,
  cap_micros bigint not null,
  created_at timestamptz not null default now(),
  -- One alert per level per month: the owner is told once, not on every call.
  unique (usage_month, level)
);

-- ---------------------------------------------------------------------------
-- Reserve: the atomic gate. Called immediately before any paid AI call.
-- ---------------------------------------------------------------------------
-- Returns a jsonb verdict:
--   { allowed, reason, reservation_id, note, calls_today, daily_limit,
--     reserved_micros, cap_micros, alert }
--
-- `reason` is null when allowed, else 'role' | 'user_daily' | 'monthly_cap'.
-- `alert` is 'warn' | 'cap' | null and is non-null only on the single call that
-- crosses that threshold, so the caller can notify the owner exactly once.
create or replace function public.ai_spend_reserve(
  p_user_id uuid,
  p_function text,
  p_kind text default 'question',
  p_estimate_micros bigint default 0,
  p_provider text default null,
  p_model text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg ai_spend_limits;
  v_day date;
  v_month date;
  v_kind text := case when p_kind = 'content' then 'content' else 'question' end;
  v_estimate bigint := greatest(0, coalesce(p_estimate_micros, 0));
  v_rank integer;
  v_min_rank integer;
  v_calls integer;
  v_cap_micros bigint;
  v_effective_cap bigint;
  v_reserved bigint;
  v_event_id uuid;
  v_alert text := null;
  v_counted boolean := false;

  -- Who to tell when a threshold is crossed. Resolved here rather than in the
  -- edge function because this is already SECURITY DEFINER and can read
  -- profiles without depending on their RLS policies (which are being reworked
  -- separately) — and it saves the guard a round trip on the one call that has
  -- just been told there is a problem.
  v_owner_ids jsonb := '[]'::jsonb;
begin
  select * into v_cfg from ai_spend_limits where id = 1;
  if not found then
    insert into ai_spend_limits (id) values (1)
      on conflict (id) do nothing;
    select * into v_cfg from ai_spend_limits where id = 1;
  end if;

  v_day := (now() at time zone v_cfg.timezone)::date;
  v_month := date_trunc('month', (now() at time zone v_cfg.timezone))::date;

  v_min_rank := case v_cfg.min_role
    when 'owner' then 3
    when 'supervisor' then 2
    when 'foreman' then 1
    else 0
  end;

  v_cap_micros := v_cfg.monthly_cap_cents::bigint * 10000;
  v_effective_cap := case
    when v_kind = 'content'
      then (v_cap_micros * v_cfg.content_multiplier)::bigint
    else v_cap_micros
  end;

  -- (1) Role floor. Only applies to `question` traffic and only to a real end
  -- user: `content` jobs and service-role/webhook callers (null user) carry no
  -- role and are gated by the ceiling alone.
  if v_cfg.enforced and v_kind = 'question' and p_user_id is not null then
    v_rank := ai_role_rank(p_user_id);
    if v_rank < v_min_rank then
      insert into ai_usage_events (
        user_id, function_name, kind, provider, model, outcome,
        estimate_micros, usage_day, usage_month
      ) values (
        p_user_id, p_function, v_kind, p_provider, p_model, 'denied_role',
        0, v_day, v_month
      ) returning id into v_event_id;
      return jsonb_build_object(
        'allowed', false,
        'reason', 'role',
        'reservation_id', v_event_id,
        'min_role', v_cfg.min_role
      );
    end if;
  end if;

  -- (2) Per-user daily count. ONE statement: the upsert locks the day row, so a
  -- burst of concurrent callers queues on it and each one tests the limit
  -- against the value the previous caller actually committed. When the guard
  -- fails no row comes back, which IS the refusal — there is no window between
  -- reading the count and writing it.
  if v_cfg.enforced and v_kind = 'question' and p_user_id is not null then
    insert into ai_usage_days (user_id, usage_day, calls)
    values (p_user_id, v_day, 1)
    on conflict (user_id, usage_day) do update
      set calls = ai_usage_days.calls + 1,
          updated_at = now()
      where ai_usage_days.calls < v_cfg.per_user_daily_calls
    returning calls into v_calls;

    if v_calls is null then
      insert into ai_usage_events (
        user_id, function_name, kind, provider, model, outcome,
        estimate_micros, usage_day, usage_month
      ) values (
        p_user_id, p_function, v_kind, p_provider, p_model, 'denied_user_daily',
        0, v_day, v_month
      ) returning id into v_event_id;
      return jsonb_build_object(
        'allowed', false,
        'reason', 'user_daily',
        'reservation_id', v_event_id,
        'daily_limit', v_cfg.per_user_daily_calls
      );
    end if;
    v_counted := true;
  elsif p_user_id is not null then
    -- Not gated, but still metered, so the owner screen shows every caller.
    insert into ai_usage_days (user_id, usage_day, calls)
    values (p_user_id, v_day, 1)
    on conflict (user_id, usage_day) do update
      set calls = ai_usage_days.calls + 1, updated_at = now()
    returning calls into v_calls;
    v_counted := true;
  end if;

  -- (3) Company monthly ceiling, tested against money already booked. Same
  -- single-statement pattern, so the ceiling holds under a burst too.
  if v_cfg.enforced then
    insert into ai_spend_months (usage_month, calls, reserved_micros)
    values (v_month, 1, v_estimate)
    on conflict (usage_month) do update
      set calls = ai_spend_months.calls + 1,
          reserved_micros = ai_spend_months.reserved_micros + v_estimate,
          updated_at = now()
      where ai_spend_months.reserved_micros < v_effective_cap
    returning reserved_micros into v_reserved;
  else
    insert into ai_spend_months (usage_month, calls, reserved_micros)
    values (v_month, 1, v_estimate)
    on conflict (usage_month) do update
      set calls = ai_spend_months.calls + 1,
          reserved_micros = ai_spend_months.reserved_micros + v_estimate,
          updated_at = now()
    returning reserved_micros into v_reserved;
  end if;

  if v_reserved is null then
    -- Ceiling refused. Give the user back the day-count we just took: their
    -- own quota should not be burned by the company running out of budget.
    if v_counted then
      update ai_usage_days
         set calls = greatest(0, calls - 1), updated_at = now()
       where user_id = p_user_id and usage_day = v_day;
    end if;

    insert into ai_usage_events (
      user_id, function_name, kind, provider, model, outcome,
      estimate_micros, usage_day, usage_month
    ) values (
      p_user_id, p_function, v_kind, p_provider, p_model, 'denied_monthly_cap',
      0, v_day, v_month
    ) returning id into v_event_id;

    insert into ai_spend_alerts (usage_month, level, reserved_micros, cap_micros)
    select v_month, 'cap',
           coalesce((select reserved_micros from ai_spend_months where usage_month = v_month), 0),
           v_cap_micros
    on conflict (usage_month, level) do nothing
    returning level into v_alert;

    if v_alert is not null then
      select coalesce(jsonb_agg(id), '[]'::jsonb) into v_owner_ids
        from profiles where role in ('owner', 'big_boss', 'supervisor', 'admin');
    end if;

    return jsonb_build_object(
      'allowed', false,
      'reason', 'monthly_cap',
      'reservation_id', v_event_id,
      'cap_micros', v_cap_micros,
      'alert', v_alert,
      'alert_profile_ids', v_owner_ids
    );
  end if;

  -- (4) Approaching the ceiling: raise the warn alert exactly once.
  if v_cap_micros > 0
     and v_reserved >= (v_cap_micros * v_cfg.alert_at_pct) / 100 then
    insert into ai_spend_alerts (usage_month, level, reserved_micros, cap_micros)
    values (v_month, 'warn', v_reserved, v_cap_micros)
    on conflict (usage_month, level) do nothing
    returning level into v_alert;

    if v_alert is not null then
      select coalesce(jsonb_agg(id), '[]'::jsonb) into v_owner_ids
        from profiles where role in ('owner', 'big_boss', 'supervisor', 'admin');
    end if;
  end if;

  insert into ai_usage_events (
    user_id, function_name, kind, provider, model, outcome,
    estimate_micros, usage_day, usage_month
  ) values (
    p_user_id, p_function, v_kind, p_provider, p_model, 'allowed',
    v_estimate, v_day, v_month
  ) returning id into v_event_id;

  return jsonb_build_object(
    'allowed', true,
    'reason', null,
    'reservation_id', v_event_id,
    'calls_today', v_calls,
    'daily_limit', v_cfg.per_user_daily_calls,
    'reserved_micros', v_reserved,
    'cap_micros', v_cap_micros,
    'alert', v_alert,
    'alert_profile_ids', v_owner_ids
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle: replace the estimate with what the provider actually charged
-- ---------------------------------------------------------------------------
create or replace function public.ai_spend_settle(
  p_event_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_micros bigint,
  p_model text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event ai_usage_events;
  v_actual bigint := greatest(0, coalesce(p_cost_micros, 0));
begin
  select * into v_event from ai_usage_events
   where id = p_event_id and outcome = 'allowed' and settled_at is null
   for update;
  if not found then return; end if;

  update ai_usage_events
     set input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         cost_micros = v_actual,
         model = coalesce(p_model, model),
         settled_at = now()
   where id = p_event_id;

  -- Swap the reservation for the real figure, and add the real figure to the
  -- running truth.
  update ai_spend_months
     set reserved_micros =
           greatest(0, reserved_micros - v_event.estimate_micros + v_actual),
         spent_micros = spent_micros + v_actual,
         updated_at = now()
   where usage_month = v_event.usage_month;

  if v_event.user_id is not null then
    update ai_usage_days
       set cost_micros = cost_micros + v_actual, updated_at = now()
     where user_id = v_event.user_id and usage_day = v_event.usage_day;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Release: the call never happened, or the provider failed
-- ---------------------------------------------------------------------------
-- `p_refund_call` is the important argument. Money is ALWAYS refunded — an
-- attempt that never reached the provider cost nothing. The call *count* is
-- refunded only when we never tried (e.g. the API key is not configured). A
-- provider failure keeps the count, because a client stuck in a retry loop is
-- precisely the runaway this table exists to stop, and a loop that always fails
-- must still run out of quota.
create or replace function public.ai_spend_release(
  p_event_id uuid,
  p_reason text default null,
  p_refund_call boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event ai_usage_events;
begin
  select * into v_event from ai_usage_events
   where id = p_event_id and outcome = 'allowed' and settled_at is null
   for update;
  if not found then return; end if;

  update ai_usage_events
     set outcome = 'released',
         release_reason = p_reason,
         cost_micros = 0,
         settled_at = now()
   where id = p_event_id;

  update ai_spend_months
     set reserved_micros = greatest(0, reserved_micros - v_event.estimate_micros),
         calls = case when p_refund_call then greatest(0, calls - 1) else calls end,
         updated_at = now()
   where usage_month = v_event.usage_month;

  if p_refund_call and v_event.user_id is not null then
    update ai_usage_days
       set calls = greatest(0, calls - 1), updated_at = now()
     where user_id = v_event.user_id and usage_day = v_event.usage_day;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner screen: one read, one write
-- ---------------------------------------------------------------------------
-- Both read display names, so both are SECURITY DEFINER and check the caller's
-- rank themselves rather than leaning on the profiles policies.
--
-- The /ai-spend route is owner-only today (see app/src/lib/nav.ts). The read
-- floor here is deliberately one notch looser at supervisor, so the office can
-- be shown the meter later by changing one line of nav rather than shipping a
-- migration. Changing the numbers stays owner-only either way.
create or replace function public.ai_spend_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg ai_spend_limits;
  v_month date;
  v_day date;
  v_rank integer := ai_role_rank(auth.uid());
begin
  if v_rank < 2 then
    raise exception 'ai_spend_overview: supervisor or above only';
  end if;

  select * into v_cfg from ai_spend_limits where id = 1;
  v_month := date_trunc('month', (now() at time zone coalesce(v_cfg.timezone, 'UTC')))::date;
  v_day := (now() at time zone coalesce(v_cfg.timezone, 'UTC'))::date;

  return jsonb_build_object(
    'can_edit', v_rank >= 3,
    'limits', jsonb_build_object(
      'per_user_daily_calls', v_cfg.per_user_daily_calls,
      'monthly_cap_cents', v_cfg.monthly_cap_cents,
      'content_multiplier', v_cfg.content_multiplier,
      'min_role', v_cfg.min_role,
      'alert_at_pct', v_cfg.alert_at_pct,
      'enforced', v_cfg.enforced,
      'timezone', v_cfg.timezone,
      'updated_at', v_cfg.updated_at
    ),
    'month', jsonb_build_object(
      'usage_month', v_month,
      'calls', coalesce((select calls from ai_spend_months where usage_month = v_month), 0),
      'spent_micros', coalesce((select spent_micros from ai_spend_months where usage_month = v_month), 0),
      'reserved_micros', coalesce((select reserved_micros from ai_spend_months where usage_month = v_month), 0),
      'cap_micros', v_cfg.monthly_cap_cents::bigint * 10000
    ),
    'people', coalesce((
      select jsonb_agg(row_to_json(t))
      from (
        select
          e.user_id,
          coalesce(p.display_name, 'Removed user') as display_name,
          coalesce(p.role, 'unknown') as role,
          count(*) filter (where e.outcome = 'allowed') as calls,
          coalesce(sum(e.cost_micros), 0) as cost_micros,
          count(*) filter (where e.outcome like 'denied%') as blocked,
          coalesce((
            select d.calls from ai_usage_days d
             where d.user_id = e.user_id and d.usage_day = v_day
          ), 0) as calls_today
        from ai_usage_events e
        left join profiles p on p.id = e.user_id
        where e.usage_month = v_month
        group by e.user_id, p.display_name, p.role
        order by coalesce(sum(e.cost_micros), 0) desc,
                 count(*) filter (where e.outcome = 'allowed') desc
        limit 25
      ) t
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(row_to_json(f))
      from (
        select function_name,
               count(*) filter (where outcome = 'allowed') as calls,
               coalesce(sum(cost_micros), 0) as cost_micros
          from ai_usage_events
         where usage_month = v_month
         group by function_name
         order by coalesce(sum(cost_micros), 0) desc
      ) f
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(row_to_json(a))
      from (
        select level, reserved_micros, cap_micros, created_at
          from ai_spend_alerts
         where usage_month = v_month
         order by created_at desc
      ) a
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.ai_spend_set_limits(
  p_per_user_daily_calls integer default null,
  p_monthly_cap_cents integer default null,
  p_min_role text default null,
  p_enforced boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  if ai_role_rank(auth.uid()) < 3 then
    raise exception 'ai_spend_set_limits: owner only';
  end if;
  if p_min_role is not null
     and p_min_role not in ('installer', 'foreman', 'supervisor', 'owner') then
    raise exception 'ai_spend_set_limits: unknown role %', p_min_role;
  end if;

  update ai_spend_limits
     set per_user_daily_calls =
           coalesce(greatest(0, p_per_user_daily_calls), per_user_daily_calls),
         monthly_cap_cents =
           coalesce(greatest(0, p_monthly_cap_cents), monthly_cap_cents),
         min_role = coalesce(p_min_role, min_role),
         enforced = coalesce(p_enforced, enforced),
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1;

  -- Raising the ceiling must clear the block immediately, so the 'cap' alert
  -- for this month is retired and can fire again if the new ceiling is reached.
  select timezone into v_tz from ai_spend_limits where id = 1;
  delete from ai_spend_alerts
   where level = 'cap'
     and usage_month = date_trunc('month', (now() at time zone coalesce(v_tz, 'UTC')))::date
     and cap_micros < (select monthly_cap_cents::bigint * 10000 from ai_spend_limits where id = 1);

  return public.ai_spend_overview();
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
-- Nothing here is client-writable, by anyone, ever. The owner screen reads
-- through ai_spend_overview() rather than the tables, so direct SELECT is only
-- defence in depth: office roles (supervisor+) may read, everyone else sees
-- nothing, and every write goes through the RPCs on the service-role key.
alter table ai_spend_limits enable row level security;
alter table ai_usage_days enable row level security;
alter table ai_spend_months enable row level security;
alter table ai_usage_events enable row level security;
alter table ai_spend_alerts enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ai_spend_limits', 'ai_usage_days', 'ai_spend_months',
    'ai_usage_events', 'ai_spend_alerts'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_office', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (public.ai_role_rank(auth.uid()) >= 2)',
      t || '_select_office', t
    );
  end loop;
end;
$$;

-- Table privileges are revoked from BOTH client roles before anything is
-- granted, and `authenticated` is the one that matters. This project's default
-- privileges hand every new table in `public` the full set — insert, update,
-- delete, trigger, references — to `authenticated`, so adding `grant select`
-- without revoking first leaves a signed-in crew member holding write
-- privileges on the company's spend counters. Nothing exploits that today
-- because RLS is on and the only policy is a SELECT one, but that makes RLS the
-- single thing standing between a crew member and rewriting their own usage.
-- One permissive policy added later, by anybody, and it becomes a write hole.
-- Verified against the live catalog: before this revoke, all five tables listed
-- INSERT/UPDATE/DELETE/TRIGGER/REFERENCES for `authenticated`.
revoke all on ai_spend_limits, ai_usage_days, ai_spend_months,
              ai_usage_events, ai_spend_alerts from anon, authenticated;
grant select on ai_spend_limits, ai_usage_days, ai_spend_months,
               ai_usage_events, ai_spend_alerts to authenticated;
grant all on ai_spend_limits, ai_usage_days, ai_spend_months,
             ai_usage_events, ai_spend_alerts to service_role;

-- THREE separate things hand out EXECUTE on a new function here, and all three
-- have to be undone before granting deliberately: Postgres grants it to PUBLIC,
-- and this project's default privileges grant it to `anon` AND `authenticated`.
-- `revoke … from public` alone leaves both explicit role grants in place —
-- verified against the live catalog, which is why both are named.
--
-- `authenticated` matters most, and it is not a theoretical concern. Left in
-- place, any signed-in crew member could call ai_spend_reserve directly with
-- somebody else's user id and burn their daily quota, or book millions of
-- micro-dollars against the company ceiling and take the assistant off the air
-- for everyone. They could also call ai_spend_release to hand the reservations
-- back. So the meter is revoked from every client role and re-granted only to
-- service_role — an edge function is the only thing that may move it.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.ai_role_rank(uuid)',
    'public.ai_spend_reserve(uuid, text, text, bigint, text, text)',
    'public.ai_spend_settle(uuid, integer, integer, bigint, text)',
    'public.ai_spend_release(uuid, text, boolean)',
    'public.ai_spend_overview()',
    'public.ai_spend_set_limits(integer, integer, text, boolean)'
  ] loop
    execute format('revoke all on function %s from public', sig);
    execute format('revoke all on function %s from anon', sig);
    execute format('revoke all on function %s from authenticated', sig);
  end loop;
end;
$$;

-- The two screen RPCs are for signed-in users and check the caller's rank
-- internally; ai_role_rank is the predicate the RLS policies call, so it has to
-- be reachable by a signed-in reader.
grant execute on function public.ai_role_rank(uuid) to authenticated, service_role;
grant execute on function
  public.ai_spend_reserve(uuid, text, text, bigint, text, text) to service_role;
grant execute on function
  public.ai_spend_settle(uuid, integer, integer, bigint, text) to service_role;
grant execute on function
  public.ai_spend_release(uuid, text, boolean) to service_role;
grant execute on function public.ai_spend_overview() to authenticated, service_role;
grant execute on function
  public.ai_spend_set_limits(integer, integer, text, boolean)
  to authenticated, service_role;
