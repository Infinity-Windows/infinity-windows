-- Toolbox talks: daily educational safety talk that a worker must read + sign
-- before their first clock-in. Adds structured educational content to the
-- existing safety_talks, records signed completions (typed name + drawn
-- signature + dated PDF archive), and hard-gates clock_in on today's signature.

-- Rich, editable educational content on the existing safety talk.
--   sections_json  -> { intro, key_hazards[], steps[], dos[], donts[] }
--   visual_aids_json -> [ { prompt, url? } ] (diagram image refs or described placeholders)
alter table safety_talks add column if not exists sections_json jsonb;
alter table safety_talks add column if not exists visual_aids_json jsonb;

-- One row per signed completion. talk_snapshot serializes the talk as signed
-- (audit-proof even if the talk is later edited); pdf_path/signature_path point
-- into the 'toolbox-records' storage bucket.
create table if not exists toolbox_completions (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references safety_talks(id) on delete set null,
  profile_id uuid references profiles(id) on delete cascade,
  signed_at timestamptz not null default now(),
  typed_name text,
  signature_path text,
  talk_snapshot text,
  pdf_path text,
  created_at timestamptz not null default now()
);

create index if not exists toolbox_completions_profile_idx
  on toolbox_completions (profile_id, signed_at desc);

-- RLS: same trusted-crew "authenticated full access" pattern as other tables.
alter table toolbox_completions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_completions' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on toolbox_completions
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Storage bucket for the signed PDF archive + signature PNGs (mirrors the
-- plansets / install-media bucket pattern in 20260715120000_install_capture.sql).
insert into storage.buckets (id, name, public)
values ('toolbox-records', 'toolbox-records', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'authenticated toolbox records'
  ) then
    create policy "authenticated toolbox records"
      on storage.objects for all to authenticated
      using (bucket_id = 'toolbox-records')
      with check (bucket_id = 'toolbox-records');
  end if;
end;
$$;

-- Recreate clock_in with a hard toolbox-talk gate at the top. This is the exact
-- current definition from 20260717001000_time_clock.sql plus the guard: a worker
-- must have signed today's toolbox talk before their first clock-in of the day.
create or replace function clock_in(
  p_project_id uuid, p_cost_code_id uuid, p_photo text default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  -- Hard gate: today's toolbox talk must be signed before clocking in.
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  -- Close any dangling open shift for this user first.
  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts (profile_id, project_id, cost_code_id, clock_in_photo)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo)
  returning * into v_shift;
  return v_shift;
end;
$$;
