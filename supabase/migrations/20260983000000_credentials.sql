-- Wave O — Credentials (transcripts program, grill of 2026-09-03, Q14).
--
-- The app has always known what somebody is GOOD at — a skill tier, a
-- capability badge, a training clearance per window type. It has never known
-- what somebody is CERTIFIED to do, and those are the pieces of paper a general
-- contractor asks for at the gate and a bid asks for on page two: OSHA 10,
-- OSHA 30, first aid, aerial lift, forklift, fall protection.
--
-- Every one of them expires, and nothing in this schema has ever had an expiry
-- date. That is the whole reason this is a table rather than another list of
-- flags: a certification is a fact WITH A DEADLINE, and the deadline is what
-- the 7 AM sweep says out loud thirty days before a card runs out.
--
-- Four things here, in the order they depend on each other:
--
--   1. certifications          — one row per card, per person.
--   2. credential-docs         — a PRIVATE bucket for the photo of the card.
--   3. set_certification       — the one writer: self may add their own
--                                (unverified), supervisor+ verifies, edits
--                                and voids.
--   4. credential_nudges +     — the "we already said this" ledger and the
--      claim_credential_nudges   rule the pipeline sweep runs, wave J's J5
--                                extension point taken up exactly as written.
--
-- MERGE ORDER: this is 20260983000000 and it lands AFTER 20260981000000 (wave
-- H, the GC handshake) and 20260982000000 (wave Y, who did what). It shares no
-- object with either — H touches project_gc_checkins and the pipeline sweep's
-- start-date clause, Y touches install credit — so the order matters only
-- because migration numbers must land in sequence, one deploy at a time.
--
-- NOT PROJECT-SCOPED, on purpose. A certification belongs to a person, not a
-- job, so there is no project_id, no `attach_sandbox_guards()` call, and a test
-- login has no sandbox row to be fenced into. What stops a test login writing a
-- card is set_certification's own rules, which are about identity and rank.
--
-- IDEMPOTENT throughout (create ... if not exists / create or replace / drop
-- policy if exists before create / on conflict), so re-running it changes
-- nothing.


-- ---------------------------------------------------------------------------
-- 1. O1 — certifications
-- ---------------------------------------------------------------------------
-- WHY A KIND LIST AND AN `other_label`. The six named kinds are the cards this
-- company is actually asked for, and naming them is what makes O5's summary
-- countable: "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift" is only possible if
-- everybody spells OSHA 30 the same way. `other` plus a free-text label is the
-- escape hatch, so a card nobody anticipated is still recorded rather than
-- squeezed into the wrong bucket — and it counts as "other", never as one of
-- the six.
--
-- WHY expires_on IS NULLABLE. Some cards genuinely never expire (an OSHA 10
-- wallet card has no printed expiry in most states). Null means "no expiry on
-- the card", which is a real answer, and the chip on screen says so in grey
-- rather than pretending the card is fine forever in green. Nothing with a null
-- expiry can ever be nudged about, which is correct.
--
-- WHY voided_at RATHER THAN DELETE. A card entered against the wrong person, or
-- a card that turned out to be a photo of somebody else's, has to stop counting
-- — but a deleted row takes its history with it, and "who said this person had
-- an OSHA 30" is exactly the question asked after an incident. Void, never
-- delete: the row stays, and every read filters it out.
create table if not exists certifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (
    kind in (
      'osha10',
      'osha30',
      'first_aid_cpr',
      'aerial_lift',
      'forklift',
      'fall_protection',
      'other'
    )
  ),
  -- Only meaningful when kind = 'other'; the RPC clears it otherwise so a kind
  -- corrected from 'other' to 'osha30' does not keep a stale label beside it.
  other_label text,
  issued_on date,
  -- Null = the card carries no expiry. See the note above.
  expires_on date,
  -- "<profile_id>/<uuid>.jpg" inside the credential-docs bucket. A path, never
  -- a URL: the bucket is private and every read is a short-lived signed URL.
  document_path text,
  verified_by uuid references profiles(id) on delete set null,
  verified_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz
);

-- Every read is "this person's cards" or "everybody's cards, soonest expiry
-- first"; both are served by this.
create index if not exists certifications_profile_idx
  on certifications (profile_id, expires_on);

-- The sweep's own read: the cards expiring around today, across the company.
create index if not exists certifications_expiry_idx
  on certifications (expires_on)
  where voided_at is null;

comment on table certifications is
  'One card per row: OSHA 10/30, first aid, aerial lift, forklift, fall protection, or other. A fact with a deadline — expires_on is what the 7 AM sweep warns about thirty days out and again on the day. Voided, never deleted. Written only by set_certification (Wave O, O1).';

alter table certifications enable row level security;

-- Revoke BEFORE granting. This project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS is not the wall on
-- its own: without this, a permissive policy added later by anybody would turn
-- a table with no write policy into a write hole. set_certification, SECURITY
-- DEFINER, is the only writer there is.
revoke all on certifications from anon, authenticated;
grant select on certifications to authenticated;
grant all on certifications to service_role;

-- WHO READS WHAT.
--   * Your own cards, always. Unlike a pay rate (which the app deliberately
--     does not show you, because payroll already does), your OSHA card is a
--     thing you are asked for at a gate and a thing you have to renew. A person
--     who cannot see their own expiry date cannot do anything about it, and O3
--     puts exactly this list on My Work.
--   * Foreman and above, everybody's. A foreman is who gets told at the gate
--     that half the crew cannot go up in the lift today.
--   * A partner (builder) login, never. The mechanical wall guard every crew
--     table has carried since 20260950000000; scripts/test_partner_wall.py
--     fails on a new table without it.
drop policy if exists "certifications_select" on certifications;
create policy "certifications_select" on certifications
  for select to authenticated
  using (
    not public.is_partner_user()
    and (profile_id = auth.uid() or public.my_role_rank() >= 1)
  );


-- ---------------------------------------------------------------------------
-- 2. O1/O2 — the private bucket for the photo of the card
-- ---------------------------------------------------------------------------
-- A photo of an OSHA card carries a full legal name and a card number. It is
-- not a job photo, so it does not live in install-media with them, and it is
-- not public under any circumstances.
--
-- SIZE CAP: 10 MB per file, which is roughly four times a phone camera JPEG at
-- full resolution and comfortably clears a scanned PDF of a two-sided card.
-- Stated rather than left to the project default so nobody has to guess, and
-- low enough that a mis-picked video is refused by the bucket instead of
-- costing the company storage forever. MIME types are pinned to the four things
-- a card can honestly be.
--
-- `do update` rather than `do nothing` on conflict: re-running this migration
-- against a bucket somebody widened by hand puts the cap and the type list
-- back, which is the point of an idempotent migration.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'credential-docs',
  'credential-docs',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- THE PATH IS THE PERMISSION. Every object is "<profile_id>/<uuid>.<ext>", so
-- the first folder name IS the person the card belongs to, and the policies
-- below can be written against it without reading the certifications table at
-- all. That is deliberate: a storage policy that joins back to a business table
-- is a storage policy that breaks the day the business table's own policy
-- changes.
--
-- Read: the cardholder, or a supervisor+. NOT every foreman — a foreman needs
-- to know a card exists and when it runs out (the row is readable to them), and
-- that is a different thing from being handed a photograph of somebody's
-- government-adjacent ID. The person verifying is supervisor+ by O1's own
-- rule, and they are the only one who needs to look at the paper.
--
-- Write: the cardholder, their own folder, and nobody else. A supervisor
-- collecting cards at a toolbox talk therefore cannot upload on somebody's
-- behalf — see the PR body; the honest reading of the spec is that the person
-- owns their own document, and the alternative hands one account the ability to
-- write into every crew member's private folder.
drop policy if exists "credential docs read" on storage.objects;
create policy "credential docs read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.my_role_rank() >= 2
    )
  );

drop policy if exists "credential docs write own" on storage.objects;
create policy "credential docs write own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update covers a re-upload to the same path (a retaken photo). Delete is
-- deliberately absent: nothing in the app deletes a credential document, for
-- the same reason nothing deletes a certification row.
drop policy if exists "credential docs replace own" on storage.objects;
create policy "credential docs replace own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'credential-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ---------------------------------------------------------------------------
-- 3. O1 — set_certification: the only writer
-- ---------------------------------------------------------------------------
-- One function for add, edit, verify and void, because they are the same row
-- and splitting them into four RPCs would mean four places to get the rank
-- check right.
--
-- WHO MAY DO WHAT, and it is not a single rank:
--   * ADD YOUR OWN CARD: anybody, including an installer. This is the whole
--     point — a crew member photographs the card in their wallet at a toolbox
--     talk instead of the office chasing it. It lands UNVERIFIED whatever the
--     caller asks for, so "I have an OSHA 30" is a claim until somebody with a
--     rank has looked at the paper.
--   * ADD SOMEBODY ELSE'S: supervisor+, and they may verify it in the same
--     call, because they are holding the card.
--   * EDIT, VERIFY, UNVERIFY, VOID: supervisor+ only. An installer cannot
--     correct their own typo, which is a deliberate cost: a row somebody can
--     edit after it was verified is a row that means nothing.
--
-- PARTIAL BY DEFAULT, like updateProject learned to be in wave J: on an edit, a
-- null argument means "leave that column alone", never "set it to null". A date
-- is CLEARED through its own explicit flag, so one tap on Verify cannot wipe an
-- expiry date the caller never mentioned. That bug has been shipped in this
-- repo once already (20260979000000's own PR fixed it for job details); this
-- function does not get to ship it again.
create or replace function public.set_certification(
  p_id uuid default null,
  p_profile_id uuid default null,
  p_kind text default null,
  p_other_label text default null,
  p_issued_on date default null,
  p_expires_on date default null,
  p_document_path text default null,
  p_verified boolean default null,
  p_voided boolean default null,
  p_clear_issued boolean default false,
  p_clear_expires boolean default false
)
returns certifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row certifications;
  v_rank int := public.my_role_rank();
  v_me uuid := auth.uid();
  v_target uuid;
begin
  if v_me is null then
    raise exception 'Sign in before adding a card.' using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------- new card
  if p_id is null then
    v_target := coalesce(p_profile_id, v_me);
    if v_target <> v_me and v_rank < 2 then
      raise exception 'Only a supervisor can add a card for somebody else.'
        using errcode = '42501';
    end if;
    if p_kind is null then
      raise exception 'Say which card this is.';
    end if;
    if not exists (select 1 from profiles where id = v_target) then
      raise exception 'That person is not on the crew list.';
    end if;
    if p_kind = 'other' and coalesce(btrim(p_other_label), '') = '' then
      raise exception 'Name the card, since it is not one of the listed ones.';
    end if;
    if p_issued_on is not null and p_expires_on is not null
       and p_expires_on < p_issued_on then
      raise exception 'A card cannot run out before the day it was issued.';
    end if;

    insert into certifications (
      profile_id, kind, other_label, issued_on, expires_on, document_path,
      created_by,
      -- Your own card is never self-verified, whatever the call asks for.
      verified_by,
      verified_at
    )
    values (
      v_target,
      p_kind,
      case when p_kind = 'other' then nullif(btrim(p_other_label), '') else null end,
      p_issued_on,
      p_expires_on,
      nullif(btrim(p_document_path), ''),
      v_me,
      case when p_verified is true and v_rank >= 2 and v_target <> v_me then v_me end,
      case when p_verified is true and v_rank >= 2 and v_target <> v_me then now() end
    )
    returning * into v_row;
    return v_row;
  end if;

  -- ------------------------------------------------------------ existing card
  if v_rank < 2 then
    raise exception 'Only a supervisor can change or verify a card.'
      using errcode = '42501';
  end if;

  select * into v_row from certifications where id = p_id;
  if not found then
    raise exception 'That card is not on file any more.';
  end if;

  update certifications set
    kind = coalesce(p_kind, kind),
    other_label = case
      when coalesce(p_kind, kind) <> 'other' then null
      when p_other_label is not null then nullif(btrim(p_other_label), '')
      else other_label
    end,
    issued_on = case
      when p_clear_issued then null
      else coalesce(p_issued_on, issued_on)
    end,
    expires_on = case
      when p_clear_expires then null
      else coalesce(p_expires_on, expires_on)
    end,
    document_path = coalesce(nullif(btrim(p_document_path), ''), document_path),
    -- Verify and unverify are the same argument. Absent leaves the row alone,
    -- so an edit to a date does not quietly re-stamp who verified it.
    verified_by = case
      when p_verified is true then v_me
      when p_verified is false then null
      else verified_by
    end,
    verified_at = case
      when p_verified is true then now()
      when p_verified is false then null
      else verified_at
    end,
    voided_at = case
      when p_voided is true then coalesce(voided_at, now())
      when p_voided is false then null
      else voided_at
    end
  where id = p_id
  returning * into v_row;

  if v_row.issued_on is not null and v_row.expires_on is not null
     and v_row.expires_on < v_row.issued_on then
    raise exception 'A card cannot run out before the day it was issued.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) is
  'The one writer for certifications. Adding your OWN card needs no rank and always lands unverified; adding somebody else''s, and every edit, verification and void, is supervisor+. Partial: a null argument leaves that column alone, and a date is cleared through its own flag so verifying cannot wipe an expiry (Wave O, O1).';

revoke all on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. O4 — credential_nudges: a SIBLING ledger, and why it is not pipeline_nudges
-- ---------------------------------------------------------------------------
-- Wave J's section 8 invites this wave to write its kinds into pipeline_nudges,
-- and that was the plan. It does not fit, for one concrete reason that only
-- shows up when you read the table: pipeline_nudges.project_id is
-- `not null references projects(id)`, and its idempotency is the UNIQUE
-- (project_id, kind, on_date). A credential belongs to a PERSON, not a job.
--
-- The two ways to force it in are both worse:
--   * Make project_id nullable. Postgres treats NULLs as DISTINCT in a unique
--     constraint, so (null, 'credential_30d', '2026-10-01') would never
--     conflict with itself and every sweep would push again. The one property
--     the ledger exists for would be gone — silently, and only for the rows
--     that used the null.
--   * Hang the warning off some arbitrary project. There isn't one; a card is
--     not about a job.
--
-- So: the same SHAPE, a table of its own, keyed on the thing the warning is
-- actually about. The spec's own idempotency key — (certification_id, kind,
-- on_date) — is this table's UNIQUE, word for word. Everything else follows
-- wave J exactly: on_date is the day the nudge is ABOUT (the expiry date), not
-- the day it was sent, so a missed morning still says it once, and a RENEWED
-- card with a new expiry date earns a fresh warning, which is right.
--
-- `kind` carries no check constraint, for the same reason J's does not: a
-- later rule about credentials should need no migration.
create table if not exists credential_nudges (
  id uuid primary key default gen_random_uuid(),
  certification_id uuid not null references certifications(id) on delete cascade,
  kind text not null,
  on_date date not null,
  created_at timestamptz not null default now(),
  unique (certification_id, kind, on_date)
);

create index if not exists credential_nudges_cert_idx
  on credential_nudges (certification_id, created_at desc);

comment on table credential_nudges is
  'One row per warning already sent about one card. The sibling of pipeline_nudges, separate only because that table''s project_id is NOT NULL and a certification is about a person: making it nullable would break the unique key that IS the idempotency. on_date is the expiry the warning is about, never the day it was sent (Wave O, O4).';

alter table credential_nudges enable row level security;

revoke all on credential_nudges from anon, authenticated;
grant select on credential_nudges to authenticated;
grant all on credential_nudges to service_role;

-- Readable by signed-in crew, never a partner login (the mechanical wall
-- guard). No insert/update/delete policy at all: the sweep is the only writer
-- and it writes as the service role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'credential_nudges' and policyname = 'crew read'
  ) then
    create policy "crew read" on credential_nudges
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. O4 — who hears about an expiring card
-- ---------------------------------------------------------------------------
-- The person whose card it is, and every supervisor and owner. Not foremen at
-- large: a foreman reading every morning that somebody on another crew has a
-- forklift card running out is how a crew learns to swipe this app's
-- notifications away without reading them, and the supervisors are the ones who
-- book the renewal class.
--
-- An inactive person is skipped — somebody who has left does not need to be
-- told, and neither does anybody else on their behalf. Partner logins never.
create or replace function public.credential_nudge_audience(p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.active
     and not coalesce(pr.is_partner, false)
     and (pr.id = p_profile_id or public._is_supervisor(pr.id));
$$;

comment on function public.credential_nudge_audience(uuid) is
  'Who hears that a card is running out: the person it belongs to, plus every active supervisor and owner. Partner logins never (Wave O, O4).';

revoke all on function public.credential_nudge_audience(uuid) from public, anon, authenticated;
grant execute on function public.credential_nudge_audience(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 6. O4 — claim_credential_nudges: the decision and the claim, in one statement
-- ---------------------------------------------------------------------------
-- Shaped deliberately like claim_pipeline_nudges (20260979000000 section 7),
-- because wave J asked for exactly that: same service-role-only guard, same
-- 7 AM company-local gate, same insert-on-conflict-do-nothing-returning claim
-- so two overlapping sweeps cannot both push.
--
-- THE RULE LIVES TWICE, AND THE COPIES ARE PINNED TOGETHER.
-- app/src/lib/credentials.ts holds the readable version (expiryState /
-- dueCredentialNudges) which drives the chips and the Heartbeat tile;
-- credentials.test.ts carries a test named after this function that spells
-- these clauses out in TypeScript, so a change made to one side and not the
-- other fails a test rather than going quietly live.
--
-- Two rules, and the SPEC ASKS FOR TWO PUSHES: one when the card enters its
-- last thirty days, one on the day it runs out. Both rules key their ledger row
-- on the SAME on_date (the expiry date), so the two windows must not overlap —
-- a day claimed by rule (a) is a day rule (b) can never speak on, because the
-- (certification_id, kind, on_date) row rule (a) wrote weeks earlier is still
-- there. The first cut of this function had (a) at 0..30 and (b) at -30..-1,
-- which meant day 0 fell inside a window already claimed on day 30 and the only
-- other warning landed the morning AFTER the card lapsed. The last day a card
-- is good — the one morning somebody can still act before a gate turns them
-- away — was the one day nothing was said. Hence:
--   (a) 1..30 days out: the card is inside its last thirty days. WINDOWED
--       rather than "exactly 30", so one missed sweep does not silently drop
--       the warning; the unique key already guarantees it is said once per
--       expiry date.
--   (b) -30..0 days out: today IS the day, or the card has already run out.
--       Day 0 lives here rather than in (a) so it gets a ledger key of its own
--       and a sentence of its own ("runs out today", credentialCopy in
--       supabase/functions/pipeline-sweep/index.ts). Windowed backwards for the
--       same self-healing reason: a sweep that misses the day itself still says
--       it the next morning, worded as a lapse. Bounded to the last thirty days
--       on purpose: a card that expired in 2019, typed in today as history,
--       must not wake three supervisors' phones about a fact everybody already
--       knows.
--
-- A VOIDED card is silent, and so is a card belonging to somebody who is no
-- longer active. An UNVERIFIED card still warns — the office not having got
-- round to looking at the paper is not a reason to let the crew member's OSHA
-- card lapse, and the push says nothing about whether it was verified.
create or replace function public.claim_credential_nudges()
returns table (
  certification_id uuid,
  profile_id uuid,
  person_name text,
  cert_kind text,
  cert_label text,
  kind text,
  days_until int,
  expires_on date,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- Several OUT parameters share their names with real columns below
-- (certification_id, profile_id, kind, expires_on). Ambiguity between an OUT
-- parameter and a column is a plpgsql RUNTIME error, not a compile one, so it
-- would first appear at 7 AM in production. Every reference below is
-- table-qualified AND this pragma makes the column win regardless.
#variable_conflict use_column
declare
  v_tz constant text := 'America/Denver';
  v_today date;
  v_hour int;
begin
  if auth.uid() is not null then
    raise exception 'The credential reminder sends itself — nobody needs to press anything.';
  end if;

  v_today := (now() at time zone v_tz)::date;
  v_hour := extract(hour from (now() at time zone v_tz))::int;

  -- Before 7 AM company time there is nothing due. The sweep pokes hourly
  -- rather than once at a fixed UTC hour so "the morning" stays the crew's
  -- morning through both halves of the year; the claim is what makes a repeated
  -- poke free.
  if v_hour < 7 then
    return;
  end if;

  return query
  with candidate as (
    select c.id as cid,
           c.profile_id as pid,
           coalesce(nullif(btrim(pr.display_name), ''), 'Somebody') as who,
           c.kind as ckind,
           case
             when c.kind = 'other' then coalesce(nullif(btrim(c.other_label), ''), 'certification')
             else c.kind
           end as clabel,
           c.expires_on as exp,
           (c.expires_on - v_today)::int as days_out
      from certifications c
      join profiles pr on pr.id = c.profile_id
     where c.voided_at is null
       and c.expires_on is not null
       and pr.active
       and not coalesce(pr.is_partner, false)
  ),
  due as (
    select cd.cid, cd.pid, cd.who, cd.ckind, cd.clabel, cd.exp, cd.days_out,
           'credential_30d'::text as due_kind
      from candidate cd
     where cd.days_out between 1 and 30
    union all
    -- Day 0 is deliberately on THIS side of the line. See the note above.
    select cd.cid, cd.pid, cd.who, cd.ckind, cd.clabel, cd.exp, cd.days_out,
           'credential_expired'::text as due_kind
      from candidate cd
     where cd.days_out between -30 and 0
  ),
  claimed as (
    insert into credential_nudges (certification_id, kind, on_date)
    select d.cid, d.due_kind, d.exp from due d
    on conflict (certification_id, kind, on_date) do nothing
    returning credential_nudges.certification_id as claimed_cid,
              credential_nudges.kind as claimed_kind
  )
  select d.cid,
         d.pid,
         d.who,
         d.ckind,
         d.clabel,
         d.due_kind,
         d.days_out,
         d.exp,
         public.credential_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_cid = d.cid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_credential_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the credential warnings due this company-local morning — a card 1 to 30 days from running out, and a card whose day has come or gone within the last thirty. The two windows do not overlap, because both write the same on_date and a day claimed by one is a day the other can never speak on; day 0 belongs to the second so the last day a card is good gets a warning of its own. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is dueCredentialNudges in app/src/lib/credentials.ts (Wave O, O4).';

revoke all on function public.claim_credential_nudges() from public, anon, authenticated;
grant execute on function public.claim_credential_nudges() to service_role;

-- NO NEW CRON, and no new edge function. Wave J's `pipeline-sweep` already
-- pokes hourly and already loops over a LIST of rules; this wave adds one entry
-- to that list (supabase/functions/pipeline-sweep/index.ts) and nothing else.
-- A second cron job would push at almost the same minute as the first, from a
-- second function nobody remembers to watch.
