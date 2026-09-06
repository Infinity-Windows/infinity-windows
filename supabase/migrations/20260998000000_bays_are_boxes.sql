-- One location model, one "what is it", and a truck for a job that isn't
-- built yet makes a real job (warehouse redesign wave 5, owner go-ahead
-- 2026-09-06 after four read-only probes of production).
--
-- What the probes said, and why this migration is small:
--   * 0 packages sit on a rack slot or staging bay, 0 supplies have a slot
--     for a home spot — the slot model holds nothing, so retiring it moves
--     no data;
--   * 14 packages carry a category (8 windows, 6 doors) and no part label —
--     the window-or-door fact has to survive somewhere, and it belongs on
--     the UNIT (a whole opening is a window or a door), not on each piece;
--   * package_events was already dropped in August;
--   * 0 packages are still waiting under a typed job name (218 were filed
--     onto their jobs by hand earlier today).
--
-- Three decisions the owner approved (research artifact, section 10):
--
--   1. A staging bay is a BOX (ADR-0004's "a shelf is not a container" is
--      retired). Every job gets a storage_containers row of kind 'bay',
--      made by the same trigger that used to make two slot rows; Set aside
--      stores into it like any other box. The J-zone slot rows go inactive;
--      the locations table stays for the racks (R/S/D), unreferenced by
--      packages, until a later pass drops it.
--   2. project_marks.kind — window or door — backfilled from the packages'
--      category, so category can stop being asked per piece.
--   3. create_placeholder_job: any crew member at a truck can make the job
--      row for a job the office has not built yet, instead of typing a name
--      that lives on the packages. The row is a real job with a NEW- code;
--      the office renames it. pending_job_name stays for the deploy window
--      and drops in a later pass.

-- ---------------------------------------------------------------------------
-- 1. A unit is a window or a door
-- ---------------------------------------------------------------------------
alter table project_marks
  add column if not exists kind text not null default 'window';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_marks_kind_ck') then
    alter table project_marks add constraint project_marks_kind_ck
      check (kind in ('window', 'door'));
  end if;
end;
$$;

update project_marks pm
set kind = 'door'
where pm.kind = 'window'
  and exists (
    select 1 from package_marks x
    join packages p on p.id = x.package_id
    where x.mark_id = pm.id and p.category = 'doors'
  );

create or replace function set_mark_kind(p_project uuid, p_mark text, p_kind text)
returns project_marks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(trim(coalesce(p_mark, '')));
  v_row project_marks;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('window', 'door') then
    raise exception 'a unit is a window or a door';
  end if;
  update project_marks
  set kind = p_kind
  where project_id = p_project and mark_code = v_code
  returning * into v_row;
  if not found then
    raise exception 'window % is not on this job''s schedule', v_code;
  end if;
  return v_row;
end;
$$;

revoke execute on function set_mark_kind(uuid, text, text) from public, anon;
grant execute on function set_mark_kind(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A job's bay is a box
-- ---------------------------------------------------------------------------
alter table storage_containers
  add column if not exists project_id uuid references projects (id) on delete set null;

create unique index if not exists storage_containers_one_bay_per_job
  on storage_containers (project_id)
  where project_id is not null and kind = 'bay' and active;

-- The job's bay box, made on first ask. Internal: called by the projects
-- trigger and by stage_packages, both of which already run as the owner.
create or replace function public.job_bay_box(p_project uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_code text;
begin
  select id into v_id from storage_containers
  where project_id = p_project and kind = 'bay' and active
  limit 1;
  if v_id is not null then
    return v_id;
  end if;
  select job_code into v_code from projects where id = p_project;
  if v_code is null then
    raise exception 'that job does not exist';
  end if;
  insert into storage_containers (name, kind, project_id, notes)
  values (v_code || ' bay', 'bay', p_project, 'This job''s own bay: what is set aside for it waits here.')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.job_bay_box(uuid) from public, anon, authenticated;

-- Every live job gets its bay box now; new jobs get one from the trigger.
insert into storage_containers (name, kind, project_id, notes)
select p.job_code || ' bay', 'bay', p.id, 'This job''s own bay: what is set aside for it waits here.'
from projects p
where p.deleted_at is null
  and not exists (
    select 1 from storage_containers c
    where c.project_id = p.id and c.kind = 'bay' and c.active
  );

-- The trigger keeps its name so nothing else has to learn a new one; what it
-- makes is a bay box, not two slot rows.
create or replace function public.projects_create_staging_bays()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.job_bay_box(new.id);
  return null;
end;
$$;

-- The old J-zone slot rows held nothing (probe 2026-09-06). They stop being
-- listed; the rows stay until the locations table is dropped as a whole.
update locations set active = false where zone = 'J' and active;

-- Set aside = store into the job's bay box. Same signature, same answer
-- shape, so the phones already in the field keep working; the one refusal
-- that disappears is "this job has no staging bay yet", because the box is
-- made on first ask.
create or replace function stage_packages(
  p_packages uuid[],
  p_project uuid,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bay uuid;
  v_id uuid;
  v_status text;
  v_container uuid;
  v_location uuid;
  v_serial text;
  v_note jsonb;
  v_exp_status text;
  v_exp_container uuid;
  v_exp_location uuid;
  v_hit int;
  v_staged int := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is staged for';
  end if;

  v_bay := public.job_bay_box(p_project);

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select p.status, p.container_id, p.location_id, p.serial
      into v_status, v_container, v_location, v_serial
    from packages p
    where p.id = v_id;

    -- Already in the bay: the same write arriving twice. Done, no new line.
    if v_status = 'stored' and v_container is not distinct from v_bay then
      v_staged := v_staged + 1;
      continue;
    end if;

    v_note := coalesce(p_expected, '{}'::jsonb) -> v_id::text;
    v_exp_status := v_note ->> 'status';
    v_exp_container := nullif(v_note ->> 'container', '')::uuid;
    v_exp_location := nullif(v_note ->> 'location', '')::uuid;

    if v_status is not null
       and v_exp_status is not null
       and v_exp_status in ('received', 'stored')
    then
      update packages
      set status = 'stored',
          container_id = v_bay,
          location_id = null
      where id = v_id
        and status = v_exp_status
        and container_id is not distinct from v_exp_container
        and location_id is not distinct from v_exp_location;
      get diagnostics v_hit = row_count;

      if v_hit = 1 then
        insert into movements
          (package_id, event, from_container_id, from_location_id,
           to_container_id, project_id, actor, reason)
        values (v_id, 'staged', v_exp_container, v_exp_location,
                v_bay, p_project, auth.uid()::text, 'set aside in the job''s bay');
        v_staged := v_staged + 1;
        continue;
      end if;

      select p.status, p.container_id, p.location_id, p.serial
        into v_status, v_container, v_location, v_serial
      from packages p
      where p.id = v_id;
    end if;

    v_refused := v_refused || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'serial', v_serial,
      'status', v_status,
      'container', (
        select c.name from storage_containers c where c.id = v_container
      ),
      'location', (
        select l.address from locations l where l.id = v_location
      ),
      'job', case when v_status = 'checked_out' then (
        select pr.job_code
        from movements m
        join projects pr on pr.id = m.project_id
        where m.package_id = v_id and m.event = 'checked_out'
        order by m.created_at desc
        limit 1
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'staged', v_staged,
    'job', (select pr.job_code from projects pr where pr.id = p_project),
    -- Was the slot's address; the bay is a box now, so its name.
    'bay', (select c.name from storage_containers c where c.id = v_bay),
    'refused', v_refused
  );
end;
$$;

-- Redefined above: say its grants again so the file is the whole truth about
-- who may call it (signed-in crew, never anonymous) — CREATE OR REPLACE keeps
-- the old ACL, but a reader of this file should not have to know that.
revoke execute on function stage_packages(uuid[], uuid, jsonb) from public, anon;
grant execute on function stage_packages(uuid[], uuid, jsonb) to authenticated;
revoke all on function public.projects_create_staging_bays() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A truck for a job that isn't built yet makes a real job
-- ---------------------------------------------------------------------------
-- Who may call it: any signed-in crew member who is not a builder login.
-- Why that open: the person at the tailgate at 6am is an installer, and the
-- truck does not wait for the office. A job the office has not built yet
-- used to leave its packages under a typed name with no job row (audit
-- 2026-09-06: 218 such packages under seven names). This makes the row —
-- a real job with a NEW- code — so filing, finding and the unit card all
-- work from the first scan; the office renames it. Same door as the other
-- eighteen everyday warehouse functions (ADR-0007), same partner-wall
-- refusal. It cannot delete or rename anything, and a duplicate name hands
-- back the existing job rather than making a twin.
create or replace function create_placeholder_job(p_name text)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_base text;
  v_code text;
  v_n int := 1;
  v_row projects;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception 'a job name is 1 to 80 characters';
  end if;

  -- A job by this name already exists (typed the same way twice at two
  -- trucks): hand that one back rather than make a twin.
  select * into v_row from projects
  where deleted_at is null and lower(name) = lower(v_name)
  order by created_at limit 1;
  if found then
    return v_row;
  end if;

  -- NEW-<first letters of the name>, numbered when that is taken. The
  -- office renames it from the job page; the code is a handle, not a name.
  v_base := 'NEW-' || left(upper(regexp_replace(v_name, '[^A-Za-z0-9]+', '', 'g')), 8);
  if v_base = 'NEW-' then
    v_base := 'NEW-JOB';
  end if;
  v_code := v_base;
  while exists (select 1 from projects where job_code = v_code) loop
    v_n := v_n + 1;
    v_code := v_base || '-' || v_n;
  end loop;

  insert into projects (job_code, name, notes)
  values (v_code, v_name, 'Made at the truck on ' || to_char(now(), 'YYYY-MM-DD') || ' for material that arrived before the office built the job. Rename the code and fill in the details.')
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function create_placeholder_job(text) from public, anon;
grant execute on function create_placeholder_job(text) to authenticated;
