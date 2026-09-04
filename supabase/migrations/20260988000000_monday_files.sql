-- Monday files (owner's decision, 2026-09-04): "when we build a job from a
-- Monday row, the PDFs on that row should come with it."
--
-- The office has always kept a job's paperwork on the Monday item — the
-- building plans, the signed CAD sheets, the quote, the marked-up survey — and
-- the app has never seen any of it. Somebody downloaded each file from Monday
-- and uploaded it again on the Plans page, by hand, every time. This migration
-- is the storage half of stopping that.
--
-- The naming convention is the office's own, not ours: a file called "LP" is
-- the building PLANS ("LP" = the plan set), a file called "CU" is the SPECS
-- (the CAD/cut sheets), and everything else is a job document worth keeping
-- but not worth extracting. The guess is made in the app
-- (`guessMondayFileKind`), shown to the office before anything is pulled, and
-- always overridable — because a convention that holds on most rows is a
-- convention that will be wrong on one, and being wrong quietly is what turns
-- a spec sheet into a building plan the map then draws from.
--
-- FOUR THINGS, in the order they depend on each other:
--
--   1. monday_jobs.files    — what Monday says is attached to the row. A LIST,
--                             never the bytes and never a URL.
--   2. project_plansets
--        .source_asset_id   — which Monday file a planset came from, so the
--                             same file is never pulled twice.
--   3. project_documents    — the home a job document has never had, plus the
--      + job-documents        private bucket its bytes live in.
--   4. attach_sandbox_guards() — project_documents is project-scoped, so the
--                             test-login fence has to be re-armed over it.
--
-- IDEMPOTENT throughout (if not exists / do update / drop policy if exists
-- before create), so re-running it changes nothing.
--
-- NO NEW SECRET AND NO NEW EDGE FUNCTION: the pull is an action on the
-- existing monday-sync function, which already holds MONDAY_API_TOKEN. The
-- Monday board belongs to STG Windows and this app is a GUEST on it — every
-- call the function makes is a read, and a test in the app pins that.


-- ---------------------------------------------------------------------------
-- 1. F1 — what Monday says is attached to the row
-- ---------------------------------------------------------------------------
-- One JSON array per staged row:
--   [{ "asset_id": "3100578592", "name": "HC24 - LP.pdf", "ext": ".pdf",
--      "size": 17904294, "column_id": "files_1",
--      "uploaded_at": "2026-07-09T19:10:07Z" }]
--
-- WHY NO public_url. Monday hands out a `public_url` for an asset that is valid
-- for ONE HOUR. Storing it would mean a list that looks fine and 404s an hour
-- after the sync — and it would put a live, unauthenticated link to another
-- company's document in a table that a foreman can read. The asset id is
-- durable; the URL is asked for again, server-side, at the moment of the pull.
--
-- WHY A COLUMN AND NOT A TABLE. This is a mirror of somebody else's board,
-- rewritten whole on every sync, with no history worth keeping and nothing that
-- points at it. `raw` beside it is the same idea and has held for a year.
alter table monday_jobs
  add column if not exists files jsonb not null default '[]'::jsonb;

comment on column monday_jobs.files is
  'Files Monday says are attached to this item: [{asset_id, name, ext, size, column_id, uploaded_at}]. Rewritten by every sync. Never a public_url — Monday''s expires in an hour and is fetched fresh at pull time (Monday files, F1).';


-- ---------------------------------------------------------------------------
-- 2. F4 — which Monday file a planset came from
-- ---------------------------------------------------------------------------
-- Null for every planset somebody uploaded by hand, which is all of them today.
-- Set by the pull, and it is what makes the pull IDEMPOTENT: press Pull twice
-- on the same file and the second press is answered "already on the job"
-- instead of putting a second copy of the plans on the map. It is also half of
-- the "new on Monday" diff — a file is new exactly when no planset and no
-- document on this job carries its asset id.
alter table project_plansets
  add column if not exists source_asset_id text;

comment on column project_plansets.source_asset_id is
  'The Monday asset this planset was pulled from, or null when somebody uploaded it by hand. Unique per job, so pulling the same file twice is a no-op (Monday files, F4).';

-- PARTIAL, so the hundreds of hand-uploaded plansets carrying null are not
-- competing for one slot. Postgres ignores nulls in a unique index anyway; the
-- WHERE clause says the intent out loud and keeps the index small.
create unique index if not exists project_plansets_monday_asset_idx
  on project_plansets (project_id, source_asset_id)
  where source_asset_id is not null;


-- ---------------------------------------------------------------------------
-- 3. F6 — project_documents: the home a job document never had
-- ---------------------------------------------------------------------------
-- A job's paperwork is not all plans. "HC24 - Iron C.pdf" is the ironwork
-- order, "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf" is a signed
-- quote, and neither is something to run an extraction over — but both are
-- things a foreman standing on the site wants to be able to open. Until now the
-- app had exactly two slots, building plan and specs, and anything else either
-- got forced into one of them (where the extractor then tried to read it) or
-- stayed on Monday where the crew cannot reach it.
--
-- WRITTEN BY THE SERVER ONLY, in this version. Every row here today arrives
-- through the pull, which runs on the service role inside monday-sync: it is
-- the only thing that can prove a file really is attached to the Monday item it
-- claims to be. A crew-facing "attach a document" button is a fair next step
-- and it will need its own RPC and its own rules; leaving the client with no
-- INSERT grant at all is what stops that arriving by accident in the meantime.
create table if not exists project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The file's own name, as the office typed it on Monday. Kept separately from
  -- storage_path because the path is sanitised (see below) and a crew member
  -- should read the name the office knows the file by.
  name text not null,
  -- "<project_id>/<timestamp>-<safe name>" inside the job-documents bucket. A
  -- path, never a URL: the bucket is private and every open is a short-lived
  -- signed URL.
  storage_path text not null,
  size_bytes bigint,
  content_type text,
  source text not null default 'monday' check (source in ('monday', 'upload')),
  -- The Monday asset this came from; null for anything not pulled from Monday.
  source_asset_id text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table project_documents is
  'A job document that is not a planset — the quote, the signed order, the survey. Pulled from the job''s Monday item by monday-sync; the client holds no write grant (Monday files, F6).';

-- Every read is "this job's documents, newest first".
create index if not exists project_documents_project_idx
  on project_documents (project_id, created_at desc);

-- Same reasoning as the planset index above: pulling one Monday file twice is a
-- no-op, not a second row.
create unique index if not exists project_documents_monday_asset_idx
  on project_documents (project_id, source_asset_id)
  where source_asset_id is not null;

alter table project_documents enable row level security;

-- Revoke BEFORE granting. This project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS is not the wall on
-- its own: without this, a permissive policy added later by anybody would turn
-- a table with no write policy into a write hole.
revoke all on project_documents from anon, authenticated;
grant select on project_documents to authenticated;
grant all on project_documents to service_role;

-- WHO READS WHAT.
--   * Any crew member, on a job they can already see. The document list is the
--     same fact as the Plans list — paperwork for a job somebody is working —
--     and `projects`' own policy is what decides which jobs those are. Asking
--     it here rather than restating its rules means a job in the trash, or a
--     job a test login is fenced out of, disappears from this list for free.
--   * A partner (builder) login, never. THE WALL's mechanical guard, which
--     every crew table has carried since 20260950000000 and which
--     scripts/test_partner_wall.py checks dynamically. Worth saying plainly for
--     this table in particular: these are OUR documents about a builder's job —
--     the quote, the signed order — and handing them to the builder's own login
--     is exactly the accident the wall exists to prevent.
drop policy if exists "project_documents_select" on project_documents;
create policy "project_documents_select" on project_documents
  for select to authenticated
  using (
    not public.is_partner_user()
    and exists (
      select 1 from public.projects p where p.id = project_documents.project_id
    )
  );


-- ---------------------------------------------------------------------------
-- 4. F6 — the private bucket the bytes live in
-- ---------------------------------------------------------------------------
-- Not `plansets`, on purpose: the map, the Studio and the trace tools all treat
-- everything in that bucket as a drawing they might render, and a signed quote
-- is not one. A separate bucket also means the 80 MB cap below is stated for
-- documents without loosening or tightening plansets, where a 17 MB plan set is
-- ordinary.
--
-- SIZE CAP: 80 MB, the same number the pull refuses above, so a file too big to
-- pull is also a file the bucket would refuse — one limit, said twice, rather
-- than two limits that can drift apart.
--
-- `do update` rather than `do nothing`: re-running this migration against a
-- bucket somebody widened by hand puts the cap back, which is the point of an
-- idempotent migration. No allowed_mime_types list, deliberately — a job
-- document is whatever the office attached, and refusing a .heic photograph of
-- a signed page at the bucket would be refusing the office's own paperwork.
insert into storage.buckets (id, name, public, file_size_limit)
values ('job-documents', 'job-documents', false, 83886080)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- THE PATH IS THE PERMISSION, the same shape the credential-docs bucket uses:
-- every object is "<project_id>/<timestamp>-<safe name>", so the first folder
-- name IS the job, and the policy can be written against it.
--
-- The project id is compared AS TEXT rather than cast to uuid. A cast would be
-- an error on any object whose first folder is not a uuid, and Postgres makes
-- no promise about evaluating a guarding `~` regex before the cast beside it —
-- a single stray object would then break reads for the whole bucket.
--
-- Read: any crew member who can see the job, and no partner — the same sentence
-- as the table's own policy, asked of `projects` in the same way, so the list
-- and the bytes can never disagree about who may look.
--
-- Write: nobody, from a client, in this version. There is no INSERT, UPDATE or
-- DELETE policy here at all, so the only writer is the service role inside
-- monday-sync, which bypasses RLS. That is the same shape as the table's
-- grants above and for the same reason.
drop policy if exists "job documents read" on storage.objects;
create policy "job documents read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-documents'
    and not public.is_partner_user()
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(name))[1]
    )
  );


-- ---------------------------------------------------------------------------
-- 5. F6 — the bytes go when the row goes
-- ---------------------------------------------------------------------------
-- `project_documents.project_id` is ON DELETE CASCADE, so purging a job takes
-- every document row with it on the final `delete from projects`. That handles
-- the rows. It does NOT handle the BYTES: purge_project names each bucket it
-- clears by hand, and it was written before this bucket existed.
--
-- A trigger rather than a fourth copy of purge_project's 184-line body. The
-- alternative was re-declaring that whole function here to add one DELETE, and
-- app/src/lib/trashCascade.test.ts reads its definition out of
-- 20260974000000 by path — a second definition somewhere else is a copy that
-- test would stop watching, which is a worse trap than the leak it fixes.
--
-- This also covers every other way a document row can go, including the
-- "remove this document" button that does not exist yet. SECURITY DEFINER for
-- the same reason purge_project is: storage.objects belongs to the storage
-- admin, and only a definer-rights function can clear a row out of it.
--
-- Deliberately best-effort about the object already being gone: `delete` on a
-- name that is not there removes nothing and raises nothing, which is the right
-- answer for a purge that crashed halfway through and is being run again.
create or replace function public.forget_job_document_bytes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage.objects
   where bucket_id = 'job-documents'
     and name = old.storage_path;
  return old;
end;
$$;

comment on function public.forget_job_document_bytes() is
  'Clears a job document''s file out of the job-documents bucket when its row goes — including the cascade from purging a job, which purge_project does not name this bucket in (Monday files, F6).';

drop trigger if exists forget_job_document_bytes on project_documents;
create trigger forget_job_document_bytes
  after delete on project_documents
  for each row execute function public.forget_job_document_bytes();


-- ---------------------------------------------------------------------------
-- 6. Re-arm the test-login fence over the new table
-- ---------------------------------------------------------------------------
-- project_documents carries a project_id, which is what makes it project-scoped
-- and therefore something a test login must not be able to write outside its
-- sandbox. attach_sandbox_guards() is idempotent and re-attaches only what is
-- missing; scripts/test_sandbox_guard.py fails CI on a migration that adds a
-- project-scoped table and forgets this line.
select public.attach_sandbox_guards();
