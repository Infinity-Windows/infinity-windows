-- Wave R — Rewrite this set (owner grill 2026-08-28, the Mad Moose story):
-- a manifest said mark #8 was 16 packages (15 glass-ish + 1 frame-ish). The
-- truth on the truck was 12 pieces of glass in one crate plus 4 frame
-- packages. Fixing that used to mean editing fifteen slot cards by hand.
--
-- rewrite_set is the one apply: the caller declares a mark's set as a short
-- list of lines — { part_type, packaging, count } — and this function diffs
-- that declaration against reality, atomically, in one transaction:
--
--   1. Arrived/stored/checked-out packages are NEVER touched by arithmetic.
--      They are re-fitted into the new declaration first (matched by part
--      type) and renumbered (part_index/part_total) to the new line's total.
--   2. Expected (status = 'minted') packages die first when a line shrinks,
--      and are minted when a line grows — reusing 'preissued', the same
--      movement event mint_mark_packages already writes for this. Deleting
--      a minted package writes NOTHING new, matching delete_packages, which
--      already relies on movements.package_id being ON DELETE CASCADE.
--   3. Pieces-in-a-crate lines map onto the existing piece_count pool
--      representation (crates_are_packages, 20260932000000): the expected
--      half of a pool line is wiped and re-minted as one row holding the
--      new total; arrived pool rows are never resized.
--   4. A line's new count below that part type's already-arrived count
--      refuses the WHOLE apply, atomically, naming the numbers.
--   5. Retyping is free for expected material. For arrived material it is
--      allowed ONLY when a whole old line vanishes and there is exactly one
--      new line of the same packaging it could unambiguously become —
--      otherwise the apply refuses rather than guess which arrived pieces
--      go where.
--
-- Numbering note: each (part type, packaging) line is its own locally
-- numbered run — "frame 1 of 4", "frame 2 of 4" — rather than one number
-- shared across the whole mark regardless of type. The manifest's old
-- single running number is exactly the shape that let 15 mistyped cards
-- hide inside one mark; a declaration made of independently-sized lines is
-- the fix, and "renumber part_index/part_total to the new totals" (the
-- spec's words) reads most naturally as scoped to the line being renumbered.
--
-- Guard: same rank as delete_packages (foreman+, is_foreman_plus). Scope is
-- the same real-job/waiting-job union file_receipt just settled
-- (20260957000000_receipts.sql): p_project_id XOR p_pending_job_name.
--
-- p_kind ('window'|'door', default 'window') is the one addition beyond the
-- spec's approximate signature: packages.category isn't NOT NULL, but every
-- other creation path in this file sets it deliberately, and "Start this
-- set over" (existing delete_packages) can leave a mark with zero packages
-- to redeclare from — nothing left to read a category off of. When any
-- package already exists for this scope+mark, ITS category always wins;
-- p_kind is only the from-scratch fallback. It never rewrites an existing
-- package's category — that stays SetEditor's Window/Door toggle's job.

create or replace function public.rewrite_set(
  p_project_id uuid default null,
  p_pending_job_name text default null,
  p_mark text default null,
  p_lines jsonb default '[]'::jsonb,
  p_kind text default 'window'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mark text := upper(regexp_replace(trim(coalesce(p_mark, '')), '^#', ''));
  v_pending text := nullif(trim(coalesce(p_pending_job_name, '')), '');
  v_category text := case when p_kind = 'door' then 'doors' else 'windows' end;
  v_existing_category text;
  v_project_mark uuid;
  v_removed_count int;
  v_candidate_count int;
  v_removed_part_type text;
  v_removed_packaging text;
  v_removed_arrived int;
  v_refit_from_type text;
  v_refit_from_packaging text;
  v_refit_to_type text;
  v_refit_to_packaging text;
  v_parts text;
  v_row record;
  v_key_type text;
  v_key_packaging text;
  v_old_arrived int;
  v_old_expected int;
  v_old_arrived_ids uuid[];
  v_old_expected_ids uuid[];
  v_target_count int;
  v_target_expected int;
  v_mint int;
  v_release int;
  v_minted int := 0;
  v_deleted int := 0;
  v_delivery uuid;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can rewrite a set.'
      using errcode = '42501';
  end if;

  if (p_project_id is null) = (v_pending is null) then
    raise exception 'That set does not exist.';
  end if;
  if p_project_id is not null and not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That set does not exist.';
  end if;
  if length(v_mark) < 1 then
    raise exception 'That set does not exist.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'That set does not exist.';
  end if;
  if jsonb_array_length(p_lines) > 12 then
    raise exception 'A set holds at most 12 lines — split it if it needs more.';
  end if;

  -- Register the mark on the job's schedule (create_delivery_set's own
  -- precedent) — a real job's mark may not be on it yet: the whole point of
  -- this screen is fixing material that never matched the manifest.
  if p_project_id is not null then
    insert into project_marks (project_id, mark_code)
    values (p_project_id, v_mark)
    on conflict (project_id, mark_code) do nothing;
    select id into v_project_mark from project_marks
    where project_id = p_project_id and mark_code = v_mark;
  end if;

  -- ---------------------------------------------------- normalize the ask

  drop table if exists _rw_new;
  create temp table _rw_new (
    part_type text not null default '',
    packaging text not null,
    count int not null
  ) on commit drop;

  insert into _rw_new (part_type, packaging, count)
  select coalesce(nullif(trim(lower(x.part_type)), ''), ''), x.packaging, sum(x.count)::int
  from jsonb_to_recordset(p_lines) as x(part_type text, packaging text, count int)
  where x.packaging in ('package', 'crate_pool') and x.count is not null and x.count > 0
  group by 1, 2;

  if exists (select 1 from _rw_new where packaging = 'package' and count > 20) then
    raise exception 'A line of packages holds at most 20.';
  end if;
  if exists (select 1 from _rw_new where packaging = 'crate_pool' and count > 99) then
    raise exception 'A line of pieces in a crate holds at most 99.';
  end if;

  -- ---------------------------------------------------- current reality

  drop table if exists _rw_old;
  create temp table _rw_old (
    part_type text not null default '',
    packaging text not null,
    arrived int not null default 0,
    expected int not null default 0,
    arrived_ids uuid[] not null default array[]::uuid[],
    expected_ids uuid[] not null default array[]::uuid[]
  ) on commit drop;

  insert into _rw_old (part_type, packaging, arrived, expected, arrived_ids, expected_ids)
  with scope as (
    select p.*
    from packages p
    where coalesce(p.part_type, '') <> 'crate'
      and (
        (p_project_id is not null and p.project_id = p_project_id and exists (
          select 1 from package_marks pm
          join project_marks pmk on pmk.id = pm.mark_id
          where pm.package_id = p.id and pmk.mark_code = v_mark
        ))
        or
        (v_pending is not null and p.project_id is null
           and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
      )
  )
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'package',
         coalesce(count(*) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(count(*) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id order by part_index nulls last) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id order by part_index nulls last) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is null
  group by 1
  union all
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'crate_pool',
         coalesce(sum(piece_count) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(sum(piece_count) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is not null
  group by 1;

  select category into v_existing_category from packages p
  where coalesce(p.part_type, '') <> 'crate' and p.category is not null
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  limit 1;
  if v_existing_category is not null then
    v_category := v_existing_category;
  end if;

  -- The tailgate lists a delivery's packages by delivery_id, and the whole
  -- point of this screen is fixing a set WHILE unloading — so replacements
  -- minted here inherit the delivery the set's existing packages rode in on
  -- (latest first when a set somehow spans two trucks). Captured BEFORE the
  -- apply loop deletes anything. Declaring from scratch has no truck to
  -- inherit; those mint delivery-less, same as the ledger's own additions.
  select p.delivery_id into v_delivery from packages p
  where p.delivery_id is not null
    and coalesce(p.part_type, '') <> 'crate'
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  order by p.bound_at desc nulls last
  limit 1;

  -- --------------------------------------- ambiguity / re-fit resolution
  -- A "removed" line: an old group with arrived material whose (type,
  -- packaging) is absent from the new declaration entirely — the line
  -- vanished, not merely shrank. Re-fit is allowed ONLY when exactly one
  -- such line exists and exactly one brand-new line (same packaging) can
  -- hold its arrived count; anything less clear-cut refuses rather than
  -- guess with real material.

  drop table if exists _rw_removed;
  create temp table _rw_removed on commit drop as
  select o.* from _rw_old o
  left join _rw_new n on n.part_type = o.part_type and n.packaging = o.packaging
  where n.part_type is null and o.arrived > 0;

  drop table if exists _rw_new_only;
  create temp table _rw_new_only on commit drop as
  select n.* from _rw_new n
  left join _rw_old o on o.part_type = n.part_type and o.packaging = n.packaging
  where o.part_type is null;

  select count(*) into v_removed_count from _rw_removed;

  if v_removed_count = 1 then
    select part_type, packaging, arrived into v_removed_part_type, v_removed_packaging, v_removed_arrived
    from _rw_removed;
    select count(*) into v_candidate_count from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  else
    v_candidate_count := null;
  end if;

  if v_removed_count = 1 and v_candidate_count = 1 then
    select v_removed_part_type, v_removed_packaging, part_type, packaging
      into v_refit_from_type, v_refit_from_packaging, v_refit_to_type, v_refit_to_packaging
    from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  elsif v_removed_count > 0 then
    select string_agg(
      arrived || ' ' || coalesce(nullif(part_type, ''), 'untyped') || ' ' ||
      (case when packaging = 'crate_pool' then 'piece' else 'package' end) ||
      (case when arrived = 1 then '' else 's' end),
      ', ' order by part_type
    ) into v_parts
    from _rw_removed;
    raise exception '%', 'Some arrived material doesn''t clearly fit the new plan: ' || v_parts ||
      '. Retype it one at a time first.';
  end if;

  -- ------------------------------------------------------- apply, per line

  for v_row in
    select part_type, packaging from _rw_old
    union
    select part_type, packaging from _rw_new
  loop
    v_key_type := v_row.part_type;
    v_key_packaging := v_row.packaging;

    select coalesce(arrived, 0), coalesce(expected, 0),
           coalesce(arrived_ids, array[]::uuid[]), coalesce(expected_ids, array[]::uuid[])
      into v_old_arrived, v_old_expected, v_old_arrived_ids, v_old_expected_ids
    from _rw_old where part_type = v_key_type and packaging = v_key_packaging;
    v_old_arrived := coalesce(v_old_arrived, 0);
    v_old_expected := coalesce(v_old_expected, 0);
    v_old_arrived_ids := coalesce(v_old_arrived_ids, array[]::uuid[]);
    v_old_expected_ids := coalesce(v_old_expected_ids, array[]::uuid[]);

    if v_refit_from_type is not null
       and v_key_type = v_refit_from_type and v_key_packaging = v_refit_from_packaging then
      -- This line's arrived material moved on; only its never-arrived
      -- placeholders remain, and those are simply released below.
      v_old_arrived := 0;
      v_old_arrived_ids := array[]::uuid[];
    elsif v_refit_to_type is not null
       and v_key_type = v_refit_to_type and v_key_packaging = v_refit_to_packaging then
      declare
        v_src_arrived int;
        v_src_ids uuid[];
      begin
        select coalesce(arrived, 0), coalesce(arrived_ids, array[]::uuid[])
          into v_src_arrived, v_src_ids
        from _rw_old where part_type = v_refit_from_type and packaging = v_refit_from_packaging;
        v_old_arrived := v_old_arrived + coalesce(v_src_arrived, 0);
        v_old_arrived_ids := v_old_arrived_ids || coalesce(v_src_ids, array[]::uuid[]);
      end;
    end if;

    select count into v_target_count from _rw_new
    where part_type = v_key_type and packaging = v_key_packaging;
    v_target_count := coalesce(v_target_count, 0);

    if v_target_count < v_old_arrived then
      raise exception '%',
        v_old_arrived::text || ' ' || coalesce(nullif(v_key_type, ''), 'untyped') ||
        (case when v_key_packaging = 'crate_pool'
              then ' piece' || (case when v_old_arrived = 1 then '' else 's' end)
              else '' end) ||
        ' already arrived — the new plan only holds ' || v_target_count::text ||
        '. Un-arrive or delete pieces first, so nothing real disappears.';
    end if;

    if v_target_count = 0 and v_old_arrived = 0 and v_old_expected = 0 then
      continue; -- nothing here at all — not a line, before or after
    end if;

    v_target_expected := v_target_count - v_old_arrived;
    v_mint := greatest(0, v_target_expected - v_old_expected);
    v_release := greatest(0, v_old_expected - v_target_expected);

    if v_key_packaging = 'package' then
      declare
        v_release_ids uuid[];
        v_keep_expected_ids uuid[];
        v_new_minted_ids uuid[] := array[]::uuid[];
        v_final_ids uuid[];
        v_idx int;
        v_mint_i int;
        v_id uuid;
        v_len int := coalesce(array_length(v_old_expected_ids, 1), 0);
      begin
        if v_release > 0 then
          v_release_ids := v_old_expected_ids[(v_len - v_release + 1):v_len];
          v_keep_expected_ids := v_old_expected_ids[1:(v_len - v_release)];
        else
          v_release_ids := array[]::uuid[];
          v_keep_expected_ids := v_old_expected_ids;
        end if;

        if coalesce(array_length(v_release_ids, 1), 0) > 0 then
          delete from packages where id = any (v_release_ids);
          v_deleted := v_deleted + array_length(v_release_ids, 1);
        end if;

        if v_mint > 0 then
          for v_mint_i in 1..v_mint loop
            insert into packages
              (status, project_id, category, part_type, pending_job_name,
               short_code, bound_at, bound_by, mfr_mark, delivery_id)
            values
              ('minted', p_project_id, v_category, nullif(v_key_type, ''),
               case when p_project_id is null then v_pending end,
               issue_package_short_code(), now(), auth.uid()::text, v_mark, v_delivery)
            returning id into v_id;
            v_new_minted_ids := v_new_minted_ids || v_id;
            if p_project_id is not null then
              insert into package_marks (package_id, mark_id)
              values (v_id, v_project_mark) on conflict do nothing;
            end if;
            insert into movements (package_id, event, project_id, actor, reason)
            values (v_id, 'preissued', p_project_id, auth.uid()::text,
                    'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_count::text ||
                    ' ' || coalesce(nullif(v_key_type, ''), 'untyped'));
          end loop;
          v_minted := v_minted + v_mint;
        end if;

        v_final_ids := v_old_arrived_ids || v_keep_expected_ids || v_new_minted_ids;
        v_idx := 0;
        foreach v_id in array v_final_ids loop
          v_idx := v_idx + 1;
          update packages
          set part_index = v_idx, part_total = v_target_count, part_type = nullif(v_key_type, '')
          where id = v_id;
        end loop;
      end;
    else -- crate_pool
      declare
        v_id uuid;
      begin
        if coalesce(array_length(v_old_expected_ids, 1), 0) > 0 then
          delete from packages where id = any (v_old_expected_ids);
          v_deleted := v_deleted + array_length(v_old_expected_ids, 1);
        end if;

        if v_target_expected > 0 then
          insert into packages
            (status, project_id, category, part_type, piece_count, mfr_mark,
             pending_job_name, short_code, bound_at, bound_by, delivery_id)
          values
            ('minted', p_project_id, v_category, nullif(v_key_type, ''), v_target_expected, v_mark,
             case when p_project_id is null then v_pending end,
             issue_package_short_code(), now(), auth.uid()::text, v_delivery)
          returning id into v_id;
          if p_project_id is not null then
            insert into package_marks (package_id, mark_id)
            values (v_id, v_project_mark) on conflict do nothing;
          end if;
          insert into movements (package_id, event, project_id, actor, reason)
          values (v_id, 'preissued', p_project_id, auth.uid()::text,
                  'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_expected::text ||
                  ' piece(s) of ' || coalesce(nullif(v_key_type, ''), 'untyped') || ' in the crates');
          v_minted := v_minted + 1;
        end if;

        if coalesce(array_length(v_old_arrived_ids, 1), 0) > 0 then
          update packages set part_type = nullif(v_key_type, '')
          where id = any (v_old_arrived_ids);
        end if;
      end;
    end if;
  end loop;

  return jsonb_build_object('minted', v_minted, 'deleted', v_deleted);
end;
$$;

grant execute on function public.rewrite_set(uuid, text, text, jsonb, text) to authenticated;
