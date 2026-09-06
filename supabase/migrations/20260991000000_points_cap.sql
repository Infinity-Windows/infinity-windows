-- Points cap: the ledger stops taking writes from a phone, and the Education
-- quizzes stop paying for the same term twice (owner's ask, 2026-09-05: "my
-- crew is racking up points on repeating quizzes, we need to make sure there
-- is a cap to these … if its real learning great, but it needs to be new
-- content").
--
-- ORDERING: this file must apply AFTER 20260990000000 (pdf receipts). Nothing
-- in it depends on that migration; the number is simply later, and the
-- migration runner applies these in name order.
--
-- WHAT WENT WRONG. `points_ledger` has had exactly one policy since the day it
-- was created (20260717004000, re-stated with the partner guard by THE WALL,
-- 20260950000000): "authenticated full access", FOR ALL, `using (true)`. So
-- every signed-in phone could INSERT any row it liked into the company's
-- scoreboard. It did not even take a determined person: the Education Quiz tab
-- wrote its own points straight from the browser after every round of five
-- random glossary terms, and put an "Another round" button underneath. No cap,
-- no ref, no record of which terms were asked — so the same five terms paid
-- again every time somebody tapped it. The read-only ledger shows two profiles
-- who between them filed hundreds of quiz rows in a single day — a year's worth
-- of points each, every row with a null ref.
--
-- The video quizzes were never part of this and are untouched: submit_video_
-- quiz (20260962000000) already scores server-side, pays only on a FIRST pass,
-- and stamps its rows 'video_quiz:<id>'.
--
-- TWO RULES, and this migration is both of them.
--
--   1. SERVER-ONLY WRITES. points_ledger keeps its read (the leaderboard is
--      everybody's, unchanged) and loses every write policy. Three SECURITY
--      DEFINER functions below are the only doors: award_install_points,
--      resolve_install_points, award_education_quiz. A unique partial index
--      makes "one install payment per person per unit per kind" structural
--      rather than a promise a function makes. It is scoped to the five
--      install kinds on purpose — summon points share this table and are
--      allowed to land twice on one ref.
--
--   2. NEW CONTENT ONLY. A glossary term pays the FIRST time a person answers
--      it right and never again; the install-sequence quiz pays once. That is
--      education_credits, and it makes the lifetime ceiling arithmetic:
--      105 terms + 1 sequence, 10 points each = 1,060 points from the Learn
--      tab, ever. Practising stays free and unlimited — "Another round" is
--      still there, it just stops paying for ground already covered.
--
-- HONEST ABOUT WHAT THIS DOES NOT DO. The Education quizzes are generated in
-- the browser from a client-side glossary, so unlike the video quiz the server
-- cannot re-score them: it is still the phone that says which terms it got
-- right. That is fine, and it is why the cap is the fix rather than the
-- scoring. A person who lies about every answer reaches 1,060 sooner and then
-- stops, forever. Before today one person could pass that ceiling ten times
-- over in an afternoon and keep going. The server's own list is what makes the ceiling real — a made-up key
-- pays nothing, so the ceiling cannot be walked around by inventing terms.
--
-- NOTHING IS DELETED. The farmed rows are voided with a reason written beside
-- them, so the history still says what happened and to whom. Nobody is handed
-- replacement credit either: the terms are all still there to be earned, by
-- doing the quiz.

-- ---------------------------------------------------------------------------
-- 1. points_ledger: a reason column, and the two backfills
-- ---------------------------------------------------------------------------

alter table points_ledger add column if not exists void_reason text;
alter table points_ledger add column if not exists detail jsonb;

comment on column points_ledger.void_reason is
  'Why a row was voided, in a sentence, when something other than a QC callback voided it. Written by the 2026-09-05 backfill in this migration and by resolve_install_points; null on every row that was never voided.';
comment on column points_ledger.detail is
  'Free-form receipt for a row that stands for more than one thing — today only the Education quiz round, which carries {"keys": [...]}: the item keys that were newly credited and paid for in that round. Never read back for a total; points is the number that counts.';

-- BACKFILL A (the incident). Every client-inserted Education quiz row — kind
-- 'quiz' with a null ref — is voided. Video quiz rows carry a
-- 'video_quiz:<id>' ref and are therefore not touched by this. Idempotent:
-- after the first run nothing matches, because the rows are already void.
update points_ledger
   set status = 'void',
       void_reason = 'education quiz rows before the new-content rule (2026-09-05)'
 where kind = 'quiz'
   and ref is null
   and status <> 'void';

-- BACKFILL B (making the index creatable, and correcting the same fault).
-- The install path awards through an offline outbox that retries, and until
-- today a retry that got as far as the award and then failed on the media
-- could pay the same install twice. Keep the FIRST row for each
-- (person, ref, kind) and void the rest — a second payment for one install was
-- never earned, and the unique index below cannot be built while one exists.
--
-- ONLY THE INSTALL KINDS, and this restriction is load-bearing. A summon is
-- allowed to be answered twice on one ref: answer_summon (20260963000000)
-- writes a 'summon_answer' row, cancel_summon_help (20260919000000) writes a
-- separate 'summon_answer_canceled' row of -10 rather than voiding the first,
-- and a helper who cancels may re-join the same call — which writes a second
-- 'summon_answer' for the same (person, summon, kind), legitimately. Voiding
-- that second row would leave the -10 standing beside it and quietly dock
-- somebody 10 points for help they actually gave. The kinds listed here are
-- exactly the ones award_install_points writes and clamps.
with ranked as (
  select l.id,
         row_number() over (
           partition by l.profile_id, l.ref, l.kind
           order by l.created_at, l.id
         ) as rn
    from points_ledger l
   where l.ref is not null
     and l.status <> 'void'
     and l.kind in ('install', 'par', 'photos', 'teach', 'quality')
)
update points_ledger p
   set status = 'void',
       void_reason = coalesce(
         p.void_reason,
         'the same award landed twice for one unit — the first one stands (2026-09-05)'
       )
  from ranked r
 where p.id = r.id
   and r.rn > 1;

-- THE STRUCTURAL GUARANTEE. One INSTALL payment per person, per ref, per kind.
-- Partial on three counts:
--
--   * a null ref is outside it (the voided history above, and nothing new
--     writes one);
--   * a VOIDED row is outside it, so voiding a duplicate actually frees the
--     slot — and so a unit that was undone and genuinely installed again can
--     be paid a second time. award_install_points is the thing that tells
--     those two apart, by the install event it is paying for;
--   * and only the five kinds award_install_points writes are in it at all.
--
-- That last one is not tidiness. 'summon_answer' rides the same table with a
-- summon id for a ref, and answering a summon twice — cancel, then re-join —
-- is a supported flow that writes the pair twice on purpose. A repo-wide index
-- here would abort answer_summon with a raw unique-violation and leave a
-- helper unable to re-join a call at all. The kind list must stay in step with
-- the CASE in award_install_points below; scripts/test_schema_verify.py pins
-- the two together.
--
-- Dropped by its old name first, so a database that already took the earlier,
-- unscoped shape of this index picks up the predicate rather than skipping it
-- on `if not exists`.
drop index if exists points_ledger_one_award_per_ref_kind;
create unique index if not exists points_ledger_one_install_award_per_ref_kind
  on points_ledger (profile_id, ref, kind)
  where ref is not null
    and status <> 'void'
    and kind in ('install', 'par', 'photos', 'teach', 'quality');

-- ---------------------------------------------------------------------------
-- 2. points_ledger: reads stay, writes go
-- ---------------------------------------------------------------------------
-- The old policy was FOR ALL. Everyone who could read the leaderboard could
-- also write it. Reads are unchanged — every non-partner crew member still
-- sees every row, because the Points page's team ranking is assembled in the
-- browser from exactly that (lib/points.ts getPointsLeaderboard) and always
-- has been. Only the writing half is taken away.
drop policy if exists "authenticated full access" on points_ledger;
drop policy if exists "points_ledger read" on points_ledger;
create policy "points_ledger read" on points_ledger
  for select to authenticated
  using (not public.is_partner_user());

-- Belt and braces: with no write POLICY a write already fails, but revoking
-- the table-level grants means a phone cannot even ask.
--
-- This does NOT shut the doors that are supposed to be open. A SECURITY
-- DEFINER function runs as the function's owner, which owns this table, so
-- submit_video_quiz (20260962000000) keeps writing its first-pass row exactly
-- as it did, and so do the three functions below. The grant that just went
-- away is the one a browser was using.
revoke insert, update, delete on table points_ledger from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. education_items — the server's own list of what can pay
-- ---------------------------------------------------------------------------
-- The glossary itself lives in the app (app/src/lib/glossary.ts, 105 terms):
-- it is content a person reads, and it belongs where it is. What has to live
-- here is the KEY LIST, because a key the server does not recognise must pay
-- nothing — otherwise the ceiling is imaginary and a phone earns forever by
-- inventing term ids. scripts/test_schema_verify.py asserts this seed and
-- glossary.ts's TERMS agree exactly, so adding a term to one without the other
-- is a red build rather than a silent hole.
create table if not exists education_items (
  key text primary key,
  kind text not null check (kind in ('term', 'sequence')),
  points int not null default 10 check (points > 0)
);

comment on table education_items is
  'Every Learn-tab item that can ever pay points, and what it pays. One row per glossary term (key ''term:<glossary id>'') plus the install-sequence quiz (''seq:install''). Read-only to the app; award_education_quiz is the only thing that consults it. The row count IS the lifetime ceiling: sum(points) is the most any one person can earn from the Learn tab, ever.';

alter table education_items enable row level security;

drop policy if exists "education_items read" on education_items;
create policy "education_items read" on education_items
  for select to authenticated
  using (not public.is_partner_user());

revoke insert, update, delete on table education_items from anon, authenticated;

insert into education_items (key, kind, points) values
  ('term:frame', 'term', 10),
  ('term:jamb', 'term', 10),
  ('term:head', 'term', 10),
  ('term:sill', 'term', 10),
  ('term:mullion', 'term', 10),
  ('term:muntin', 'term', 10),
  ('term:sash', 'term', 10),
  ('term:thermalbreak', 'term', 10),
  ('term:extrusion', 'term', 10),
  ('term:anodized', 'term', 10),
  ('term:kynar', 'term', 10),
  ('term:weep', 'term', 10),
  ('term:flange', 'term', 10),
  ('term:igu', 'term', 10),
  ('term:lowe', 'term', 10),
  ('term:argon', 'term', 10),
  ('term:spacer', 'term', 10),
  ('term:laminated', 'term', 10),
  ('term:tempered', 'term', 10),
  ('term:annealed', 'term', 10),
  ('term:glazingbead', 'term', 10),
  ('term:setblock', 'term', 10),
  ('term:edgedelete', 'term', 10),
  ('term:vt', 'term', 10),
  ('term:shgc', 'term', 10),
  ('term:ufactor', 'term', 10),
  ('term:backerrod', 'term', 10),
  ('term:sealant', 'term', 10),
  ('term:sillpan', 'term', 10),
  ('term:flashtape', 'term', 10),
  ('term:paperflash', 'term', 10),
  ('term:wrb', 'term', 10),
  ('term:enddam', 'term', 10),
  ('term:bondbreaker', 'term', 10),
  ('term:tooling', 'term', 10),
  ('term:fillet', 'term', 10),
  ('term:capbead', 'term', 10),
  ('term:compatibility', 'term', 10),
  ('term:drainage', 'term', 10),
  ('term:ro', 'term', 10),
  ('term:kingstud', 'term', 10),
  ('term:jackstud', 'term', 10),
  ('term:header', 'term', 10),
  ('term:shim', 'term', 10),
  ('term:plumb', 'term', 10),
  ('term:level', 'term', 10),
  ('term:square', 'term', 10),
  ('term:reveal', 'term', 10),
  ('term:racking', 'term', 10),
  ('term:deflection', 'term', 10),
  ('term:embed', 'term', 10),
  ('term:substrate', 'term', 10),
  ('term:panicbar', 'term', 10),
  ('term:closer', 'term', 10),
  ('term:threshold', 'term', 10),
  ('term:strike', 'term', 10),
  ('term:hinge', 'term', 10),
  ('term:roller', 'term', 10),
  ('term:lockrail', 'term', 10),
  ('term:astragal', 'term', 10),
  ('term:sweep', 'term', 10),
  ('term:operator', 'term', 10),
  ('term:limitdevice', 'term', 10),
  ('term:balance', 'term', 10),
  ('term:weatherstrip', 'term', 10),
  ('term:storefront', 'term', 10),
  ('term:curtainwall', 'term', 10),
  ('term:windowwall', 'term', 10),
  ('term:punched', 'term', 10),
  ('term:ribbon', 'term', 10),
  ('term:stickbuilt', 'term', 10),
  ('term:unitized', 'term', 10),
  ('term:pressureplate', 'term', 10),
  ('term:snapcover', 'term', 10),
  ('term:subsill', 'term', 10),
  ('term:receptor', 'term', 10),
  ('term:entrance', 'term', 10),
  ('term:transom', 'term', 10),
  ('term:dryfit', 'term', 10),
  ('term:fullbed', 'term', 10),
  ('term:faceseal', 'term', 10),
  ('term:barrier', 'term', 10),
  ('term:blockframe', 'term', 10),
  ('term:flangeinstall', 'term', 10),
  ('term:brickmold', 'term', 10),
  ('term:furring', 'term', 10),
  ('term:anchorschedule', 'term', 10),
  ('term:perimeterfasten', 'term', 10),
  ('term:staging', 'term', 10),
  ('term:aframe', 'term', 10),
  ('term:liftgear', 'term', 10),
  ('term:fgia', 'term', 10),
  ('term:astme1105', 'term', 10),
  ('term:nfrc', 'term', 10),
  ('term:egress', 'term', 10),
  ('term:safetyglazing', 'term', 10),
  ('term:fallprotection', 'term', 10),
  ('term:dp', 'term', 10),
  ('term:airinfiltration', 'term', 10),
  ('term:waterpen', 'term', 10),
  ('term:mockup', 'term', 10),
  ('term:shopdrawings', 'term', 10),
  ('term:submittal', 'term', 10),
  ('term:hwschedule', 'term', 10),
  ('term:punchlist', 'term', 10),
  ('seq:install', 'sequence', 10)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. education_credits — what a person has already been paid for
-- ---------------------------------------------------------------------------
create table if not exists education_credits (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  item_key text not null references education_items(key) on delete cascade,
  points int not null check (points >= 0),
  credited_at timestamptz not null default now(),
  unique (profile_id, item_key)
);

create index if not exists education_credits_profile_idx
  on education_credits (profile_id, credited_at desc);

comment on table education_credits is
  'One row the first time a person answers a glossary term correctly, and one for the install-sequence quiz. The UNIQUE (profile_id, item_key) is the whole new-content rule: a second correct answer on the same term writes nothing, so the round that contains it pays nothing for it. Written only by award_education_quiz.';

alter table education_credits enable row level security;

-- Own rows, or foreman+ sees everyone's — the same shape
-- learning_video_quiz_attempts uses (20260962000000), for the same reason:
-- what somebody has learned is as private from their peers as their timecard,
-- and as visible to a lead.
drop policy if exists "own or lead read" on education_credits;
create policy "own or lead read" on education_credits
  for select to authenticated
  using (
    not public.is_partner_user()
    and (profile_id = auth.uid() or _is_lead(auth.uid()))
  );

revoke insert, update, delete on table education_credits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. award_install_points — the install path's only door
-- ---------------------------------------------------------------------------
-- Called by the offline install outbox after finish_unit lands
-- (app/src/lib/install/installOutbox.ts, through lib/points.ts awardPoints).
-- p_ref is the OPENING's id, which is what the ledger has always stored and
-- what QC looks a unit's points up by.
--
-- Three things it will not do:
--   * pay somebody who had nothing to do with the install — the caller has to
--     be the person who filed the event or the person it was credited to;
--   * pay twice for one unit — a resend is ignored in silence, because the
--     outbox retries a whole install and the retry is not an error;
--   * pay more than the rule is worth — the amounts come off a phone, so each
--     kind is clamped to POINT_RULES (app/src/lib/points.ts). SQL cannot import
--     that TS constant, so it is kept in step by hand, the same arrangement
--     submit_video_quiz already lives with.
create or replace function public.award_install_points(
  p_ref text,
  p_entries jsonb,
  p_status text default 'pending'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening uuid;
  v_filer uuid;
  v_credited uuid;
  v_payee uuid;
  v_entry jsonb;
  v_kind text;
  v_points int;
  v_cap int;
  v_written int := 0;
  v_skipped int := 0;
begin
  if public.is_partner_user() then
    raise exception 'Points are for the install crew.';
  end if;

  if p_status is null or p_status not in ('pending', 'confirmed') then
    raise exception 'Install points are filed as pending or confirmed.';
  end if;

  begin
    v_opening := p_ref::uuid;
  exception when others then
    raise exception 'Install points have to name the window they were earned on.';
  end;

  -- The most recent install filed on this opening, and the two people it can
  -- possibly belong to. coalesce(credited_to, installer_id) is how every
  -- per-person rollup in this database reads an install (20260982000000) —
  -- and it is exactly what the phone was computing for itself before today.
  select e.installer_id, e.credited_to
    into v_filer, v_credited
    from install_events e
   where e.project_opening_id = v_opening
   order by e.created_at desc
   limit 1;

  if v_filer is null and v_credited is null then
    raise exception 'That window has no finished install to pay for yet.';
  end if;

  if auth.uid() is distinct from v_filer and auth.uid() is distinct from v_credited then
    raise exception 'Points go to whoever installed the window.';
  end if;

  v_payee := coalesce(v_credited, v_filer);

  for v_entry in
    select t.value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as t(value)
  loop
    v_kind := v_entry ->> 'kind';
    v_points := coalesce((v_entry ->> 'points')::int, 0);

    -- POINT_RULES, mirrored. 'quiz' is deliberately absent: the Learn tab has
    -- its own door and must never reach this one.
    v_cap := case v_kind
               when 'install' then 20
               when 'par'     then 15
               when 'photos'  then 10
               when 'teach'   then 15
               when 'quality' then 5
               else 0
             end;
    if v_cap = 0 or v_points <= 0 then
      continue;
    end if;
    if v_points > v_cap then
      v_points := v_cap;
    end if;

    -- A resend. Void rows count as already-paid on purpose: QC voiding a
    -- callback's points must not be undone by the outbox trying again.
    if exists (
      select 1 from points_ledger l
       where l.profile_id = v_payee and l.ref = p_ref and l.kind = v_kind
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into points_ledger (profile_id, kind, points, ref, status)
    values (v_payee, v_kind, v_points, p_ref, p_status);
    v_written := v_written + 1;
  end loop;

  return jsonb_build_object('awarded', v_written, 'already_had', v_skipped);
end;
$$;

comment on function public.award_install_points(text, jsonb, text) is
  'The install outbox''s only way to write points. p_ref is the opening id; the payee is coalesce(credited_to, installer_id) off the newest install_events row for it, and the caller must be one of those two people. Each kind pays at most once per opening (a resend is ignored silently — the outbox retries), and each amount is clamped to POINT_RULES. Returns {awarded, already_had}.';

revoke all on function public.award_install_points(text, jsonb, text) from public, anon;
grant execute on function public.award_install_points(text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. resolve_install_points — QC's confirm / void
-- ---------------------------------------------------------------------------
create or replace function public.resolve_install_points(p_ref text, p_status text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  if public.is_partner_user() or public.my_role_rank() < 1 then
    raise exception 'Only a foreman or above can sign off points.';
  end if;
  if p_status is null or p_status not in ('confirmed', 'void') then
    raise exception 'A QC decision either confirms points or voids them.';
  end if;
  if p_ref is null or p_ref = '' then
    raise exception 'Say which window''s points to sign off.';
  end if;

  -- Only this ref, and only rows still waiting. Nothing already confirmed or
  -- already voided moves, so a second tap on Pass changes nothing.
  update points_ledger
     set status = p_status,
         void_reason = case
           when p_status = 'void'
             then coalesce(void_reason, 'QC sent this window back — a callback voids its points')
           else void_reason
         end
   where ref = p_ref
     and status = 'pending';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.resolve_install_points(text, text) is
  'QC''s pass/callback decision, applied to one unit''s pending points. Foreman+ only. Touches nothing but rows whose ref is p_ref and whose status is still pending, so it can never reach across units or reopen a settled row. Returns how many rows moved.';

revoke all on function public.resolve_install_points(text, text) from public, anon;
grant execute on function public.resolve_install_points(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. award_education_quiz — the Learn tab's only door
-- ---------------------------------------------------------------------------
-- p_items is the round: [{key, correct}, …], one entry per question asked.
-- What comes back is what the screen has to say — how many points, how many
-- terms were new, and how many the person already had — because "you already
-- earned these, keep practising" is a different sentence from "+30 points".
create or replace function public.award_education_quiz(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_round uuid := gen_random_uuid();
  v_item jsonb;
  v_key text;
  v_worth int;
  v_gained int;
  v_new int := 0;
  v_already int := 0;
  v_points int := 0;
  v_keys text[] := '{}';
begin
  if v_me is null or public.is_partner_user() then
    raise exception 'Sign in with your own crew login to earn points.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Send the round''s questions and answers together.';
  end if;
  -- A round is five questions. The ceiling makes a long round pointless
  -- anyway; this just keeps one call from being a whole afternoon of them.
  if jsonb_array_length(p_items) > 25 then
    raise exception 'That is more questions than one round holds.';
  end if;

  for v_item in
    select t.value from jsonb_array_elements(p_items) as t(value)
  loop
    v_key := v_item ->> 'key';
    if v_key is null then
      continue;
    end if;
    if not coalesce((v_item ->> 'correct')::boolean, false) then
      continue;
    end if;
    -- The same term twice in one round is one term.
    if v_key = any (v_keys) then
      continue;
    end if;

    -- The server's own list. A key it has never heard of pays nothing and
    -- says nothing — there is no error to learn the shape of the list from.
    select i.points into v_worth from education_items i where i.key = v_key;
    if v_worth is null then
      continue;
    end if;

    v_gained := null;
    insert into education_credits (profile_id, item_key, points)
    values (v_me, v_key, v_worth)
        on conflict (profile_id, item_key) do nothing
      returning points into v_gained;

    if v_gained is null then
      v_already := v_already + 1;
    else
      v_new := v_new + 1;
      v_points := v_points + v_gained;
      v_keys := v_keys || v_key;
    end if;
  end loop;

  -- ONE ledger row for the round, carrying the keys it paid for. A round that
  -- earned nothing writes nothing: an empty row would put "+0 points" in a
  -- person's history every time they practised.
  if v_points > 0 then
    insert into points_ledger (profile_id, kind, points, ref, status, detail)
    values (
      v_me, 'quiz', v_points, 'education:' || v_round::text, 'confirmed',
      jsonb_build_object('keys', to_jsonb(v_keys))
    );
  end if;

  return jsonb_build_object(
    'points_awarded', v_points,
    'new_terms', v_new,
    'already_had', v_already,
    'keys', to_jsonb(v_keys)
  );
end;
$$;

comment on function public.award_education_quiz(jsonb) is
  'The Learn tab''s Quiz and Sequence rounds, priced server-side. p_items is [{key, correct}] for the round. Pays only for items in education_items that this person has never been credited for, writes ONE points_ledger row for the whole round (ref ''education:<uuid>'', detail.keys naming what it paid for), and returns {points_awarded, new_terms, already_had, keys}. Practising costs nothing and pays nothing.';

revoke all on function public.award_education_quiz(jsonb) from public, anon;
grant execute on function public.award_education_quiz(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. my_education_progress — "Earned 12 of 105 terms"
-- ---------------------------------------------------------------------------
-- The header line on the Quiz tab. It reads off the same two tables the payout
-- does, so the number a person sees and the number they are paid against can
-- never drift apart.
create or replace function public.my_education_progress()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or public.is_partner_user() then
    raise exception 'Sign in with your own crew login to see your progress.';
  end if;
  return jsonb_build_object(
    'terms_earned', (
      select count(*) from education_credits c
        join education_items i on i.key = c.item_key
       where c.profile_id = v_me and i.kind = 'term'
    ),
    'terms_total', (select count(*) from education_items i where i.kind = 'term'),
    'sequence_done', exists (
      select 1 from education_credits c
        join education_items i on i.key = c.item_key
       where c.profile_id = v_me and i.kind = 'sequence'
    )
  );
end;
$$;

comment on function public.my_education_progress() is
  'The caller''s own Learn-tab standing: {terms_earned, terms_total, sequence_done}. Read off education_credits and education_items, so the header line and the payout can never disagree.';

revoke all on function public.my_education_progress() from public, anon;
grant execute on function public.my_education_progress() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. "Remove this login" has to count the new table too
-- ---------------------------------------------------------------------------
-- person_record_counts (20260987000000) is what decides whether a login can be
-- deleted outright or has to be retired with every row kept, and the rule lives
-- twice on purpose: SQL counts, TypeScript names (app/src/lib/purgeWords.ts).
-- education_credits cascades off profiles, so a login deleted without this line
-- would take a person's earned terms with it in silence — and a person can hold
-- them with no learn_progress row at all, because the Quiz tab and the Daily 5
-- are different screens. Restated in full rather than patched, the way this
-- function's own migration restates the nudge audiences, so the whole list is
-- readable in one place; the only change is the one line.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;

comment on function public.person_record_counts(uuid) is
  'How many rows of work, money and safety record one person has, keyed table.column. The input to "remove this login": nothing anywhere means the account can be deleted outright, anything at all means it is retired and every row kept. Service role only — manage-crew-access checks the caller is the owner before it asks.';

revoke all on function public.person_record_counts(uuid) from public, anon, authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
