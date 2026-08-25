-- Clone sets (owner ask, 2026-08-21 night, right behind the wizard): six
-- 5050s identical in every way arrive as ONE mark with a quantity. The
-- wizard's set gains a clone toggle + "how many identical" — the packages
-- stamp out N units' worth under the one mark (six 1-of-3 boxes, six
-- 2-of-3s...), which is the truth of identical units: the boxes are
-- interchangeable, any 1+2+3 makes a window. Crate pieces stamp per unit.
--
-- "Whatever I assign one window or door, the rest get as well": labeling
-- one box's part spreads to its identical siblings on request —
-- set_package_part gains p_apply_to_siblings, which paints the SAME part
-- label onto every box of that mark sharing the same slot (index of
-- total). Only the label spreads — never the number: each unit still
-- needs one box in each slot.
--
-- Both changed functions are rebuilt from their CURRENT definitions
-- (20260924000000); the old signatures are dropped in this same migration
-- (the overload lesson).

drop function if exists public.create_delivery_set(uuid, uuid, text, text, int, text, int, text);

create or replace function public.create_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text,
  p_crate_pieces int,
  p_crate_part_type text,
  p_quantity int default 1
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

  -- The mark registry: a hand-logged delivery may land before extraction has
  -- put the mark on the schedule. Logging the truck must not block on that.
  insert into project_marks (project_id, mark_code)
  values (p_project, v_mark_code)
  on conflict (project_id, mark_code) do nothing;
  select id into v_mark from project_marks
  where project_id = p_project and mark_code = v_mark_code;

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
  end if;

  for u in 1..v_qty loop
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
              'logged by hand at the truck — part ' || i || ' of ' || p_package_count
              || case when v_qty > 1 then ' (unit ' || u || ' of ' || v_qty || ' identical)' else '' end);
      v_created := v_created + 1;
    end loop;

    if v_crate is not null then
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
              'logged by hand at the truck — ' || p_crate_pieces || ' piece(s) in ' || v_crate_label
              || case when v_qty > 1 then ' (unit ' || u || ' of ' || v_qty || ' identical)' else '' end);
      insert into movements (package_id, event, project_id, actor, to_container_id, reason)
      values (v_row.id, 'stored', p_project, auth.uid()::text, v_crate,
              'riding in ' || v_crate_label);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- Not granted to clients: reached only through create_manual_delivery and
-- materialize_pending_set, unchanged in signature — rebuilt for the new arg.

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
          v_set#>>'{crate,part_type}',
          coalesce((v_set->>'quantity')::int, 1)
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
           crate_name, crate_pieces, crate_part_type, quantity, issue_id, created_by)
        values
          (v_delivery, v_job_name,
           upper(regexp_replace(trim(coalesce(v_set->>'mark', '')), '^#', '')),
           coalesce(v_set->>'kind', 'window'),
           (v_set->>'package_count')::int,
           v_set#>>'{crate,name}',
           (v_set#>>'{crate,pieces}')::int,
           v_set#>>'{crate,part_type}',
           coalesce((v_set->>'quantity')::int, 1),
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

-- Pending sets remember their quantity too.
alter table pending_delivery_sets
  add column if not exists quantity int not null default 1
  check (quantity between 1 and 20);

-- materialize_pending_set: same signature, rebuilt to pass the quantity.
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
    v_set.crate_part_type, v_set.quantity
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

-- ------------------------- label one box, label its identical siblings too

drop function if exists set_package_part(uuid, int, int, text);

create or replace function set_package_part(
  p_package uuid,
  p_part_index int,
  p_part_total int,
  p_part_type text,
  -- Paint the same part LABEL onto every box of this mark that sits in the
  -- same slot (same index of same total) — the clone case: six identical
  -- 5050s, label one 1-of-3 "frame" and all six 1-of-3s are frames. Only
  -- the label spreads, never the number.
  p_apply_to_siblings boolean default false
)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_type text := lower(nullif(trim(coalesce(p_part_type, '')), ''));
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
      part_type = v_type
  where id = p_package and status <> 'blank'
  returning * into v_row;
  if not found then
    raise exception 'That package is a blank sticker — tag it first.';
  end if;

  if p_apply_to_siblings and v_type is not null
     and v_row.part_index is not null and v_row.project_id is not null then
    update packages p
    set part_type = v_type
    where p.id <> v_row.id
      and p.status <> 'blank'
      and p.project_id = v_row.project_id
      and p.part_index = v_row.part_index
      and p.part_total = v_row.part_total
      and exists (
        select 1
        from package_marks pm
        join package_marks pm2 on pm2.mark_id = pm.mark_id
        where pm.package_id = p.id and pm2.package_id = v_row.id
      );
  end if;

  return v_row;
end;
$$;

grant execute on function set_package_part(uuid, int, int, text, boolean) to authenticated;
