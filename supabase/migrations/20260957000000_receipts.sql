-- Wave P, P1: receipts that read themselves — the model.
--
-- Owner decisions (grill, settled — cited, never re-decided; see the spec's
-- opening block, scratchpad/p1-receipts-spec.md): ANYONE signed in may snap
-- a receipt; the job field is OPTIONAL (gas is often jobless) with smart
-- suggestions; supervisors+ review the office table; "bill this to the
-- customer?" is asked at upload and the office can flip it later.
--
-- Horizon mechanisms ported (survey-verified, cited in the spec):
--   - OCR fills ONLY blank fields, never a human's typing.
--   - A re-scan refreshes machine guesses, but never a manual classification
--     (category_by = 'manual' pins forever — see apply_receipt_extraction).
--   - ocr jsonb keeps the machine's verbatim output, for audit.
--
-- House rule, same as daily_logs/timecard_periods/capability_badges: zero
-- insert/update/delete policies below. file_receipt / update_receipt /
-- review_receipt / apply_receipt_extraction (all SECURITY DEFINER,
-- search_path pinned) are the only writers, so there is no direct-write path
-- that could skip a rule any of them enforce.
--
-- Storage: photos live in the existing install-media bucket (already open to
-- `authenticated` for all buckets it covers — 20260715120000), at
-- `receipts/<id>.jpg`, mirroring packagePhotoPath's per-row convention
-- (app/src/lib/storage.ts). The id is minted client-side (crypto.randomUUID)
-- so the upload and the file_receipt call can travel the offline outbox
-- independently and still agree on the path once both land.

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  -- The waiting-job convention (packages.pending_job_name, 20260926000000):
  -- typed at upload when the job isn't built in the app yet, or left null on
  -- purpose for a jobless receipt (gas is the common case).
  pending_job_name text
    check (pending_job_name is null or length(trim(pending_job_name)) between 1 and 80),
  photo_path text not null,
  amount_cents int check (amount_cents is null or amount_cents >= 0),
  vendor text,
  purchased_on date,
  category text check (category in ('gas', 'other')),
  category_by text check (category_by in ('ai', 'manual')),
  -- null = not answered yet — the upload flow's one skippable question.
  is_passthrough boolean,
  note text,
  -- Verbatim machine output from the last extract-receipt run, kept for
  -- audit regardless of what actually filled into the row's own columns.
  ocr jsonb,
  created_at timestamptz not null default now(),
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  -- category_by only means something alongside a category, and a category
  -- with no provenance would be unauditable — the two move together always.
  constraint receipts_category_by_pairs_with_category
    check ((category is null) = (category_by is null)),
  -- A real job or a typed waiting-job name, never both at once — the same
  -- rule packages.pending_job_name enforces at the app layer, made a real
  -- constraint here since receipts has no equivalent app-side gate yet.
  constraint receipts_job_xor_pending
    check (project_id is null or pending_job_name is null)
);

create index if not exists receipts_project_idx on receipts (project_id, created_at desc);
create index if not exists receipts_uploaded_by_idx on receipts (uploaded_by, created_at desc);
create index if not exists receipts_unreviewed_idx on receipts (reviewed_at) where reviewed_at is null;

comment on table receipts is
  'Wave P: a snapped receipt, machine-read then human-confirmed. RPC-only writes — file_receipt (file it), update_receipt (uploader-or-supervisor field edits), review_receipt (supervisor+ mark reviewed), apply_receipt_extraction (extract-receipt''s fill-missing-only OCR merge). See each function''s own comment.';
comment on column receipts.pending_job_name is
  'The job name typed at upload when the job is not built in the app yet, or left null on purpose for a jobless receipt (e.g. gas). Mirrors packages.pending_job_name (20260926000000) — the same waiting-job convention.';
comment on column receipts.category_by is
  'Who set category: ai (extract-receipt''s fill-missing-only guess) or manual (a human typed or flipped it — permanently locked against ever being overwritten by a rescan). Null means unanswered.';
comment on column receipts.ocr is
  'Verbatim machine output from the last extract-receipt run (amount_cents/vendor/purchased_on/category/line_items as the model returned them). Audit only — never read back into the fill-missing-only merge; the row''s own columns are what the merge checks and sets.';

alter table receipts enable row level security;

-- Foreman+ sees every receipt (the office needs the whole feed to review).
-- Below that floor an uploader still sees their OWN uploads — an installer
-- who snapped a gas receipt needs to see it land and get reviewed, but
-- never the rest of the company's spending.
drop policy if exists "receipts_select" on receipts;
create policy "receipts_select" on receipts
  for select to authenticated
  using (
    not public.is_partner_user()
    and (public.my_role_rank() >= 1 or uploaded_by = auth.uid())
  );
-- No insert/update/delete policy — the four SECURITY DEFINER functions below
-- are the only writers.

revoke all on table receipts from anon, authenticated;
grant select on table receipts to authenticated;


-- ---------------------------------------------------------------- file_receipt
-- Any authenticated crew member may file a receipt — the spec's "ANYONE
-- signed in snaps receipts" (Q, settled). Idempotent on id: the phone mints
-- the id BEFORE queueing (so the storage upload and this call can travel the
-- offline outbox independently), and a retried offline write must land on
-- the same row rather than erroring or duplicating.
create or replace function public.file_receipt(
  p_id uuid,
  p_photo_path text,
  p_project_id uuid default null,
  p_pending_job_name text default null,
  p_note text default null
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pending text := nullif(btrim(coalesce(p_pending_job_name, '')), '');
  v_row receipts;
begin
  if v_uid is null then
    raise exception 'sign in to file a receipt';
  end if;
  if p_id is null then
    raise exception 'a receipt needs an id';
  end if;
  if p_photo_path is null or btrim(p_photo_path) = '' then
    raise exception 'a receipt needs its photo';
  end if;
  if p_project_id is not null and v_pending is not null then
    raise exception 'a receipt names a real job or a waiting-job name, never both';
  end if;

  insert into receipts (id, uploaded_by, project_id, pending_job_name, photo_path, note)
  values (p_id, v_uid, p_project_id, v_pending, p_photo_path, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Already filed — a resend after a lost reply (the conex-wall pattern
    -- this whole outbox is built for). Hand back the row that already
    -- exists rather than erroring; the caller cannot tell the two apart and
    -- should not have to.
    select * into v_row from receipts where id = p_id;
  end if;

  return v_row;
end;
$$;

comment on function public.file_receipt(uuid, text, uuid, text, text) is
  'Files a receipt: any signed-in user, id minted client-side so the storage upload and this call can land independently through the offline outbox. Idempotent on id.';

revoke all on function public.file_receipt(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.file_receipt(uuid, text, uuid, text, text) to authenticated;


-- -------------------------------------------------------------- update_receipt
-- The human field-edit path: the uploader may fix up their own receipt, and
-- a supervisor+ may edit any receipt from the office table (spec: "uploader-
-- or-supervisor for fields"). Full-record overwrite (the file_daily_log
-- pattern) — the caller sends the complete edited set every time, including
-- fields it means to leave unchanged, so there is no ambiguity about what a
-- missing argument means.
--
-- category is the one field with memory: category_by flips to 'manual' only
-- when this call actually CHANGES the stored category (`is distinct from`,
-- true whether it was null or some other value) — resending the SAME value
-- a prior AI fill already set (e.g. saving an unrelated field edit from the
-- office table's form) must not silently convert an AI guess into a locked
-- manual one. Clearing the category (p_category null) clears category_by
-- with it, so the pair-invariant constraint above never trips.
create or replace function public.update_receipt(
  p_id uuid,
  p_project_id uuid,
  p_pending_job_name text,
  p_amount_cents int,
  p_vendor text,
  p_purchased_on date,
  p_category text,
  p_is_passthrough boolean,
  p_note text
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_pending text := nullif(btrim(coalesce(p_pending_job_name, '')), '');
  v_row receipts;
begin
  select uploaded_by into v_uploader from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can edit this receipt'
      using errcode = '42501';
  end if;
  if p_project_id is not null and v_pending is not null then
    raise exception 'a receipt names a real job or a waiting-job name, never both';
  end if;
  if p_category is not null and p_category not in ('gas', 'other') then
    raise exception 'category must be gas or other';
  end if;
  if p_amount_cents is not null and p_amount_cents < 0 then
    raise exception 'amount cannot be negative';
  end if;

  update receipts set
    project_id      = p_project_id,
    pending_job_name = v_pending,
    amount_cents    = p_amount_cents,
    vendor          = nullif(btrim(coalesce(p_vendor, '')), ''),
    purchased_on    = p_purchased_on,
    category        = p_category,
    category_by     = case
      when p_category is null then null
      when category is distinct from p_category then 'manual'
      else category_by
    end,
    is_passthrough  = p_is_passthrough,
    note            = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) is
  'Uploader-or-supervisor field edits (full-record overwrite, file_daily_log-style). Changing category here pins category_by=''manual'' forever; resending the same category value leaves its provenance untouched.';

revoke all on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) from public, anon;
grant execute on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) to authenticated;


-- -------------------------------------------------------------- review_receipt
-- Supervisor+ marks a receipt reviewed (or un-reviews it — the office
-- table's "reviewed check" is a flippable checkbox, not a one-way gate).
create or replace function public.review_receipt(
  p_id uuid,
  p_reviewed boolean default true
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row receipts;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or above can review a receipt'
      using errcode = '42501';
  end if;

  update receipts set
    reviewed_by = case when p_reviewed then auth.uid() else null end,
    reviewed_at = case when p_reviewed then now() else null end
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such receipt';
  end if;
  return v_row;
end;
$$;

comment on function public.review_receipt(uuid, boolean) is
  'Supervisor+ marks (or unmarks) a receipt reviewed, for the office table''s reviewed checkbox.';

revoke all on function public.review_receipt(uuid, boolean) from public, anon;
grant execute on function public.review_receipt(uuid, boolean) to authenticated;


-- ------------------------------------------------------- apply_receipt_extraction
-- The machine-write path, called by the client right after extract-receipt
-- (P2) returns a raw reading — never called directly with user-typed values,
-- which is what update_receipt is for. THE LAW, enforced here and nowhere
-- else: a null column takes the machine's value; a column that already
-- holds something (human-typed OR a prior machine fill) is left exactly as
-- it is. There is no "force overwrite" path — a re-scan (extract-receipt's
-- own p_force, a request-body flag on THAT function, not a SQL argument
-- here) only decides whether the vision call runs again; what it can change
-- in the row is governed by this same fill-missing-only merge, so a rescan
-- can never clobber a value — human or machine — that already made it into
-- the row. That is the one reading of the spec's two sentences ("OCR fills
-- ONLY blank fields, never overwrites a human's typing" / "re-scan
-- refreshes machine guesses but never a manual classification") that holds
-- BOTH of them as true at once with no carve-out — see the PR description
-- for the fuller reasoning and why this is the one place to scrutinize hardest.
--
-- category still gets its own explicit clause even though the coalesce
-- above would already leave a non-null category untouched, because
-- category_by has to move with it — the same pairing update_receipt keeps.
create or replace function public.apply_receipt_extraction(
  p_id uuid,
  p_amount_cents int,
  p_vendor text,
  p_purchased_on date,
  p_category text,
  p_ocr jsonb
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_row receipts;
begin
  select uploaded_by into v_uploader from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can extract this receipt'
      using errcode = '42501';
  end if;
  if p_category is not null and p_category not in ('gas', 'other') then
    raise exception 'category must be gas or other';
  end if;

  update receipts set
    amount_cents = coalesce(amount_cents, p_amount_cents),
    vendor       = coalesce(vendor, nullif(btrim(coalesce(p_vendor, '')), '')),
    purchased_on = coalesce(purchased_on, p_purchased_on),
    category     = case when category_by is null then coalesce(category, p_category) else category end,
    category_by  = case
      when category_by is null and coalesce(category, p_category) is not null then 'ai'
      else category_by
    end,
    ocr          = coalesce(p_ocr, ocr)
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.apply_receipt_extraction(uuid, int, text, date, text, jsonb) is
  'The fill-missing-only merge (THE LAW): a null column takes the machine value, anything already set (human or machine) is left alone. Called by the client with extract-receipt''s raw reading — never with user-typed values. See the function body comment for why there is no force-overwrite path.';

revoke all on function public.apply_receipt_extraction(uuid, int, text, date, text, jsonb) from public, anon;
grant execute on function public.apply_receipt_extraction(uuid, int, text, date, text, jsonb) to authenticated;
