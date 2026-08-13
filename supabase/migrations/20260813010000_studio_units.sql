-- Studio unit catalog (owner decisions, 2026-08-13): company-wide library of
-- window/door configurations built in the Model Studio's unit builder —
-- panel-by-panel (fixed / slider / bifold / casement / hung), directions,
-- exact dimensions. A unit saved on one job is available on every job.
-- Config is jsonb: { kind, heightMm, panels: [{ widthMm, mechanism,
-- direction? }] } — corner (two-wall) units come in a later slice and will
-- extend this shape, so the client treats unknown keys as forward-compat.

create table if not exists studio_units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('window','door')),
  config jsonb not null,
  /** 'built' by hand in the wizard, or 'spec-import' drafted from a job's
      window schedule. */
  source text not null default 'built' check (source in ('built','spec-import')),
  created_by uuid references profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table studio_units enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'studio_units' and policyname = 'read units'
  ) then
    create policy "read units" on studio_units
      for select to authenticated using (true);
  end if;
  -- Same floor as the Studio itself: building the catalog is an office call.
  if not exists (
    select 1 from pg_policies
    where tablename = 'studio_units' and policyname = 'supervisor manage'
  ) then
    create policy "supervisor manage" on studio_units
      for all to authenticated
      using (_is_supervisor(auth.uid())) with check (_is_supervisor(auth.uid()));
  end if;
end;
$$;
