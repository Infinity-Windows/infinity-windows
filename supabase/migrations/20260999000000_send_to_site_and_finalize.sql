-- A whole job goes to the job site, and a job's material story gets a last
-- page (owner ask 2026-09-06, four decisions confirmed the same day):
--
--   1. "On job site" IS the checked-out state. Checking a package out
--      already clears its box and records the destination job and who did
--      it, so sending a whole job to site is checkout_packages over every
--      piece the person chose to send — no second state, no second ledger.
--      Nothing here touches that function.
--   2. "Unit Movement Finalized" REFUSES while any of the job's pieces still
--      sit in a conex, truck or bay, and says which box holds what. Hiding a
--      job while glass sits in Conex 4 would make that glass invisible to
--      everyone. The way past the refusal is boneyard_job_leftovers: the
--      pieces become company stock and stay visible on the yard.
--   3. Foreman and up finalize and reopen. Sending to site is everyday crew
--      work (ADR-0007); hiding a whole job from the warehouse is a lead's tap.
--   4. Warehouse-only. The job's own status is the office's; this stamps a
--      date on the job and nothing else about it changes.
--
-- The stamp is what the warehouse page reads to hide the job (client
-- partition, lib/warehouse/sendToSite.ts, beside the testing partition) and
-- what the history page reads to list it. Packages are not touched: their
-- rows, marks and ledger lines stay exactly as they were, so the story can
-- be read again later and reopened if something comes back.

alter table projects
  add column if not exists materials_finalized_at timestamptz,
  add column if not exists materials_finalized_by uuid;

-- The whole event list, re-stated (the movements_event_ck lesson: a diff of
-- a check constraint is a check constraint with the diff's list). Two new
-- events, both job-level lines with no package: 'finalized' and 'reopened'.
alter table movements drop constraint if exists movements_event_ck;
alter table movements add constraint movements_event_ck check (event in (
  'received', 'putaway', 'moved', 'staged', 'loaded', 'installed', 'damaged',
  'count_verified', 'count_missing', 'override',
  'assigned', 'uninstalled', 'preissued', 'unloaded',
  'bound', 'stored', 'checked_out',
  'took',
  'finalized', 'reopened'
));

-- What of a job is still physically in the warehouse: received (arrived,
-- not put away yet) or stored (in a box). Minted pieces have not arrived
-- and checked-out pieces have left; neither is "in the warehouse".
create or replace function public.job_leftovers_line(p_project uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select string_agg(place || ' ×' || n, ', ' order by n desc, place)
  from (
    select coalesce(c.name, 'not in a box yet') as place, count(*) as n
    from packages p
    left join storage_containers c on c.id = p.container_id
    where p.project_id = p_project
      and p.status in ('received', 'stored')
    group by 1
  ) t;
$$;

revoke all on function public.job_leftovers_line(uuid) from public, anon, authenticated;

create or replace function finalize_job_materials(p_project uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
  v_left int;
  v_line text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can finalize a job''s material.'
      using errcode = '42501';
  end if;

  select * into v_row from projects where id = p_project and deleted_at is null;
  if not found then
    raise exception 'that job does not exist';
  end if;
  if v_row.materials_finalized_at is not null then
    return v_row;
  end if;

  select count(*) into v_left
  from packages
  where project_id = p_project and status in ('received', 'stored');
  if v_left > 0 then
    v_line := public.job_leftovers_line(p_project);
    raise exception '% package% still in the warehouse (%). Send them to the job site or move them to the Boneyard first.',
      v_left, case when v_left = 1 then ' is' else 's are' end, v_line;
  end if;

  update projects
  set materials_finalized_at = now(), materials_finalized_by = auth.uid()
  where id = p_project
  returning * into v_row;

  -- The job's bay has nothing in it (checked above); it goes quiet with the
  -- job. A fresh one is made if anything is ever set aside for it again.
  update storage_containers
  set active = false
  where project_id = p_project and kind = 'bay' and active;

  insert into movements (project_id, event, actor, reason)
  values (p_project, 'finalized', auth.uid()::text, 'unit movement finalized');

  return v_row;
end;
$$;

revoke execute on function finalize_job_materials(uuid) from public, anon;
grant execute on function finalize_job_materials(uuid) to authenticated;

create or replace function reopen_job_materials(p_project uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can reopen a job''s material.'
      using errcode = '42501';
  end if;

  update projects
  set materials_finalized_at = null, materials_finalized_by = null
  where id = p_project and deleted_at is null
  returning * into v_row;
  if not found then
    raise exception 'that job does not exist';
  end if;

  insert into movements (project_id, event, actor, reason)
  values (p_project, 'reopened', auth.uid()::text, 'material reopened in the warehouse');

  return v_row;
end;
$$;

revoke execute on function reopen_job_materials(uuid) from public, anon;
grant execute on function reopen_job_materials(uuid) to authenticated;

-- The way past the finalize refusal: every piece of the job still in the
-- warehouse becomes company stock, through the same reassign_package every
-- unit-card edit uses (ADR-0008), so each gets its own 'assigned' line with
-- a before-snapshot and can be undone one at a time. Crew work, like the
-- edit it repeats.
create or replace function boneyard_job_leftovers(p_project uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  for v_id in
    select id from packages
    where project_id = p_project and status in ('received', 'stored')
  loop
    perform public.reassign_package(v_id, null, null, 'left over when the job''s material was finalized');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function boneyard_job_leftovers(uuid) from public, anon;
grant execute on function boneyard_job_leftovers(uuid) to authenticated;
