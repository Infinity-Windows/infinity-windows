-- Rich per-mark window/door line-item specs from the specs planset.
--
-- The specs planset defines what each MARK is (mark "1", "W3", …). Today the
-- extractor only captured a coarse product code + size + one-word color. This
-- table stores the FULL manufacturer line-item spec per mark — style, glass,
-- color, decoded size, operation, energy numbers, and a flexible catch-all —
-- so the crew can see exactly what they're installing.
--
-- Specs are PER MARK and SHARED across every instance/opening of that mark:
-- pull once for mark "1" and show identically on openings 1-1, 1-2, …. Hence
-- the key is (project_id, mark_code), NOT per individual opening.
--
-- Extraction writes confirmed=false drafts (source 'ai'/'deterministic'); a
-- foreman reviews + corrects them and sets confirmed=true (source 'manual' on
-- edit). A re-extract must never clobber a confirmed row (enforced client-side,
-- same guardrail as project_openings).
--
-- Additive + idempotent: the app degrades gracefully until this is applied
-- (spec queries are guarded and simply hide), so every object is `if not
-- exists` and safe to run on top of live data.

create table if not exists project_mark_specs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Base mark without instance suffix, e.g. "1", "W3", "A-101". Shared across
  -- all openings of that mark on the project.
  mark_code text not null,

  -- Line-item fields (all best-effort / nullable).
  style text,                    -- "Thermal Break Aluminum Fixed Window (Nail Fins)"
  glass text,                    -- "5 (Low-E 366)+12A+5 … tempered … (argon)"
  color text,                    -- "Black (Aluminum Profile Color)"
  size_code text,                -- raw manufacturer call size, e.g. "3060"
  width_in int,                  -- decoded from size_code (WWHH), null if it can't decode
  height_in int,                 -- decoded from size_code (WWHH), null if it can't decode
  operation text,                -- XO / OX / Fixed / Casement / …
  tempered boolean,
  egress boolean,
  u_factor numeric,
  shgc numeric,
  grids text,
  screen text,
  product_line text,             -- product line / manufacturer
  -- Flexible catch-all for any other line-item attributes the extractor found.
  extra jsonb not null default '{}'::jsonb,

  -- Review/trust + provenance.
  confirmed boolean not null default false,
  source text not null default 'ai'
    check (source in ('ai','manual','deterministic')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, mark_code)
);

create index if not exists project_mark_specs_project_idx
  on project_mark_specs (project_id);

-- Keep updated_at fresh on every write (same convention as other tables).
create or replace function trg_project_mark_specs_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists project_mark_specs_updated on project_mark_specs;
create trigger project_mark_specs_updated
  before update on project_mark_specs
  for each row execute function trg_project_mark_specs_updated();

-- Foreman-plus predicate: anyone above a plain installer. Mirrors the app's
-- roleRank/isForemanPlus and the guards in undo_install / list_issues (only a
-- plain installer, or an unknown role, is denied). SECURITY DEFINER + pinned
-- search_path so it can read profiles regardless of the caller's own RLS.
create or replace function public.is_foreman_plus(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from profiles where id = p_uid)
      not in ('installer'),
    false
  );
$$;

-- RLS: readable by any authenticated crew member (installer+ can READ specs);
-- writable by foreman+ only (mirrors the openings review/confirm gating, which
-- is a foreman-only route). project_openings itself is exposed to authenticated
-- for read; specs match that for read and additionally gate writes foreman+.
alter table project_mark_specs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_specs' and policyname = 'mark_specs_select_authed'
  ) then
    create policy "mark_specs_select_authed" on project_mark_specs
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_specs' and policyname = 'mark_specs_insert_foreman'
  ) then
    create policy "mark_specs_insert_foreman" on project_mark_specs
      for insert to authenticated
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_specs' and policyname = 'mark_specs_update_foreman'
  ) then
    create policy "mark_specs_update_foreman" on project_mark_specs
      for update to authenticated
      using (public.is_foreman_plus(auth.uid()))
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_specs' and policyname = 'mark_specs_delete_foreman'
  ) then
    create policy "mark_specs_delete_foreman" on project_mark_specs
      for delete to authenticated
      using (public.is_foreman_plus(auth.uid()));
  end if;
end;
$$;

grant select on project_mark_specs to authenticated;
grant insert, update, delete on project_mark_specs to authenticated;
grant all on project_mark_specs to service_role;

-- Stream row changes so the review board / install sheets update live, like the
-- other field tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'project_mark_specs'
  ) then
    alter publication supabase_realtime add table project_mark_specs;
  end if;
end;
$$;
