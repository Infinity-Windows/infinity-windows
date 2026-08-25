-- Manual (QR-less) delivery logging + package deletion (owner asks,
-- 2026-08-21 night, delivery at the dock the next morning and no scanner or
-- label printer on hand yet):
--
--   1. delete_packages: multi-select, permanent, foreman+. History rows go
--      with the package (movements.package_id is ON DELETE CASCADE — that is
--      the point of a cleanup tool). A checked-out package REFUSES: deleting
--      it would hide real material that is on a truck or jobsite.
--   2. Custom part labels: the fixed frame/glass/... list becomes open. The
--      seven built-ins stay in the UI; anything else ("door handle") lives in
--      part_type_options, addable by any signed-in crew.
--   3. packages.piece_count: crate contents. A unit's crated glass is NOT one
--      of its 1-of-N packages (the loose ones honestly say 3/3); it is one
--      row per mark per crate saying "4 pieces of glass in Crate 1". It joins
--      the unit the same way everything does — package_marks — so the
--      completeness and split views need nothing new.
--   4. create_manual_delivery: the whole wizard lands atomically. Sets naming
--      a job that is not built yet park in pending_delivery_sets and raise a
--      missing_job issue for a supervisor (owner: "put it on the issues list,
--      don't block the unload"); materialize_pending_set turns them into real
--      packages once the job exists, and resolving is automatic when a
--      delivery's last pending set for that name is materialized.

-- ---------------------------------------------------------------- 1. delete

create or replace function delete_packages(p_package_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refused jsonb := '[]'::jsonb;
  v_deleted int := 0;
  v_row record;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can delete packages.'
      using errcode = '42501';
  end if;
  if p_package_ids is null or array_length(p_package_ids, 1) is null then
    return jsonb_build_object('deleted', 0, 'refused', v_refused);
  end if;
  if array_length(p_package_ids, 1) > 200 then
    raise exception 'Delete at most 200 packages in one sweep.';
  end if;

  for v_row in
    select p.id, p.serial, p.status
    from packages p
    where p.id = any (p_package_ids)
  loop
    if v_row.status = 'checked_out' then
      v_refused := v_refused || jsonb_build_object(
        'serial', v_row.serial,
        'reason', 'checked out — it is on a truck or jobsite, bring it back first'
      );
      continue;
    end if;
    delete from packages where id = v_row.id;
    v_deleted := v_deleted + 1;
  end loop;

  return jsonb_build_object('deleted', v_deleted, 'refused', v_refused);
end;
$$;

grant execute on function delete_packages(uuid[]) to authenticated;

-- ------------------------------------------------- 2. open part-type labels

alter table packages drop constraint if exists packages_part_type_ck;
alter table packages add constraint packages_part_type_ck
  check (part_type is null or length(trim(part_type)) between 1 and 40);

create table if not exists part_type_options (
  name text primary key check (length(trim(name)) between 1 and 40),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table part_type_options enable row level security;

drop policy if exists part_type_options_select on part_type_options;
create policy part_type_options_select on part_type_options
  for select to authenticated using (true);

create or replace function add_part_type_option(p_name text)
returns part_type_options
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_row part_type_options;
begin
  if length(v_name) < 1 or length(v_name) > 40 then
    raise exception 'A part label is 1 to 40 characters.';
  end if;
  insert into part_type_options (name, created_by)
  values (lower(v_name), auth.uid())
  on conflict (name) do update set name = part_type_options.name
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function add_part_type_option(text) to authenticated;

-- ------------------------------------------------------- 3. crate contents

alter table packages
  add column if not exists piece_count int
  check (piece_count is null or piece_count between 1 and 99);

comment on column packages.piece_count is
  'Crate contents: "4 pieces of glass for #16 in Crate 1". Null on ordinary 1-of-N packages. A piece-count row is never part of its unit''s package numbering.';

-- --------------------------------------------- 4a. pending sets + the issue

alter table issues alter column project_id drop not null;

alter table issues drop constraint if exists issues_kind_check;
alter table issues add constraint issues_kind_check
  check (kind in (
    'failed_install','flag','damage','blocker','complication','missing',
    'spec_gap','framing','missing_job'
  ));

create table if not exists pending_delivery_sets (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references package_deliveries(id) on delete cascade,
  job_name text not null check (length(trim(job_name)) between 1 and 80),
  mark_code text not null check (length(trim(mark_code)) between 1 and 20),
  kind text not null check (kind in ('window', 'door')),
  package_count int not null check (package_count between 1 and 20),
  crate_name text check (crate_name is null or length(trim(crate_name)) between 1 and 40),
  crate_pieces int check (crate_pieces is null or crate_pieces between 1 and 99),
  crate_part_type text check (crate_part_type is null or length(trim(crate_part_type)) between 1 and 40),
  issue_id uuid references issues(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  materialized_at timestamptz,
  materialized_project uuid references projects(id) on delete set null
);

create index if not exists pending_delivery_sets_delivery_idx
  on pending_delivery_sets (delivery_id);

alter table pending_delivery_sets enable row level security;

drop policy if exists pending_sets_select on pending_delivery_sets;
create policy pending_sets_select on pending_delivery_sets
  for select to authenticated using (true);

-- --------------------------------------------------- 4b. the wizard's write

-- One helper both the wizard and materialize use: creates the loose 1-of-N
-- packages and the optional crate piece-row for ONE set on a REAL job.
create or replace function public.create_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text,
  p_crate_pieces int,
  p_crate_part_type text
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
  v_crate uuid;
  v_crate_label text;
  v_job_code text;
  v_row packages;
  v_created int := 0;
  i int;
begin
  if length(v_mark_code) < 1 then
    raise exception 'Every set needs a mark, like 16 or 13A.';
  end if;
  if p_package_count is null or p_package_count < 1 or p_package_count > 20 then
    raise exception 'A set arrives as 1 to 20 packages.';
  end if;

  -- The mark registry: a hand-logged delivery may land before extraction has
  -- put the mark on the schedule. Logging the truck must not block on that.
  insert into project_marks (project_id, mark_code)
  values (p_project, v_mark_code)
  on conflict (project_id, mark_code) do nothing;
  select id into v_mark from project_marks
  where project_id = p_project and mark_code = v_mark_code;

  for i in 1..p_package_count loop
    insert into packages
      (status, project_id, category, part_index, part_total,
       delivery_id, short_code, bound_at, bound_by)
    values
      ('received', p_project, v_category, i, p_package_count,
       p_delivery, issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;
    insert into package_marks (package_id, mark_id)
    values (v_row.id, v_mark) on conflict do nothing;
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_row.id, 'received', p_project, auth.uid()::text,
            'logged by hand at the truck — part ' || i || ' of ' || p_package_count);
    v_created := v_created + 1;
  end loop;

  if p_crate_name is not null and trim(p_crate_name) <> '' then
    if p_crate_pieces is null or p_crate_pieces < 1 or p_crate_pieces > 99 then
      raise exception 'Say how many pieces of #% are in the crate (1-99).', v_mark_code;
    end if;
    select job_code into v_job_code from projects where id = p_project;
    v_crate_label := coalesce(v_job_code, 'JOB') || ' · ' || trim(p_crate_name);
    select id into v_crate from storage_containers
    where kind = 'crate' and name = v_crate_label
    limit 1;
    if v_crate is null then
      insert into storage_containers (name, kind)
      values (v_crate_label, 'crate')
      returning id into v_crate;
    end if;
    insert into packages
      (status, project_id, category, part_type, piece_count,
       container_id, delivery_id, short_code, bound_at, bound_by)
    values
      ('stored', p_project, v_category,
       lower(trim(coalesce(nullif(p_crate_part_type, ''), 'glass'))), p_crate_pieces,
       v_crate, p_delivery, issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;
    insert into package_marks (package_id, mark_id)
    values (v_row.id, v_mark) on conflict do nothing;
    insert into movements (package_id, event, project_id, actor, to_container_id, reason)
    values (v_row.id, 'received', p_project, auth.uid()::text, v_crate,
            'logged by hand at the truck — ' || p_crate_pieces || ' piece(s) in ' || v_crate_label);
    insert into movements (package_id, event, project_id, actor, to_container_id, reason)
    values (v_row.id, 'stored', p_project, auth.uid()::text, v_crate,
            'riding in ' || v_crate_label);
    v_created := v_created + 1;
  end if;

  return v_created;
end;
$$;

-- Not granted to clients: reached only through the two functions below.

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
  v_created int := 0;
  v_pending int := 0;
  v_entry_count int := 0;
  v_set_count int;
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

    if v_project is not null then
      for v_set in select * from jsonb_array_elements(v_entry->'sets') loop
        v_created := v_created + public.create_delivery_set(
          v_delivery, v_project,
          v_set->>'mark',
          coalesce(v_set->>'kind', 'window'),
          (v_set->>'package_count')::int,
          v_set#>>'{crate,name}',
          (v_set#>>'{crate,pieces}')::int,
          v_set#>>'{crate,part_type}'
        );
      end loop;
    else
      -- The job is not in the app yet. Park the sets, tell a supervisor,
      -- never block the unload (owner rule).
      insert into issues (project_id, kind, urgency, note, created_by)
      values (
        null, 'missing_job', 'normal',
        'Build the job "' || v_job_name || '" — ' || v_set_count ||
        ' set(s) from the delivery "' ||
        coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery') ||
        '" are waiting to be filed under it.',
        auth.uid()
      )
      returning id into v_issue;

      for v_set in select * from jsonb_array_elements(v_entry->'sets') loop
        insert into pending_delivery_sets
          (delivery_id, job_name, mark_code, kind, package_count,
           crate_name, crate_pieces, crate_part_type, issue_id, created_by)
        values
          (v_delivery, v_job_name,
           upper(regexp_replace(trim(coalesce(v_set->>'mark', '')), '^#', '')),
           coalesce(v_set->>'kind', 'window'),
           (v_set->>'package_count')::int,
           v_set#>>'{crate,name}',
           (v_set#>>'{crate,pieces}')::int,
           v_set#>>'{crate,part_type}',
           v_issue, auth.uid());
        v_pending := v_pending + 1;
      end loop;
    end if;
  end loop;

  return jsonb_build_object(
    'delivery_id', v_delivery,
    'created', v_created,
    'pending', v_pending
  );
end;
$$;

grant execute on function create_manual_delivery(text, jsonb) to authenticated;

-- ------------------------------------------- 4c. materialize a pending set

create or replace function materialize_pending_set(
  p_set uuid,
  p_project uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set pending_delivery_sets;
  v_created int;
  v_left int;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can file pending sets onto a job.'
      using errcode = '42501';
  end if;
  select * into v_set from pending_delivery_sets where id = p_set;
  if not found then
    raise exception 'That pending set is gone.';
  end if;
  if v_set.materialized_at is not null then
    return jsonb_build_object('created', 0, 'note', 'already filed');
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  v_created := public.create_delivery_set(
    v_set.delivery_id, p_project, v_set.mark_code, v_set.kind,
    v_set.package_count, v_set.crate_name, v_set.crate_pieces,
    v_set.crate_part_type
  );

  update pending_delivery_sets
     set materialized_at = now(), materialized_project = p_project
   where id = p_set;

  -- The issue resolves itself when the last of its sets is filed.
  if v_set.issue_id is not null then
    select count(*) into v_left from pending_delivery_sets
    where issue_id = v_set.issue_id and materialized_at is null;
    if v_left = 0 then
      update issues
         set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
       where id = v_set.issue_id and status = 'open';
    end if;
  end if;

  return jsonb_build_object('created', v_created);
end;
$$;

grant execute on function materialize_pending_set(uuid, uuid) to authenticated;

-- ---------------------------------------------- 5. re-label a bound package

-- bind_package writes part fields exactly once, on a blank sticker. Hand
-- logging created the packages BEFORE anyone read the boxes, and physical
-- labels decide the order ("frame might be 1/3 or 2/3") — so the crew must
-- be able to fix part number and label afterwards. Any signed-in crew: the
-- person holding the box knows best, and every change is visible on the
-- package. Duplicate part numbers are allowed (the UI warns); a wrong block
-- here would strand real boxes.
create or replace function set_package_part(
  p_package uuid,
  p_part_index int,
  p_part_total int,
  p_part_type text
)
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
  if (p_part_index is null) <> (p_part_total is null) then
    raise exception 'a part number needs both halves — "2 of 3", not just one';
  end if;
  if p_part_index is not null and p_part_index > p_part_total then
    raise exception 'part % of % — the first number can''t be bigger than the second', p_part_index, p_part_total;
  end if;
  if p_part_type is not null and length(trim(p_part_type)) not between 1 and 40 then
    raise exception 'A part label is 1 to 40 characters.';
  end if;

  update packages
  set part_index = p_part_index,
      part_total = p_part_total,
      part_type = lower(nullif(trim(coalesce(p_part_type, '')), ''))
  where id = p_package and status <> 'blank'
  returning * into v_row;
  if not found then
    raise exception 'That package is a blank sticker — tag it first.';
  end if;
  return v_row;
end;
$$;

grant execute on function set_package_part(uuid, int, int, text) to authenticated;
