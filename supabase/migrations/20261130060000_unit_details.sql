-- Per-opening field corrections. The opening UUID remains the identity used by
-- Plan, Workday, and the future import review.
alter table public.project_openings
  add column unit_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(unit_details) = 'object');

create table public.unit_detail_edit_history (
  edit_id uuid primary key,
  opening_id uuid not null references public.project_openings(id) on delete cascade,
  actor_id uuid not null,
  saved_at timestamptz not null default clock_timestamp(),
  reason text,
  before_values jsonb,
  after_values jsonb not null
);

create index unit_detail_edit_history_opening_time
  on public.unit_detail_edit_history (opening_id, saved_at);

alter table public.unit_detail_edit_history enable row level security;
revoke all on public.unit_detail_edit_history from public, anon, authenticated;
-- The save RPC can check its caller's operation receipt. History contents
-- remain internal and the app has no history reader.
grant select (edit_id, opening_id, actor_id) on public.unit_detail_edit_history to authenticated;
create policy unit_detail_edit_receipt on public.unit_detail_edit_history
  for select to authenticated using (actor_id = auth.uid());

create function public.record_unit_detail_edit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  edit_id uuid := nullif(current_setting('forge.unit_detail_edit_id', true), '')::uuid;
  old_values jsonb;
begin
  if edit_id is null then return new; end if;
  if tg_op = 'UPDATE' then
    if new.opening_code = old.opening_code and new.unit_details = old.unit_details then
      return new;
    end if;
    old_values := jsonb_build_object('opening_code', old.opening_code, 'unit_details', old.unit_details);
  end if;
  insert into public.unit_detail_edit_history (edit_id, opening_id, actor_id, reason, before_values, after_values)
  values (edit_id, new.id, auth.uid(), nullif(current_setting('forge.unit_detail_edit_reason', true), ''),
    old_values, jsonb_build_object('opening_code', new.opening_code, 'unit_details', new.unit_details));
  return new;
end;
$$;

revoke all on function public.record_unit_detail_edit() from public, anon, authenticated;
create trigger record_unit_detail_edit
  after insert or update of opening_code, unit_details on public.project_openings
  for each row execute function public.record_unit_detail_edit();

create function public.save_unit_details(
  p_project uuid, p_opening uuid, p_create boolean, p_code text,
  p_details jsonb, p_previous_code text, p_previous_details jsonb,
  p_edit_id uuid, p_reason text default null
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  current_unit public.project_openings%rowtype;
  created boolean := false;
  previous_field_add text := coalesce(current_setting('app.field_unit_add', true), '');
begin
  if not coalesce(public.custom_work_internal(), false)
     or not exists (select 1 from public.projects where id = p_project) then
    raise exception 'This job is unavailable.' using errcode = '42501';
  end if;

  if p_edit_id is null or length(btrim(p_reason)) > 500 then
    raise exception 'The edit reason must be 500 characters or fewer.' using errcode = '22023';
  end if;

  if p_create is null or nullif(btrim(p_code), '') is null
     or jsonb_typeof(p_details) is distinct from 'object'
     or (p_details->>'floor' is not null and p_details->>'floor' !~ '^-?[0-9]{1,3}$')
     or (p_details->>'kind' is not null and p_details->>'kind' not in ('window', 'door'))
     or (p_details->>'inset' is not null and p_details->>'inset' not in ('inset', 'outset', 'unknown'))
     or (p_details->>'basis' is not null and p_details->>'basis' not in ('unit', 'rough', 'drawing'))
     or (p_create and p_details->>'placeholder' is distinct from 'true')
     or (p_details->>'placeholder' = 'true'
       and (p_details->>'floor' is null or p_details->>'kind' is null)) then
    raise exception 'Enter a unit number, floor, and type.' using errcode = '22023';
  end if;

  perform set_config('forge.unit_detail_edit_id', p_edit_id::text, true);
  perform set_config('forge.unit_detail_edit_reason', coalesce(btrim(p_reason), ''), true);

  if p_create then
    -- Preserve field-created openings on re-extraction. A new placeholder
    -- carries no pin, planset, type catalog row, or manufactured dimensions.
    -- Use the existing one-opening guard escape hatch only after checking
    -- internal access, job visibility, and the placeholder's required fields.
    -- Restore it immediately so this RPC cannot authorize later inserts.
    perform set_config('app.field_unit_add', 'on', true);
    insert into public.project_openings (id, project_id, opening_code, unit_details, field_added)
    values (p_opening, p_project, btrim(p_code), p_details, true)
    on conflict (id) do nothing;
    created := found;
    perform set_config('app.field_unit_add', previous_field_add, true);
  end if;

  select * into current_unit from public.project_openings
  where id = p_opening and project_id = p_project and removed_at is null for update;
  if not found then
    raise exception 'This unit is unavailable.' using errcode = '42501';
  end if;
  -- Check receipts while holding the opening lock. A retry may arrive after
  -- somebody else has already edited the unit again.
  if created or exists (
    select 1 from public.unit_detail_edit_history
    where edit_id = p_edit_id and opening_id = p_opening and actor_id = auth.uid()
  ) or (current_unit.opening_code = btrim(p_code) and current_unit.unit_details = p_details) then
    perform set_config('forge.unit_detail_edit_id', '', true);
    return created;
  end if;
  if p_create or current_unit.opening_code is distinct from p_previous_code
      or current_unit.unit_details is distinct from p_previous_details then
    raise exception 'This unit changed elsewhere. Reload before editing again.' using errcode = '22023';
  end if;

  if current_unit.unit_details->'placeholder' is distinct from p_details->'placeholder' then
    raise exception 'This edit cannot change placeholder identity.' using errcode = '22023';
  end if;

  update public.project_openings
  set opening_code = btrim(p_code), unit_details = p_details
  where id = current_unit.id and project_id = p_project;
  perform set_config('forge.unit_detail_edit_id', '', true);
  return true;
end;
$$;

revoke all on function public.save_unit_details(uuid, uuid, boolean, text, jsonb, text, jsonb, uuid, text) from public, anon;
grant execute on function public.save_unit_details(uuid, uuid, boolean, text, jsonb, text, jsonb, uuid, text) to authenticated;

-- A QA test login may only write on a sandbox job; arm that fence for the
-- table this file adds (scripts/test_sandbox_guard.py requires it here, in the
-- declaring migration). Idempotent, so 20261130180000 can run it again for
-- databases that applied this file before the line was added.
select public.attach_sandbox_guards();
