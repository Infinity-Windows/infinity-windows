-- Log-a-delivery becomes what the owner meant it to be (his words,
-- 2026-08-25: "a preliminary stage for preparing to receive material and
-- check it against the list"):
--
--   1. The wizard now creates EXPECTED packages — status 'minted', the same
--      standby state pre-printed labels already use — not received ones.
--      The truck is then checked AGAINST the list: an arrived tap flips
--      minted -> received (receive_minted_packages, unchanged), and what
--      never flips is the missing report.
--   2. A job that isn't built yet stops parking material in a side table:
--      its packages are REAL from the start, with no job attached (the
--      Boneyard already proved project-less packages are a supported
--      state). They carry the typed job name + the mark on the package
--      itself, are receivable and storable into any conex or the building,
--      and file_pending_packages moves them onto the job once it exists —
--      resolving the missing_job issue when the last one files.
--   3. pending_delivery_sets and materialize_pending_set retire (lean
--      machine): the owner's one real logged delivery converts to expected
--      packages right here, then the table drops.

-- ------------------------------------------------- 1. columns on packages

alter table packages
  add column if not exists pending_job_name text
  check (pending_job_name is null or length(trim(pending_job_name)) between 1 and 80);

alter table packages
  add column if not exists pending_issue_id uuid references issues(id) on delete set null;

comment on column packages.pending_job_name is
  'The job name typed at the truck when the job is not built in the app yet. Cleared by file_pending_packages when the real job takes the material.';

-- ------------------------------------- 2. create_delivery_set, generation 3

drop function if exists public.create_delivery_set(uuid, uuid, text, text, int, text, int, text, int);

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
  v_crate uuid;
  v_crate_label text;
  v_prefix text;
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

  if p_project is not null then
    -- The mark registry: a hand-logged delivery may land before extraction
    -- has put the mark on the schedule. Logging must not block on that.
    insert into project_marks (project_id, mark_code)
    values (p_project, v_mark_code)
    on conflict (project_id, mark_code) do nothing;
    select id into v_mark from project_marks
    where project_id = p_project and mark_code = v_mark_code;
  end if;

  if p_crate_name is not null and trim(p_crate_name) <> '' then
    if p_crate_pieces is null or p_crate_pieces < 1 or p_crate_pieces > 99 then
      raise exception 'Say how many pieces of #% are in the crate (1-99).', v_mark_code;
    end if;
    if p_project is not null then
      select job_code into v_prefix from projects where id = p_project;
    end if;
    v_crate_label := coalesce(v_prefix, trim(p_job_name), 'JOB') || ' · ' || trim(p_crate_name);
    select id into v_crate from storage_containers
    where kind = 'crate' and name = v_crate_label
    limit 1;
    if v_crate is null then
      insert into storage_containers (name, kind)
      values (v_crate_label, 'crate')
      returning id into v_crate;
    end if;
  end if;

  for u in 1..v_qty loop
    for i in 1..p_package_count loop
      -- EXPECTED, not received: the truck gets checked against this list.
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

    if v_crate is not null then
      -- Crate pieces are expected too; receiving them stores them into
      -- their crate in the same tap (the client passes the crate on).
      insert into packages
        (status, project_id, category, part_type, piece_count, mfr_mark,
         pending_job_name, pending_issue_id,
         container_id, delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', p_project, v_category,
         lower(trim(coalesce(nullif(p_crate_part_type, ''), 'glass'))), p_crate_pieces, v_mark_code,
         case when p_project is null then trim(p_job_name) end,
         case when p_project is null then p_issue end,
         v_crate, p_delivery, issue_package_short_code(), now(), auth.uid()::text)
      returning * into v_row;
      if v_mark is not null then
        insert into package_marks (package_id, mark_id)
        values (v_row.id, v_mark) on conflict do nothing;
      end if;
      insert into movements (package_id, event, project_id, actor, to_container_id, reason)
      values (v_row.id, 'preissued', p_project, auth.uid()::text, v_crate,
              'expected off the truck — ' || p_crate_pieces || ' piece(s) riding in ' || v_crate_label
              || case when v_qty > 1 then ' (unit ' || u || ' of ' || v_qty || ' identical)' else '' end);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- Still not granted to clients: reached only through create_manual_delivery.

-- ------------------------------------- 3. create_manual_delivery, gen 3

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
      -- Tell a supervisor, never block the unload (owner rule). The
      -- material itself is real from this moment — see file below.
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

-- --------------------------- 4. file no-job material onto its built job

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
      continue; -- already filed, or never pending
    end if;

    v_issue := v_row.pending_issue_id;

    update packages
    set project_id = p_project,
        pending_job_name = null,
        pending_issue_id = null
    where id = v_id;

    if v_row.mfr_mark is not null then
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

    -- The issue resolves itself when its last package files.
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

-- ------------- 5. convert the one real logged delivery, retire the table

do $$
declare
  v_set pending_delivery_sets%rowtype;
  v_mark_code text;
  v_crate uuid;
  v_crate_label text;
  i int;
  u int;
begin
  for v_set in
    select * from pending_delivery_sets where materialized_at is null
  loop
    v_mark_code := upper(regexp_replace(trim(v_set.mark_code), '^#', ''));
    v_crate := null;

    if v_set.crate_name is not null and trim(v_set.crate_name) <> '' then
      v_crate_label := trim(v_set.job_name) || ' · ' || trim(v_set.crate_name);
      select id into v_crate from storage_containers
      where kind = 'crate' and name = v_crate_label limit 1;
      if v_crate is null then
        insert into storage_containers (name, kind)
        values (v_crate_label, 'crate')
        returning id into v_crate;
      end if;
    end if;

    for u in 1..greatest(v_set.quantity, 1) loop
      for i in 1..v_set.package_count loop
        insert into packages
          (status, project_id, category, part_index, part_total, mfr_mark,
           pending_job_name, pending_issue_id, delivery_id, short_code,
           bound_at, bound_by)
        values
          ('minted', null,
           case when v_set.kind = 'door' then 'doors' else 'windows' end,
           i, v_set.package_count, v_mark_code,
           trim(v_set.job_name), v_set.issue_id, v_set.delivery_id,
           issue_package_short_code(), v_set.created_at, 'migration-20260926');
      end loop;

      if v_crate is not null and v_set.crate_pieces is not null then
        insert into packages
          (status, project_id, category, part_type, piece_count, mfr_mark,
           pending_job_name, pending_issue_id, container_id, delivery_id,
           short_code, bound_at, bound_by)
        values
          ('minted', null,
           case when v_set.kind = 'door' then 'doors' else 'windows' end,
           lower(trim(coalesce(nullif(v_set.crate_part_type, ''), 'glass'))),
           v_set.crate_pieces, v_mark_code,
           trim(v_set.job_name), v_set.issue_id, v_crate, v_set.delivery_id,
           issue_package_short_code(), v_set.created_at, 'migration-20260926');
      end if;
    end loop;
  end loop;
end;
$$;

drop function if exists materialize_pending_set(uuid, uuid);
drop table if exists pending_delivery_sets;
