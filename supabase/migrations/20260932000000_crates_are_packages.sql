-- Crates stop being containers (owner redesign, 2026-08-25, confirmed Q3):
-- a crate is a SEALED package — nothing ever goes in or out; it is stored,
-- moved, and finally broken up (deleted, thrown away in pieces). And since
-- nobody knows WHICH pieces ride in WHICH crate, the pieces don't belong
-- to a crate at all: they belong to the JOB'S CRATE POOL — "2 crates,
-- between them 33 pieces of glass" with the set-by-set breakdown. Every
-- crate's screen shows that same pooled truth.
--
--   * A crate = a package with part_type 'crate' (mfr_mark holds its name,
--     "CRATE 1"). Storable like any box; deleting it is breaking it up.
--   * The pool = the existing per-mark piece_count rows, no longer tied to
--     any container. Their physical location reads "in the job's crates."
--   * set_piece_count edits a pool row's number as glass gets used — by
--     hand, on purpose (v1 has no automatic tie to installs).
--   * add_job_crate adds one more crate when reality shows up with more;
--     removing one is the ordinary package delete.
--
-- Existing crate CONTAINERS convert right here: one sealed crate package
-- each, pieces detached to the pool, the container rows deleted
-- (movements' container references are ON DELETE SET NULL).

-- ------------------------------------------------ 1. convert what exists

do $$
declare
  c record;
  v_sample packages%rowtype;
  v_name text;
begin
  for c in select * from storage_containers where kind = 'crate'
  loop
    select * into v_sample from packages
    where container_id = c.id and piece_count is not null
    limit 1;

    -- "ESH-18 · Crate 1" -> "CRATE 1"; a name with no separator rides whole.
    v_name := upper(trim(coalesce(
      nullif(split_part(c.name, '·', 2), ''), c.name
    )));

    if v_sample.id is not null then
      insert into packages
        (status, project_id, category, part_type, mfr_mark,
         pending_job_name, pending_issue_id, delivery_id,
         short_code, bound_at, bound_by)
      values
        ('received', v_sample.project_id, 'other', 'crate', v_name,
         v_sample.pending_job_name, v_sample.pending_issue_id,
         v_sample.delivery_id,
         issue_package_short_code(), now(), 'migration-20260932');
    end if;

    update packages
    set container_id = null,
        status = case when status = 'stored' then 'received' else status end
    where container_id = c.id;

    delete from storage_containers where id = c.id;
  end loop;
end;
$$;

-- ---------------------------------- 2. the wizard writes the new shape

-- Same signature as 20260926; the crate branch now creates POOL rows only
-- (no container, no auto-store). Crate packages are made per distinct name
-- by create_manual_delivery below, which sees the whole entry.
create or replace function public.create_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text,
  p_crate_pieces int,
  p_crate_part_type text,
  p_quantity int default 1,
  p_job_name text default null,
  p_issue uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mark_code text := upper(regexp_replace(trim(coalesce(p_mark, '')), '^#', ''));
  v_mark uuid;
  v_category text := case when p_kind = 'door' then 'doors' else 'windows' end;
  v_row packages;
  v_created int := 0;
  v_qty int := coalesce(p_quantity, 1);
  i int;
  u int;
begin
  if length(v_mark_code) < 1 then
    raise exception 'Every set needs a mark, like 16 or 13A.';
  end if;
  if p_package_count is null or p_package_count < 1 or p_package_count > 20 then
    raise exception 'A set arrives as 1 to 20 packages.';
  end if;
  if v_qty < 1 or v_qty > 20 then
    raise exception 'Identical clones go 1 to 20 at a time.';
  end if;
  if p_project is null and nullif(trim(coalesce(p_job_name, '')), '') is null then
    raise exception 'A set needs a job — picked, or at least named.';
  end if;
  if p_crate_name is not null and trim(p_crate_name) <> ''
     and (p_crate_pieces is null or p_crate_pieces < 1 or p_crate_pieces > 99) then
    raise exception 'Say how many pieces of #% ride in the crates (1-99).', v_mark_code;
  end if;

  if p_project is not null then
    insert into project_marks (project_id, mark_code)
    values (p_project, v_mark_code)
    on conflict (project_id, mark_code) do nothing;
    select id into v_mark from project_marks
    where project_id = p_project and mark_code = v_mark_code;
  end if;

  for u in 1..v_qty loop
    for i in 1..p_package_count loop
      insert into packages
        (status, project_id, category, part_index, part_total, mfr_mark,
         pending_job_name, pending_issue_id,
         delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', p_project, v_category, i, p_package_count, v_mark_code,
         case when p_project is null then trim(p_job_name) end,
         case when p_project is null then p_issue end,
         p_delivery, issue_package_short_code(), now(), auth.uid()::text)
      returning * into v_row;
      if v_mark is not null then
        insert into package_marks (package_id, mark_id)
        values (v_row.id, v_mark) on conflict do nothing;
      end if;
      insert into movements (package_id, event, project_id, actor, reason)
      values (v_row.id, 'preissued', p_project, auth.uid()::text,
              'expected off the truck — part ' || i || ' of ' || p_package_count
              || case when v_qty > 1 then ' (unit ' || u || ' of ' || v_qty || ' identical)' else '' end);
      v_created := v_created + 1;
    end loop;

    if p_crate_name is not null and trim(p_crate_name) <> '' then
      -- The POOL: pieces belong to the job's crates collectively.
      insert into packages
        (status, project_id, category, part_type, piece_count, mfr_mark,
         pending_job_name, pending_issue_id,
         delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', p_project, v_category,
         lower(trim(coalesce(nullif(p_crate_part_type, ''), 'glass'))), p_crate_pieces, v_mark_code,
         case when p_project is null then trim(p_job_name) end,
         case when p_project is null then p_issue end,
         p_delivery, issue_package_short_code(), now(), auth.uid()::text)
      returning * into v_row;
      if v_mark is not null then
        insert into package_marks (package_id, mark_id)
        values (v_row.id, v_mark) on conflict do nothing;
      end if;
      insert into movements (package_id, event, project_id, actor, reason)
      values (v_row.id, 'preissued', p_project, auth.uid()::text,
              'expected off the truck — ' || p_crate_pieces || ' piece(s) riding in the job''s crates'
              || case when v_qty > 1 then ' (unit ' || u || ' of ' || v_qty || ' identical)' else '' end);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- create_manual_delivery: same signature, rebuilt — after each entry's
-- sets, one sealed crate package per DISTINCT crate name in that entry.
create or replace function create_manual_delivery(
  p_label text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery uuid;
  v_entry jsonb;
  v_set jsonb;
  v_project uuid;
  v_job_name text;
  v_issue uuid;
  v_crate_name text;
  v_created int := 0;
  v_unfiled int := 0;
  v_entry_count int := 0;
  v_set_count int;
  v_n int;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can log a delivery by hand.'
      using errcode = '42501';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 then
    raise exception 'Log at least one job''s material.';
  end if;
  if jsonb_array_length(p_entries) > 17 then
    raise exception 'A delivery covers at most 17 jobs.';
  end if;

  insert into package_deliveries (label, arrived_on, created_by)
  values (
    coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery'),
    current_date,
    auth.uid()::text
  )
  returning id into v_delivery;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_entry_count := v_entry_count + 1;
    v_project := nullif(v_entry->>'project_id', '')::uuid;
    v_job_name := nullif(trim(coalesce(v_entry->>'job_name', '')), '');
    if v_project is null and v_job_name is null then
      raise exception 'Entry % names no job.', v_entry_count;
    end if;
    if jsonb_typeof(v_entry->'sets') <> 'array'
       or jsonb_array_length(v_entry->'sets') < 1 then
      raise exception 'Job % has no sets.', v_entry_count;
    end if;
    v_set_count := jsonb_array_length(v_entry->'sets');
    if v_set_count > 50 then
      raise exception 'A job takes at most 50 sets in one delivery.';
    end if;

    v_issue := null;
    if v_project is null then
      insert into issues (project_id, kind, urgency, note, created_by)
      values (
        null, 'missing_job', 'normal',
        'Build the job "' || v_job_name || '" — ' || v_set_count ||
        ' set(s) from the delivery "' ||
        coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery') ||
        '" arrived under that name and are waiting to be filed.',
        auth.uid()
      )
      returning id into v_issue;
    end if;

    for v_set in select * from jsonb_array_elements(v_entry->'sets') loop
      v_n := public.create_delivery_set(
        v_delivery, v_project,
        v_set->>'mark',
        coalesce(v_set->>'kind', 'window'),
        (v_set->>'package_count')::int,
        v_set#>>'{crate,name}',
        (v_set#>>'{crate,pieces}')::int,
        v_set#>>'{crate,part_type}',
        coalesce((v_set->>'quantity')::int, 1),
        v_job_name,
        v_issue
      );
      v_created := v_created + v_n;
      if v_project is null then
        v_unfiled := v_unfiled + v_n;
      end if;
    end loop;

    -- One sealed crate per distinct name this entry mentioned.
    for v_crate_name in
      select distinct upper(trim(s#>>'{crate,name}'))
      from jsonb_array_elements(v_entry->'sets') s
      where nullif(trim(coalesce(s#>>'{crate,name}', '')), '') is not null
    loop
      insert into packages
        (status, project_id, category, part_type, mfr_mark,
         pending_job_name, pending_issue_id,
         delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', v_project, 'other', 'crate', v_crate_name,
         case when v_project is null then v_job_name end,
         case when v_project is null then v_issue end,
         v_delivery, issue_package_short_code(), now(), auth.uid()::text);
      v_created := v_created + 1;
      if v_project is null then
        v_unfiled := v_unfiled + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'delivery_id', v_delivery,
    'created', v_created,
    'unfiled', v_unfiled,
    'pending', 0
  );
end;
$$;

grant execute on function create_manual_delivery(text, jsonb) to authenticated;

-- file_pending_packages: rebuilt with one guard — a crate package's
-- mfr_mark is its NAME, never a schedule mark; don't register it.
create or replace function file_pending_packages(
  p_package_ids uuid[],
  p_project uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_mark uuid;
  v_id uuid;
  v_issue uuid;
  v_count int := 0;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can file material onto a job.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  foreach v_id in array coalesce(p_package_ids, array[]::uuid[])
  loop
    select * into v_row from packages
    where id = v_id and project_id is null and pending_job_name is not null;
    if not found then
      continue;
    end if;

    v_issue := v_row.pending_issue_id;

    update packages
    set project_id = p_project,
        pending_job_name = null,
        pending_issue_id = null
    where id = v_id;

    if v_row.mfr_mark is not null and coalesce(v_row.part_type, '') <> 'crate' then
      insert into project_marks (project_id, mark_code)
      values (p_project, v_row.mfr_mark)
      on conflict (project_id, mark_code) do nothing;
      select id into v_mark from project_marks
      where project_id = p_project and mark_code = v_row.mfr_mark;
      insert into package_marks (package_id, mark_id)
      values (v_id, v_mark) on conflict do nothing;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'assigned', p_project, auth.uid()::text,
            'filed onto the job — was waiting as "' || v_row.pending_job_name || '"');
    v_count := v_count + 1;

    if v_issue is not null and not exists (
      select 1 from packages
      where pending_issue_id = v_issue and project_id is null
    ) then
      update issues
         set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
       where id = v_issue and status = 'open';
    end if;
  end loop;

  return v_count;
end;
$$;

grant execute on function file_pending_packages(uuid[], uuid) to authenticated;

-- --------------------------------- 3. edit the pool, add another crate

create or replace function set_piece_count(p_package uuid, p_count int)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row packages;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_count is null or p_count < 1 or p_count > 99 then
    raise exception 'Pieces go 1 to 99 — when a set''s crate glass is all used, delete its row instead.';
  end if;
  update packages
  set piece_count = p_count
  where id = p_package and piece_count is not null
  returning * into v_row;
  if not found then
    raise exception 'That row is not crate-pool glass.';
  end if;
  return v_row;
end;
$$;

grant execute on function set_piece_count(uuid, int) to authenticated;

create or replace function add_job_crate(
  p_project uuid,
  p_name text default null
)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
  v_name text;
  v_row packages;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;
  select count(*) + 1 into v_n from packages
  where project_id = p_project and part_type = 'crate';
  v_name := upper(trim(coalesce(nullif(p_name, ''), 'Crate ' || v_n)));
  insert into packages
    (status, project_id, category, part_type, mfr_mark,
     short_code, bound_at, bound_by)
  values
    ('received', p_project, 'other', 'crate', v_name,
     issue_package_short_code(), now(), auth.uid()::text)
  returning * into v_row;
  insert into movements (package_id, event, project_id, actor, reason)
  values (v_row.id, 'received', p_project, auth.uid()::text,
          'one more crate than the list said — added to match reality');
  return v_row;
end;
$$;

grant execute on function add_job_crate(uuid, text) to authenticated;
