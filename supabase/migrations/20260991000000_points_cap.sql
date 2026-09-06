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
--      makes "one payment per person per ref per kind" structural rather than
--      a promise a function makes.
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
-- 1. points_ledger: a reason column, and the duplicate-award backfill
-- ---------------------------------------------------------------------------

alter table points_ledger add column if not exists void_reason text;

comment on column points_ledger.void_reason is
  'Why a row was voided, in a sentence, when something other than a QC callback voided it. Written by the 2026-09-05 backfill in this migration and by resolve_install_points; null on every row that was never voided.';

-- BACKFILL B (making the index creatable, and correcting the same fault).
-- The install path awards through an offline outbox that retries, and until
-- today a retry that got as far as the award and then failed on the media
-- could pay the same install twice. Keep the FIRST row for each
-- (person, ref, kind) and void the rest — a second payment for one install was
-- never earned, and the unique index below cannot be built while one exists.
with ranked as (
  select l.id,
         row_number() over (
           partition by l.profile_id, l.ref, l.kind
           order by l.created_at, l.id
         ) as rn
    from points_ledger l
   where l.ref is not null
     and l.status <> 'void'
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

-- THE STRUCTURAL GUARANTEE. One payment per person, per ref, per kind. Partial
-- on two counts: a null ref is outside it (the voided history above, and
-- nothing new writes one), and a VOIDED row is outside it so that voiding a
-- duplicate actually frees the slot. That carve-out does not open a re-pay
-- door: award_install_points checks for ANY existing row on the pair, void
-- included, before it inserts. The index is the backstop; the function is the
-- rule.
create unique index if not exists points_ledger_one_award_per_ref_kind
  on points_ledger (profile_id, ref, kind)
  where ref is not null and status <> 'void';
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
revoke insert, update, delete on table points_ledger from anon, authenticated;
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
