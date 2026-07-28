-- "We know about that one" — a foreman's label on a spec/plan discrepancy.
--
-- Reconciling the specs sheet against the building plans is DERIVED: it is
-- recomputed from project_openings + project_mark_specs every time the review
-- screen renders, so a re-extract can never leave a stale finding behind. The
-- one thing that must survive a re-extract is the human judgement — "yes, mark
-- #7 really is missing from the supplier's sheet, we've asked them for it" —
-- because otherwise every re-run of the extraction wipes the office's answer
-- and the same question gets asked again forever.
--
-- So this table stores ONLY the acknowledgement, never the discrepancy. A row
-- exists iff a human has labelled that (mark, kind) as a known supplier gap
-- being chased. Un-labelling deletes the row. If the discrepancy later
-- disappears (the supplier sends the missing sheet and a re-extract picks it
-- up), the acknowledgement simply stops matching anything and the report goes
-- quiet on its own.
--
-- Additive + idempotent: the app degrades gracefully until this is applied
-- (the acknowledgement read is guarded and returns [], so the report still
-- computes and just can't be labelled), so every object is `if not exists` and
-- safe to run on top of live data.

create table if not exists project_spec_discrepancies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Base mark without instance suffix, e.g. "7", "25", "18B" — same key space
  -- as project_mark_specs.mark_code.
  mark_code text not null,
  -- Which disagreement was acknowledged. Mirrors DiscrepancyKind in
  -- app/src/lib/install/specReconciliation.ts; acknowledging "no spec sheet"
  -- must not silence "the spec that turned up has no size".
  kind text not null check (
    kind in (
      'mark_without_spec',
      'spec_without_mark',
      'spec_without_size',
      'spec_without_drawing'
    )
  ),
  -- Free text for the office: "emailed Strata 7/28, sheet to follow".
  note text,
  acknowledged_by uuid references profiles(id) on delete set null,
  acknowledged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One label per discrepancy. Makes acknowledging idempotent, which matters
  -- because extraction can be re-run at will.
  unique (project_id, mark_code, kind)
);

create index if not exists project_spec_discrepancies_project_idx
  on project_spec_discrepancies (project_id);

-- Keep updated_at fresh on every write (same convention as other tables).
create or replace function trg_project_spec_discrepancies_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists project_spec_discrepancies_updated on project_spec_discrepancies;
create trigger project_spec_discrepancies_updated
  before update on project_spec_discrepancies
  for each row execute function trg_project_spec_discrepancies_updated();

-- RLS mirrors project_mark_specs exactly: readable by any authenticated crew
-- member, writable by foreman+ only.
--
-- Read is deliberately open to installers even though the project-wide
-- reconciliation REPORT is foreman-only (gated in the UI). An installer never
-- sees the report; they see one calm line on the single unit they're holding
-- ("no spec sheet for mark #7, the office knows and is chasing it"), and that
-- line needs to know whether the office has actually picked it up. The row
-- carries no information an installer shouldn't have about their own work.
alter table project_spec_discrepancies enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_spec_discrepancies'
      and policyname = 'spec_discrepancies_select_authed'
  ) then
    create policy "spec_discrepancies_select_authed" on project_spec_discrepancies
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_spec_discrepancies'
      and policyname = 'spec_discrepancies_insert_foreman'
  ) then
    create policy "spec_discrepancies_insert_foreman" on project_spec_discrepancies
      for insert to authenticated
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_spec_discrepancies'
      and policyname = 'spec_discrepancies_update_foreman'
  ) then
    create policy "spec_discrepancies_update_foreman" on project_spec_discrepancies
      for update to authenticated
      using (public.is_foreman_plus(auth.uid()))
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_spec_discrepancies'
      and policyname = 'spec_discrepancies_delete_foreman'
  ) then
    create policy "spec_discrepancies_delete_foreman" on project_spec_discrepancies
      for delete to authenticated
      using (public.is_foreman_plus(auth.uid()));
  end if;
end;
$$;

grant select on project_spec_discrepancies to authenticated;
grant insert, update, delete on project_spec_discrepancies to authenticated;
grant all on project_spec_discrepancies to service_role;

-- Stream row changes so a foreman labelling a discrepancy on the office laptop
-- clears it on the crew's phones without a refresh, like the other field tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'project_spec_discrepancies'
  ) then
    alter publication supabase_realtime add table project_spec_discrepancies;
  end if;
end;
$$;
