-- The unit card's two doors (warehouse redesign wave 1, owner call 2026-09-06).
--
-- The audit that preceded this (.scratch/warehouse-reimagined/01-code-audit.md,
-- section D7) found the one edit a foreman most wants is the one the server
-- refuses: "this box is tagged to the wrong job". assign_package_to_job only
-- takes Boneyard stock, set_package_window only takes marks on the package's
-- own job, and the escape hatch was foreman+ delete and re-tag — which throws
-- away the history the whole ledger exists to keep. It also found two undo
-- RPCs (unreceive, unstore) and none for checkout, move, relabel or reassign.
--
-- Two functions fix both, and neither changes a line of the ones that exist:
--
--   reassign_package  — any job (or the Boneyard), any window, adding the
--                       window to the schedule when it is new. Warn, never
--                       block (the standing warehouse rule): the refusals move
--                       to the client as warnings, the server writes ONE
--                       'assigned' movement line that carries where the
--                       package came FROM in a `before` snapshot.
--   undo_movement     — writes the opposite of a movement line and links the
--                       two. Nothing is edited or deleted: "moved here, then
--                       undone, by so-and-so" stays readable forever. The
--                       person who did it may undo it the same day; a foreman
--                       may undo any line at any time.
--
-- `movements.before` is the snapshot the undo restores from; `movements.undoes`
-- is the link. Lines written before this migration have no snapshot, so undo
-- derives the previous state from from_/to_ columns where it can (stored,
-- checked_out) and refuses by name where it cannot.

alter table movements
  add column if not exists before jsonb,
  add column if not exists undoes uuid references movements (id) on delete set null;

create index if not exists movements_undoes_idx on movements (undoes) where undoes is not null;

-- ---------------------------------------------------------------------------
-- reassign_package
-- ---------------------------------------------------------------------------
create or replace function reassign_package(
  p_package uuid,
  p_project uuid,
  p_mark text,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_code text;
  v_mark uuid;
  v_old_marks text;
  v_old_job text;
  v_new_job text;
  v_issue uuid;
  v_before jsonb;
  v_movement uuid;
begin
  -- Warehouse work is crew work (ADR-0007): signed in, and not a builder
  -- login, is the whole door.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;

  v_code := upper(trim(coalesce(p_mark, '')));
  if p_project is null then
    -- Back to the Boneyard: company stock no job owns has no window number,
    -- because a window number is a position on one job's plans.
    v_code := '';
  else
    if not exists (select 1 from projects where id = p_project and deleted_at is null) then
      raise exception 'job not found';
    end if;
    if v_code = '' then
      raise exception 'pick the window this package becomes part of';
    end if;
    if length(v_code) > 12 then
      raise exception 'a window number is 1 to 12 characters';
    end if;
  end if;

  select string_agg(pm2.mark_code, ', ' order by pm2.mark_code) into v_old_marks
  from package_marks pm
  join project_marks pm2 on pm2.id = pm.mark_id
  where pm.package_id = p_package;

  -- Nothing to do: same job, same single window. No movement line for a
  -- non-event — the history stays a history of things that happened.
  if v_row.project_id is not distinct from p_project
     and coalesce(v_old_marks, '') = v_code then
    return null;
  end if;

  v_before := jsonb_build_object(
    'project_id', v_row.project_id,
    'pending_job_name', v_row.pending_job_name,
    'pending_issue_id', v_row.pending_issue_id,
    'marks', coalesce((
      select jsonb_agg(pm2.mark_code order by pm2.mark_code)
      from package_marks pm
      join project_marks pm2 on pm2.id = pm.mark_id
      where pm.package_id = p_package
    ), '[]'::jsonb)
  );
  v_issue := v_row.pending_issue_id;

  if p_project is not null then
    -- A window not on the schedule yet is added in the same step (the tag
    -- screen's "Add window N" button, folded in — a door that sends you to
    -- another screen to add the window first is the friction this removes).
    insert into project_marks (project_id, mark_code)
    values (p_project, v_code)
    on conflict (project_id, mark_code) do nothing;
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = v_code;
  end if;

  update packages
  set project_id = p_project,
      pending_job_name = null,
      pending_issue_id = null
  where id = p_package;

  delete from package_marks where package_id = p_package;
  if v_mark is not null then
    insert into package_marks (package_id, mark_id)
    values (p_package, v_mark)
    on conflict do nothing;
  end if;

  select job_code into v_old_job from projects where id = v_row.project_id;
  select job_code into v_new_job from projects where id = p_project;

  insert into movements (package_id, event, project_id, actor, reason, before)
  values (
    p_package, 'assigned', p_project, auth.uid()::text,
    'moved from '
      || coalesce(v_old_job, nullif(v_row.pending_job_name, ''), 'the Boneyard')
      || case when v_old_marks is null then '' else ' window ' || v_old_marks end
      || ' to '
      || coalesce(v_new_job, 'the Boneyard')
      || case when v_code = '' then '' else ' window ' || v_code end
      || case when nullif(trim(coalesce(p_reason, '')), '') is null then ''
              else ' — ' || trim(p_reason) end,
    v_before
  )
  returning id into v_movement;

  -- A missing_job issue resolves when its last waiting package files —
  -- byte-for-byte the rule assign_package_to_job and file_pending_packages
  -- follow.
  if v_issue is not null and not exists (
    select 1 from packages
    where pending_issue_id = v_issue and project_id is null
  ) then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where id = v_issue and status = 'open';
  end if;

  return v_movement;
end;
$$;

revoke execute on function reassign_package(uuid, uuid, text, text) from public, anon;
grant execute on function reassign_package(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- undo_movement
-- ---------------------------------------------------------------------------
create or replace function undo_movement(p_movement uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m movements;
  v_p packages;
  v_mine boolean;
  v_before jsonb;
  v_mark_code text;
  v_mark uuid;
  v_new uuid;
  v_status text;
  v_container uuid;
  v_location uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  select m.* into v_m from movements m where m.id = p_movement;
  if not found then
    raise exception 'that history line no longer exists';
  end if;
  if v_m.undoes is not null then
    raise exception 'that line is itself an undo — nothing to undo';
  end if;
  if exists (select 1 from movements where undoes = p_movement) then
    raise exception 'that was already undone';
  end if;
  if v_m.package_id is null then
    raise exception 'only a package''s own history can be undone here';
  end if;

  -- The person who did it may undo it the same day. A foreman may undo any
  -- line at any time. Client mirror: lib/warehouse/undo.ts (keep in step).
  v_mine := v_m.actor = auth.uid()::text
            and v_m.created_at > now() - interval '24 hours';
  if not v_mine and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only the person who did this can undo it today. A foreman can undo it any time.'
      using errcode = '42501';
  end if;

  select p.* into v_p from packages p where p.id = v_m.package_id;
  if not found then
    raise exception 'that package is gone';
  end if;

  v_before := v_m.before;

  if v_m.event = 'assigned' then
    if v_before is null then
      raise exception 'this job change was recorded before undo existed — move it back by hand';
    end if;
    update packages
    set project_id = nullif(v_before->>'project_id', '')::uuid,
        pending_job_name = v_before->>'pending_job_name',
        pending_issue_id = nullif(v_before->>'pending_issue_id', '')::uuid
    where id = v_p.id;
    delete from package_marks where package_id = v_p.id;
    if nullif(v_before->>'project_id', '') is not null then
      for v_mark_code in select jsonb_array_elements_text(coalesce(v_before->'marks', '[]'::jsonb))
      loop
        insert into project_marks (project_id, mark_code)
        values ((v_before->>'project_id')::uuid, v_mark_code)
        on conflict (project_id, mark_code) do nothing;
        select id into v_mark from project_marks
        where project_id = (v_before->>'project_id')::uuid and mark_code = v_mark_code;
        insert into package_marks (package_id, mark_id)
        values (v_p.id, v_mark)
        on conflict do nothing;
      end loop;
    end if;

  elsif v_m.event = 'stored' then
    -- Only the most recent placement can be walked back: if the package has
    -- moved again since, this line is not what put it where it is.
    if v_p.status <> 'stored' or v_p.container_id is distinct from v_m.to_container_id then
      raise exception 'this package has moved since — undo the newer line first';
    end if;
    if v_before is not null then
      v_status := coalesce(v_before->>'status', 'received');
      v_container := nullif(v_before->>'container_id', '')::uuid;
      v_location := nullif(v_before->>'location_id', '')::uuid;
    elsif v_m.from_container_id is not null then
      v_status := 'stored'; v_container := v_m.from_container_id; v_location := null;
    elsif v_m.from_location_id is not null then
      v_status := 'stored'; v_container := null; v_location := v_m.from_location_id;
    else
      v_status := 'received'; v_container := null; v_location := null;
    end if;
    update packages
    set status = v_status, container_id = v_container, location_id = v_location, area = null
    where id = v_p.id;

  elsif v_m.event = 'checked_out' then
    if v_p.status <> 'checked_out' then
      raise exception 'this package is not checked out any more — nothing to undo';
    end if;
    if v_m.from_container_id is not null then
      v_status := 'stored'; v_container := v_m.from_container_id; v_location := null;
    elsif v_m.from_location_id is not null then
      v_status := 'stored'; v_container := null; v_location := v_m.from_location_id;
    else
      v_status := 'received'; v_container := null; v_location := null;
    end if;
    update packages
    set status = v_status, container_id = v_container, location_id = v_location, area = null
    where id = v_p.id;

  else
    raise exception 'a "%" line can''t be undone yet — fix it by hand', v_m.event;
  end if;

  select p.* into v_p from packages p where p.id = v_p.id;

  insert into movements (
    package_id, event, project_id, actor, reason, undoes,
    from_container_id, to_container_id, from_location_id, to_location_id
  )
  values (
    v_p.id, 'override', v_p.project_id, auth.uid()::text,
    'undone: ' || coalesce(v_m.reason, v_m.event),
    p_movement,
    v_m.to_container_id, v_m.from_container_id,
    v_m.to_location_id, v_m.from_location_id
  )
  returning id into v_new;

  return v_new;
end;
$$;

revoke execute on function undo_movement(uuid) from public, anon;
grant execute on function undo_movement(uuid) to authenticated;
