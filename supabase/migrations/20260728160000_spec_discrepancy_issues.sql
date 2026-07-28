-- Make a labelled spec/plan discrepancy something somebody actually chases.
--
-- 20260728150000 let a foreman label a discrepancy as a known supplier gap.
-- That quietens the review screen, which is right, but on its own it is also
-- how a missing sheet gets forgotten: Black Desert marks #7 and #8 are absent
-- from the supplier's own panel numbering, and nothing was going to remind
-- anyone to ring them about it.
--
-- So the first label now opens a trackable issue, and un-labelling resolves it
-- rather than deleting it, keeping the record of what was chased and when.
--
-- THE DEDUP GUARANTEE, which is the whole reason this lives in the database.
-- Extraction can be re-run at will. `project_spec_discrepancies` is already
-- unique on (project_id, mark_code, kind), so this migration hangs the issue
-- link off that same row: an issue is raised only when `issue_id` is null, and
-- the check plus the insert plus the link-write all happen inside one function
-- call. A re-extract, a repeat label, or two foremen clicking at once cannot
-- produce a second issue — the second attempt either finds the link populated
-- or blocks on the unique constraint and then finds it populated.
--
-- Un-labelling therefore must NOT delete the row (as it did before), because
-- deleting it would drop the link and let the next label raise a duplicate.
-- Instead the row survives with status 'withdrawn'.
--
-- Additive + idempotent: safe to run on top of live data.

-- --- The link, and the label's own lifecycle --------------------------------

alter table project_spec_discrepancies
  add column if not exists issue_id uuid references issues(id) on delete set null;

-- 'acknowledged' = a foreman has labelled this and it is being chased.
-- 'withdrawn'    = they changed their mind; the row (and its issue link) stays
--                  so the history survives and a re-label reuses the issue.
alter table project_spec_discrepancies
  add column if not exists status text not null default 'acknowledged';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_spec_discrepancies_status_check'
  ) then
    alter table project_spec_discrepancies
      add constraint project_spec_discrepancies_status_check
      check (status in ('acknowledged', 'withdrawn'));
  end if;
end;
$$;

create index if not exists project_spec_discrepancies_issue_idx
  on project_spec_discrepancies (issue_id);

-- --- A kind of its own ------------------------------------------------------
--
-- NOT reusing 'missing'. That kind means one specific thing everywhere else in
-- this schema — a physical unit that never came off the truck. It is written
-- with a window_id, resolved by receive_unit, counted into list_reorder_needs,
-- and shown to the office under the heading "Missing deliveries". A supplier
-- paperwork gap is a different problem for a different person, and filing it
-- there would both hide it from whoever chases suppliers and pollute the
-- receiving screen. Same pattern as 20260718050030 adding 'missing' itself.
alter table issues drop constraint if exists issues_kind_check;
alter table issues add constraint issues_kind_check
  check (kind in (
    'failed_install','flag','damage','blocker','complication','missing','spec_gap'
  ));

-- --- RPCs -------------------------------------------------------------------
--
-- Both are foreman+, matching who can see the reconciliation report at all and
-- matching the guard on list_issues() / assign_issue(): a plain installer, or a
-- missing/unknown profile, is rejected. security definer so the guard runs
-- regardless of the caller's own RLS.
--
-- The issue's wording is composed by the caller (p_issue_note) rather than
-- built here: it is user-facing copy that belongs with the rest of the app's
-- plain-English strings, where it is unit-tested. See
-- app/src/lib/install/specDiscrepancyIssues.ts.

create or replace function acknowledge_spec_discrepancy(
  p_project uuid,
  p_mark text,
  p_kind text,
  p_note text default null,
  p_issue_note text default null
)
returns project_spec_discrepancies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row project_spec_discrepancies;
  v_issue issues;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can label a spec discrepancy';
  end if;

  -- Upsert the label. The unique (project_id, mark_code, kind) index is what
  -- makes a repeat label land on the SAME row, which is what makes the issue
  -- link below dedup correctly.
  insert into project_spec_discrepancies (
    project_id, mark_code, kind, note, status, acknowledged_by, acknowledged_at
  )
  values (
    p_project, p_mark, p_kind, nullif(trim(coalesce(p_note, '')), ''),
    'acknowledged', auth.uid(), now()
  )
  on conflict (project_id, mark_code, kind) do update
    set note = nullif(trim(coalesce(p_note, '')), ''),
        status = 'acknowledged',
        acknowledged_by = auth.uid(),
        acknowledged_at = now()
  returning * into v_row;

  if v_row.issue_id is null then
    -- First time this discrepancy has ever been labelled: raise the issue.
    -- Assigned to whoever labelled it, because they are the one already in
    -- contact with the supplier; leaving it unassigned would be worse than a
    -- wrong guess, since an unassigned issue is nobody's job.
    insert into issues (
      project_id, opening_id, kind, urgency, note, created_by, assigned_to
    )
    values (
      p_project, null, 'spec_gap', 'normal',
      coalesce(p_issue_note, p_note), auth.uid(), auth.uid()
    )
    returning * into v_issue;

    update project_spec_discrepancies
    set issue_id = v_issue.id
    where id = v_row.id
    returning * into v_row;
  else
    -- Already has one. Reopen it if a previous un-label resolved it; otherwise
    -- there is nothing to do and emphatically no second issue to raise.
    update issues
    set status = 'open', resolved_by = null, resolved_at = null
    where id = v_row.issue_id and status = 'resolved';
  end if;

  return v_row;
end;
$$;

-- Un-label: the discrepancy goes back on the open list and its issue is
-- resolved (not deleted). Idempotent — withdrawing twice, or withdrawing
-- something never labelled, is a no-op rather than an error.
create or replace function withdraw_spec_discrepancy(
  p_project uuid,
  p_mark text,
  p_kind text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_issue_id uuid;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can withdraw a spec discrepancy';
  end if;

  update project_spec_discrepancies
  set status = 'withdrawn'
  where project_id = p_project and mark_code = p_mark and kind = p_kind
  returning issue_id into v_issue_id;

  if v_issue_id is not null then
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where id = v_issue_id and status = 'open';
  end if;
end;
$$;

grant execute on function acknowledge_spec_discrepancy(uuid, text, text, text, text)
  to authenticated;
grant execute on function withdraw_spec_discrepancy(uuid, text, text)
  to authenticated;

-- --- Backfill labels made before issues existed (idempotent) ----------------
--
-- Empty on the live database at the time of writing, but a label made in the
-- window between this code shipping and this migration running would otherwise
-- keep its issue_id null forever: it is already acknowledged, so nobody would
-- press the button again to raise one. The `issue_id is null` guard makes this
-- safe to re-run. The wording is a plainer cousin of
-- describeDiscrepancyForIssue() — no unit count, since these are one-offs.
do $$
declare
  r record;
  v_issue_id uuid;
begin
  for r in
    select d.id, d.project_id, d.mark_code, d.kind, d.note, d.acknowledged_by,
           coalesce(nullif(p.name, ''), p.job_code, 'this job') as job_name,
           p.job_code
    from project_spec_discrepancies d
    join projects p on p.id = d.project_id
    where d.issue_id is null
      and d.status = 'acknowledged'
  loop
    insert into issues (
      project_id, opening_id, kind, urgency, note, created_by, assigned_to
    )
    values (
      r.project_id, null, 'spec_gap', 'normal',
      r.job_name
        || case when r.job_code is not null then ' (' || r.job_code || ')' else '' end
        || ': mark #' || r.mark_code || ' '
        || case r.kind
             when 'mark_without_spec' then
               'has no spec sheet in the supplier''s set. Ask the supplier for the missing sheet.'
             when 'spec_without_mark' then
               'is on the spec sheet but no window on the plans uses it. Check with the supplier whether it belongs on this job.'
             when 'spec_without_size' then
               'has a spec but no size on it. Get the dimensions from the supplier before anything is cut.'
             else
               'has a written spec but no drawing. Ask the supplier for the elevation so the crew can check the shape.'
           end
        || case when r.note is not null then ' Note: ' || r.note else '' end,
      r.acknowledged_by, r.acknowledged_by
    )
    returning id into v_issue_id;

    update project_spec_discrepancies set issue_id = v_issue_id where id = r.id;
  end loop;
end;
$$;
