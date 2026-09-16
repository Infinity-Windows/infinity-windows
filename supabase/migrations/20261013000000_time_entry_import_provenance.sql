-- Keep original imported time-entry evidence alongside editable Forge punches.
-- Importing is a controlled maintenance operation, never a client permission.
alter table public.time_shifts add column if not exists source_import_key text;
alter table public.time_shifts add column if not exists source_import jsonb;
create unique index if not exists time_shifts_source_import_key_idx
  on public.time_shifts(source_import_key) where source_import_key is not null;

create or replace function public.guard_time_entry_import_source()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.source_import_key is not distinct from old.source_import_key
    and new.source_import is not distinct from old.source_import then return new; end if;
  if tg_op='INSERT' and new.source_import_key is null and new.source_import is null then return new; end if;
  if auth.uid() is not null or current_user in ('authenticated','anon') then
    raise exception 'Original import evidence can only be written by the import service.';
  end if;
  if new.source_import_key is null or new.source_import_key !~ '^[a-f0-9]{64}$'
    or new.source_import is null or jsonb_typeof(new.source_import)<>'object'
    or new.source_import->>'source' is distinct from 'busybusy'
    or jsonb_typeof(new.source_import->'original') is distinct from 'object' then
    raise exception 'Import evidence is incomplete.';
  end if;
  return new;
end; $$;
revoke all on function public.guard_time_entry_import_source() from public,anon,authenticated;
drop trigger if exists guard_time_entry_import_source on public.time_shifts;
create trigger guard_time_entry_import_source before insert or update on public.time_shifts
  for each row execute function public.guard_time_entry_import_source();
comment on column public.time_shifts.source_import is
  'Immutable original CSV row, source file/row and time zone. Ordinary timecard corrections change the shift fields, preserving this evidence.';

-- A historical payroll import is not a new clock-in. Keep the ordinary
-- clock-in cleanup, but do not change today's unit sessions during an import.
create or replace function public.unit_sessions_on_clock_in()
returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
begin
  if new.source_import_key is null then
    perform _close_stale_sessions(new.profile_id);
  end if;
  return new;
end; $$;
select public.attach_sandbox_guards();
