-- Merge: time clock / payroll. Shifts with cost-code splits, breaks, photos,
-- and a signed sign-off. Foreman/admin approve.

create table if not exists cost_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  label text not null,
  active boolean not null default true
);

insert into cost_codes (code, label) values
  ('100', 'Install — windows'),
  ('110', 'Install — doors'),
  ('200', 'Load / unload'),
  ('300', 'Rework / callback'),
  ('400', 'Shop / staging'),
  ('900', 'Travel')
on conflict do nothing;

create table if not exists time_shifts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  cost_code_id uuid references cost_codes(id) on delete set null,
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  break_seconds int not null default 0,
  clock_in_photo text,
  clock_out_photo text,
  injured boolean,
  time_confirmed boolean,
  signed_at timestamptz,
  status text not null default 'open'
    check (status in ('open','submitted','approved')),
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  edited_note text,
  created_at timestamptz not null default now()
);

create index if not exists time_shifts_profile_idx on time_shifts (profile_id, clock_in_at desc);
create index if not exists time_shifts_status_idx on time_shifts (status);

alter table cost_codes enable row level security;
alter table time_shifts enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='cost_codes' and policyname='authenticated full access') then
    create policy "authenticated full access" on cost_codes for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='time_shifts' and policyname='authenticated full access') then
    create policy "authenticated full access" on time_shifts for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Clock in.
create or replace function clock_in(
  p_project_id uuid, p_cost_code_id uuid, p_photo text default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  -- Close any dangling open shift for this user first.
  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts (profile_id, project_id, cost_code_id, clock_in_photo)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- Clock out + sign-off.
create or replace function clock_out(
  p_shift_id uuid, p_photo text default null,
  p_injured boolean default false, p_time_confirmed boolean default true,
  p_break_seconds int default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  update time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v_shift;
  if v_shift is null then raise exception 'no open shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

create or replace function approve_shift(p_shift_id uuid)
returns time_shifts language plpgsql security definer as $$
declare v_role text; v_shift time_shifts;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a lead-level user can approve';
  end if;
  update time_shifts set status='approved', approved_by=auth.uid(), approved_at=now()
  where id = p_shift_id returning * into v_shift;
  return v_shift;
end;
$$;
