-- An installer's gallery shows the jobs they have worked, and nothing else
-- (owner's decision, 2026-09-05).
--
-- APPLY AFTER 20260994000000 (one place to fix a unit) — the highest number on
-- master. Number order is the whole ordering rule here; nothing in this file
-- depends on any other migration's shape.
--
-- IT WAS 20260993000000 UNTIL 2026-09-06, and that number was wrong: while this
-- branch was open, 20260993000000_learning_time landed on master under it. Two
-- files at one version is not a merge conflict — `supabase db push` reads the
-- version, sees it applied, and skips the second file without a word. Here that
-- would have left `attachments` on its day-one FOR ALL policy while the app
-- shipped the narrowed picker: a gallery that looks scoped and is not.
-- test_supabase_merge.py's duplicate-version test is what catches it, and the
-- habit that avoids it is checking master AND every open PR branch before
-- picking a number. 20260996000000 is claimed by an open PR today, so this file
-- merges before that one or gets renumbered again.
--
-- WHAT WAS TRUE UNTIL NOW. `attachments` — every job photo, every voice memo,
-- every package shot in the warehouse — carried exactly ONE policy since
-- 20260715000000, recreated verbatim by THE WALL (20260950000000, around line
-- 186):
--
--   create policy "authenticated full access" on attachments
--     for all to authenticated
--     using (not public.is_partner_user() and (true))
--     with check (not public.is_partner_user() and (true));
--
-- So any crew member could read every photo on every job. That was invisible
-- for as long as there was no door: /photos appeared in no installer path list
-- until the Capture button (PR #539) put a gallery tile in front of every role.
-- The door is the reason this policy now has to say what it always meant.
--
-- THE RULE, in one sentence: below foreman, you see photos from the jobs you
-- have worked, plus the ones you took yourself. Foreman and above see exactly
-- what they see today.
--
-- WHAT "WORKED" MEANS. Three signals, and they are OR'd because each one is a
-- different honest way of having been on a job:
--
--   * a `time_shifts` row on that job — you clocked in to it;
--   * a PUBLISHED `schedule_assignments` row you are a member of — the crew
--     board says the job is yours. Drafts are excluded on purpose: a draft is
--     a supervisor thinking out loud, and it is not shown to the person yet;
--   * a `unit_sessions` row on one of its openings — you have a unit clocked
--     on that job, which happens on data-tracking jobs before any shift.
--
-- Reading `time_shifts` is what makes a FINISHED job stay visible: a photo from
-- a job somebody worked in March is still theirs to look up in September. This
-- is a memory of work done, not a list of today's assignments.
--
-- NOTHING ABOUT WRITES CHANGES. The single FOR ALL policy is replaced by four
-- per-command policies; the three write policies are written out at exactly
-- today's width (`not is_partner_user()`, nothing else) so that splitting the
-- policy is not quietly a second change. The 30-day photo trash
-- (soft_delete_job_photo / restore_job_photo, 20260973000000) is SECURITY
-- DEFINER and does not answer to these policies at all.
--
-- WHY "OR THE ROW IS MY OWN UPLOAD" IS LOAD-BEARING, AND NOT JUST KINDNESS.
-- The install queue writes its attachment with
-- `.insert(row).select("id").single()` — PostgREST asks for the row back, so
-- the statement is an INSERT ... RETURNING, and a RETURNING clause is a READ:
-- the SELECT policy is applied to the row that was just written. An installer
-- filing a photo on a job they never clocked into would otherwise write a row
-- they cannot read back. Every client insert sets `created_by` to the
-- signed-in email (PhotoCaptureSheet, OpeningSheet, ModelStudio, PackageSheet),
-- so that branch always catches it. Keep it that way: dropping `created_by`
-- from an insert would break the write, not just the picture.
--
-- STORAGE, CHECKED AND DELIBERATELY LEFT ALONE — AND OPEN, NOT MERELY
-- GUESSABLE. `install-media` carries one bucket-wide policy ("install media
-- crew", 20260988000000) written FOR ALL, SELECT included: every non-partner
-- crew member may read any object in it. Listing a bucket is a select on
-- storage.objects, so nobody has to KNOW another job's path to reach its bytes
-- — one list() call enumerates the whole bucket, and the top folder is the job
-- id. Paths leak from other tables too: `opening_phases` holds finished-work
-- photo paths that have no attachments row of their own (20260959000000 says
-- so, while collecting them for a purge) behind a company-wide read this file
-- does not touch.
--
-- So the honest sentence is: this migration closes the LIST an installer's
-- gallery hands out. It does not close the bucket, and nothing here should be
-- read as having closed it. The bucket stays where 20260988000000 left it, for
-- the reason that migration wrote down — its paths are not all job folders
-- ("receipts/…" is one), so there is no folder rule to write yet. Scoping the
-- bytes is a change of its own, with its own decision to take.

-- ---------------------------------------------------------------------------
-- 1. Indexes the read rule leans on
-- ---------------------------------------------------------------------------
-- time_shifts already has (profile_id, clock_in_at desc), which finds a
-- person's shifts but still has to visit the heap for every one of them to
-- learn the job. This makes "which jobs has this person clocked into" an
-- index-only scan, which is what the policy asks on every photo read.
create index if not exists time_shifts_profile_project_idx
  on time_shifts (profile_id, project_id);

-- unit_sessions is indexed by opening and by "the one open session per person"
-- (a partial unique index, useless for history). This is the whole-history
-- lookup the rule needs.
create index if not exists unit_sessions_profile_idx
  on unit_sessions (profile_id, opening_id);


-- ---------------------------------------------------------------------------
-- 2. my_worked_project_ids() — the jobs I have worked
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, and for a reason worth stating: the answer must be a fact
-- about MY WORK, not a shadow of what I am currently allowed to read. Running
-- as the caller would make an installer's gallery quietly shrink the day
-- somebody narrows the read policy on time_shifts, unit_sessions or the crew
-- board — three tables with nothing to do with photos. It leaks nothing: every
-- branch is keyed to auth.uid(), so the only rows it can reach are the caller's
-- own, and the only thing it returns is a list of job ids that caller worked.
create or replace function public.my_worked_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select project_id
    from time_shifts
   where profile_id = auth.uid()
     and project_id is not null
  union
  select sa.project_id
    from schedule_assignment_members m
    join schedule_assignments sa on sa.id = m.assignment_id
   where m.profile_id = auth.uid()
     and sa.status = 'published'
  union
  select po.project_id
    from unit_sessions us
    join project_openings po on po.id = us.opening_id
   where us.profile_id = auth.uid();
$$;

comment on function public.my_worked_project_ids() is
  'The jobs the calling user has actually worked: any time_shifts row, any PUBLISHED crew-board assignment they are a member of, or any unit session on one of the job''s openings. The read rule behind an installer''s photo gallery, and the source list_my_worked_jobs() names. SECURITY DEFINER so the answer is about the caller''s work rather than about what the caller may currently read — every branch is keyed to auth.uid(), so it can reach no rows but their own.';

revoke all on function public.my_worked_project_ids() from public, anon;
grant execute on function public.my_worked_project_ids() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. attachment_project_ids() — which job a photo is about
-- ---------------------------------------------------------------------------
-- An attachments row hangs off ONE of five things (`attachments_target`,
-- 20260989000000) and may carry a sixth column besides (`service_case_id`,
-- 20260718070000, which that constraint still does not list). Every one of them
-- has to resolve, and the danger is the opposite of a sieve. A column with no
-- branch here yields nothing, so the job test is NULL, every other test in the
-- policy is false, and RLS reads "not true" as no. A photo naming only that
-- column would belong to no job and go INVISIBLE below foreman — including to
-- the crew who took it. That is the failure to hold in mind when a seventh
-- target column turns up: not a leak, a picture of real work disappearing off
-- the phone of the person who photographed it.
--
--   project_id           the job itself
--   window_id            windows.project_id
--   install_event_id     install_events.project_opening_id -> the opening's job
--                        (install_events has NO project_id of its own — it
--                        never has; see 20260715120000)
--   project_opening_id   project_openings.project_id
--   package_id           packages.project_id
--   service_case_id      service_cases.project_id
--
-- SECURITY DEFINER for the same reason as above, plus a specific one:
-- `project_openings` hides soft-removed openings from every reader
-- (openings_select_live, 20260730210000), and a photo of a real unit must not
-- become unreadable to the crew who took it because somebody later removed the
-- opening row. Resolution is a question about the DATA, not about the reader.
--
-- The partner guard is repeated INSIDE this function rather than left to the
-- policy that calls it, because this one takes ids as arguments: without it, a
-- builder's login could hand it a window id and learn which job that window
-- belongs to — the exact mapping the wall exists to withhold.
create or replace function public.attachment_project_ids(
  p_project_id uuid,
  p_window_id uuid,
  p_install_event_id uuid,
  p_project_opening_id uuid,
  p_package_id uuid,
  p_service_case_id uuid
)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pid from (
    select p_project_id as pid
    where p_project_id is not null
    union all
    select w.project_id
      from windows w
     where w.id = p_window_id
    union all
    select po.project_id
      from install_events ie
      join project_openings po on po.id = ie.project_opening_id
     where ie.id = p_install_event_id
    union all
    select po.project_id
      from project_openings po
     where po.id = p_project_opening_id
    union all
    select pk.project_id
      from packages pk
     where pk.id = p_package_id
    union all
    select sc.project_id
      from service_cases sc
     where sc.id = p_service_case_id
  ) resolved
  where pid is not null
    and not public.is_partner_user();
$$;

comment on function public.attachment_project_ids(uuid, uuid, uuid, uuid, uuid, uuid) is
  'Every job an attachments row resolves to, across all six of its target columns — the job directly, or through the window, install event, opening, package or service case it hangs off. Answers nothing to a partner login. SECURITY DEFINER so a soft-removed opening still resolves: which job a photo is about is a fact about the data, not about who is looking.';

revoke all on function public.attachment_project_ids(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.attachment_project_ids(uuid, uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. is_my_upload_name() — "did I take this one"
-- ---------------------------------------------------------------------------
-- `attachments.created_by` is TEXT and has been written two ways for as long as
-- the column has existed: a phone writes the signed-in EMAIL, and the server
-- writers (add_field_unit, 20260977000000 then 20260980000000) write the
-- profile's DISPLAY NAME. Only the first one counts here, and the reason is the
-- whole point of the function.
--
-- A DISPLAY NAME IS A CLAIM, NOT A FACT. Matching it looked like plain
-- fairness: the app filed that photo on your behalf, so it is yours. But
-- `display_name` is a column every crew member may write on their own row
-- (`grant update (display_name, ...) to authenticated` under
-- profiles_update_self_or_lead, 20260729200000), the crew directory is readable
-- by all of them, and the photo feed prints the uploader string on every shot a
-- person may already see. So the walk-around is four steps and no tooling: read
-- a colleague's name off a photo, type it into your own profile, reload
-- /photos, and every photo the app ever filed for that person, on every job in
-- the company, is theirs no longer. A rule you can step past by renaming
-- yourself is not a rule. The email survives because it is not a claim: it is
-- in the SIGNED token, and public signup is off.
--
-- WHAT THE SERVER-FILED PHOTOS FALL BACK ON, so nothing is stranded. Both
-- writers set `project_id` to the job in the same insert, so those rows are
-- caught by the job test below for everybody who worked that job — which
-- includes the person who added the missed unit, who was standing on it. And
-- foreman and above see them either way.
--
-- NOT security definer, and now it reads no table at all: `auth.jwt()` is the
-- caller's own token.
create or replace function public.is_my_upload_name(p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(btrim(coalesce(p_created_by, '')), '') is not null
     and lower(btrim(p_created_by))
         = lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
$$;

comment on function public.is_my_upload_name(text) is
  'True when an attachments.created_by string is the calling user''s signed-in email. Deliberately NOT matched against profiles.display_name: that column is self-editable by every crew member, so matching it would let anybody read another person''s uploads by renaming themselves. A photo the server filed under a display name (add_field_unit) reaches its author through the job that same insert names.';

revoke all on function public.is_my_upload_name(text) from public, anon;
grant execute on function public.is_my_upload_name(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. list_my_worked_jobs() — the job filter an installer's gallery offers
-- ---------------------------------------------------------------------------
-- The picker and the policy must agree, or the screen offers jobs whose photos
-- come back empty. One source: both read my_worked_project_ids().
--
-- Deliberately NOT security definer and deliberately NOT filtered by status.
-- Invoker so `projects`' own RLS still applies — the partner grants clause and
-- wave D's trash invisibility are that table's business, not this function's.
-- Every status, because a job somebody worked in March is finished by
-- September and its photos are still theirs to look up.
create or replace function public.list_my_worked_jobs()
returns table (id uuid, job_code text, name text)
language sql
stable
set search_path = public, pg_temp
as $$
  select p.id, p.job_code, p.name
    from projects p
   where p.deleted_at is null
     and p.id in (select public.my_worked_project_ids())
   order by p.job_code;
$$;

comment on function public.list_my_worked_jobs() is
  'The jobs the caller has worked, named for a picker: id, job code, name, in job-code order. Reads my_worked_project_ids() so the list an installer''s photo gallery offers is the same set its RLS will actually return. Security INVOKER: projects'' own policies still decide which of those rows come back.';

revoke all on function public.list_my_worked_jobs() from public, anon;
grant execute on function public.list_my_worked_jobs() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. The attachments policies: one FOR ALL becomes four per-command
-- ---------------------------------------------------------------------------
-- Read narrows. Insert, update and delete are restated at exactly the width
-- they have today.
drop policy if exists "authenticated full access" on attachments;

drop policy if exists "attachments_select" on attachments;
create policy "attachments_select" on attachments
  for select to authenticated
  using (
    not public.is_partner_user()
    and (
      -- Foreman and above: unchanged, and checked first so their read costs
      -- one stable function call for the whole query rather than a lookup per
      -- row.
      public.my_role_rank() >= 1
      -- Mine, wherever it was filed — by the signed-in email only, never by a
      -- name somebody can type into their own profile.
      or public.is_my_upload_name(created_by)
      -- The common shape, answered without resolving anything: the row names
      -- the job outright.
      or project_id in (select public.my_worked_project_ids())
      -- And every other way a row names a job. The result column is aliased
      -- to a name no table here has: calling it `project_id` would put a bare
      -- `project_id` inside a subquery that also sees the attachments row —
      -- the 2026-09-02 shape, where the wrong one binds and nothing errors.
      or exists (
        select 1
          from public.attachment_project_ids(
                 project_id,
                 window_id,
                 install_event_id,
                 project_opening_id,
                 package_id,
                 service_case_id
               ) as target(worked_id)
         where target.worked_id in (select public.my_worked_project_ids())
      )
    )
  );

drop policy if exists "attachments_insert" on attachments;
create policy "attachments_insert" on attachments
  for insert to authenticated
  with check (not public.is_partner_user());

drop policy if exists "attachments_update" on attachments;
create policy "attachments_update" on attachments
  for update to authenticated
  using (not public.is_partner_user())
  with check (not public.is_partner_user());

drop policy if exists "attachments_delete" on attachments;
create policy "attachments_delete" on attachments
  for delete to authenticated
  using (not public.is_partner_user());
