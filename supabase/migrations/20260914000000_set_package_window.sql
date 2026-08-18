-- The fix-up (owner ask, 2026-08-18): put an already-tagged package on its
-- window. Two real cases from the first day of tagging — packages tagged
-- before the worksheet existed carry no window at all, and a mis-typed
-- window needs moving without burning a live sticker.
--
-- REPLACES the package's window link rather than adding one: the fix-up
-- exists to make the record match the paper, and paper carries one window.
-- Foreman+, same line every schedule-changing action draws. The part fields
-- are untouched — "1/4 · Frame" was true all along; only the window was
-- missing or wrong.
create or replace function set_package_window(p_package uuid, p_mark text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_code text;
  v_old text;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can set a package''s window';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is null then
    raise exception 'Boneyard stock has no window — assign it to a job first';
  end if;

  v_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = v_row.project_id and mark_code = v_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_code;
  end if;

  select string_agg(pm2.mark_code, ', ') into v_old
  from package_marks pm
  join project_marks pm2 on pm2.id = pm.mark_id
  where pm.package_id = p_package;

  delete from package_marks where package_id = p_package;
  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', v_row.project_id, auth.uid()::text,
    case
      when v_old is null then 'window set to ' || v_code || ' — tagged without one'
      else 'window changed: ' || v_old || ' → ' || v_code
    end
  );

  return v_row;
end;
$$;
