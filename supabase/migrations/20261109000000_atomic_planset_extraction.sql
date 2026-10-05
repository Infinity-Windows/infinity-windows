-- DRAFT — NOT A MIGRATION YET. The version number is being coordinated in
-- another chat. Copy this body into
-- supabase/migrations/<version>_atomic_planset_extraction.sql once it is
-- assigned, and run a db-dry-run probe (docs/db-dry-run.md, section 5 below)
-- before it merges. Authored by Claude Opus 5.5 (claude-opus-5-5), 2026-10-05;
-- not yet executed against any database.
--
-- Atomic plan-set extraction (PV 40, 2026-10-05).
--
-- PV 40 has a vinyl CAD set and an aluminum CAD set, and both use mark 1.
-- Reading the second set used to look like a re-read of the first and
-- deleted its unconfirmed windows. The browser now names the source document
-- exactly and refuses a shared mark (app/src/lib/install/extract.ts), but
-- every write that decision guards was still sent from the browser as
-- separate statements:
--
--   * openings: a DELETE, then an INSERT — two requests. A second device
--     could land its own save between them (Fable review, 2026-10-05): the
--     first set's drafts deleted, the second set's rows inserted, the first
--     save's insert then failing on the live-code unique index. Nothing
--     refused, data gone.
--   * mark specs: a collision read, then a per-mark upsert. Same window.
--
-- This moves both commits into the database, one transaction each, under ONE
-- per-project advisory lock, so a check and the write it licenses can no
-- longer be separated. The slow part — PDF parsing and the AI vision read —
-- stays in the browser and finishes BEFORE either function is called, so no
-- transaction is ever held open across it.
--
-- WHAT THIS DOES NOT DO: hold two material sets that share a mark number. It
-- REFUSES them (hint forge.planset.mark_collision). Full support needs a set
-- identity on openings, mark specs, the live-code unique index and every
-- consumer keyed on the bare mark — a separate migration and review.
--
-- ERROR CONTRACT. Every refusal raised here carries a stable code in HINT
-- (PostgREST returns it as `hint`), a plain-English MESSAGE a crew member can
-- read, and JSON in DETAIL where useful. The browser maps on HINT only
-- (PLANSET_REFUSAL_CODES in app/src/lib/install/api.ts):
--
--   forge.planset.auth            42501  signed out / removed / partner / below foreman
--   forge.planset.not_found       P0001  the planset is not on this job, or the job is in the trash
--   forge.planset.stale_snapshot  P0001  openings changed since the browser read them
--   forge.planset.mark_collision  P0001  DETAIL {"marks":[..],"planset_ids":[..]}
--   forge.planset.not_owned       P0001  a delete target is not this document's draft
--   forge.planset.protected       P0001  a delete target carries field work or history
--   forge.planset.invalid_plan    P0001  malformed or out-of-scope payload
--   forge.planset.code_conflict   P0001  an inserted code is already live on the job
--   forge.planset.update_required P0001  an old cached app wrote around these functions
--
-- Section 4b adds two more families (OPENING_TYPE_REFUSAL_CODES and
-- CATALOG_REFUSAL_CODES in api.ts / lib/api.ts):
--   forge.opening_type.{auth,not_found,installed,stale,unknown_type,unit_mismatch,update_required}
--   forge.catalog.{auth,test_account,invalid,update_required}
--
-- SECURITY DEFINER, deliberately, for the two RPCs:
--   1. Protection must not depend on what the CALLER can see. The delete
--      check asks "does anything reference this opening?" across every table
--      with a foreign key to project_openings. Under SECURITY INVOKER a row
--      hidden from the caller by RLS would read as "no reference" and licence
--      an ON DELETE CASCADE that destroys it.
--   2. Both functions set the transaction-local marker the old-client gates
--      below accept — the same pattern as app.pin_undo, app.opening_removal
--      and app.field_unit_add. It is set with set_config(..., true), so it
--      dies with the transaction, and it is unreachable from a browser:
--      set_config lives in pg_catalog, which PostgREST does not expose.
--   Each RPC re-checks the caller itself (auth.uid() present, account not
--   removed or revoked, not a partner, foreman+), because a definer bypasses
--   the RLS that would otherwise ask. guard_opening_create_delete still fires
--   on every insert and delete, because auth.uid() is the caller's JWT claim,
--   not the function owner. search_path is pinned; EXECUTE is revoked from
--   PUBLIC and anon and granted to authenticated only.
--
-- The gate trigger functions are SECURITY INVOKER: they read only auth.uid(),
-- the marker and projects.deleted_at, and need nothing the writer lacks.

-- ===========================================================================
-- 1. Shared internals (not callable by clients)
-- ===========================================================================

create or replace function public._planset_extraction_caller()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in again before reading a plan set.'
      using errcode = '42501', hint = 'forge.planset.auth';
  end if;
  if public.is_partner_user() then
    raise exception 'Only the crew can read plan sets into a job.'
      using errcode = '42501', hint = 'forge.planset.auth';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.retired_at is null and p.access_revoked_at is null
  ) then
    raise exception 'This account can no longer change jobs.'
      using errcode = '42501', hint = 'forge.planset.auth';
  end if;
  if not public.is_foreman_plus(v_uid) then
    raise exception 'Only a foreman or above can load windows and doors from a plan set.'
      using errcode = '42501', hint = 'forge.planset.auth';
  end if;
  return v_uid;
end;
$$;

-- The source document must be on THIS job, and the job must be live (not in
-- the trash). Returns the planset's kind as the app normalises it.
create or replace function public._planset_extraction_source(
  p_project_id uuid,
  p_planset_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  select case when ps.kind = 'specs' then 'specs' else 'building' end
    into v_kind
    from public.project_plansets ps
    join public.projects pr on pr.id = ps.project_id
   where ps.id = p_planset_id
     and ps.project_id = p_project_id
     and pr.deleted_at is null
     and public._ai_job_visible(p_project_id, auth.uid());
  if v_kind is null then
    raise exception 'That plan set is not on this job any more. Reload the page and try again.'
      using errcode = 'P0001', hint = 'forge.planset.not_found';
  end if;
  return v_kind;
end;
$$;

-- Marks a read shares with a DIFFERENT document of the same kind. Mirrors
-- findCrossDocumentMarkCollisions in app/src/lib/install/extract.ts: the same
-- planset id is a re-read; rows with no planset id are the legacy single
-- slot; the other kind (plans vs specs) is the normal pairing, not a clash;
-- protected rows DO clash. Spec rows count as owned marks too when
-- p_include_specs (any specs-kind read, and every spec commit). Returns null
-- when there is no clash. Uses mark_base on both sides, which mirrors
-- markBase in extract.ts.
create or replace function public._planset_mark_collisions(
  p_project_id uuid,
  p_planset_id uuid,
  p_kind text,
  p_marks text[],
  p_include_specs boolean
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with incoming as (
    select distinct public.mark_base(m) as mark
      from unnest(coalesce(p_marks, '{}'::text[])) as m
     where nullif(trim(m), '') is not null
  ),
  kinds as (
    select ps.id, case when ps.kind = 'specs' then 'specs' else 'building' end as kind
      from public.project_plansets ps
     where ps.project_id = p_project_id
  ),
  hits as (
    select public.mark_base(o.opening_code) as mark, o.planset_id
      from public.project_openings o
      left join kinds k on k.id = o.planset_id
     where o.project_id = p_project_id
       and o.removed_at is null
       and o.planset_id is not null
       and o.planset_id <> p_planset_id
       and coalesce(k.kind, 'building') = p_kind
       and public.mark_base(o.opening_code) in (select mark from incoming)
    union
    select public.mark_base(s.mark_code), s.planset_id
      from public.project_mark_specs s
     where p_include_specs
       and s.project_id = p_project_id
       and s.planset_id is not null
       and s.planset_id <> p_planset_id
       and public.mark_base(s.mark_code) in (select mark from incoming)
  )
  select case when not exists (select 1 from hits) then null else jsonb_build_object(
    'marks', (select jsonb_agg(distinct h.mark) from hits h),
    'planset_ids', (select jsonb_agg(distinct h.planset_id) from hits h)
  ) end;
$$;

create or replace function public._raise_planset_collision(p_collision jsonb)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  if p_collision is null then
    return;
  end if;
  raise exception 'No windows were loaded from this file: it uses mark numbers another plan set on this job already uses (%). Nothing was changed.',
      (select string_agg('#' || m, ', ') from jsonb_array_elements_text(p_collision -> 'marks') m)
    using errcode = 'P0001',
          hint = 'forge.planset.mark_collision',
          detail = p_collision::text;
end;
$$;

-- Openings among p_ids that ANY other table points at — found from the
-- catalog, not a hand list, so a table added next month is covered the day it
-- lands. The browser's list (OPENING_REFERENCE_TABLES in api.ts) names six
-- tables; the schema has more (opening notes, phases, summons, the
-- assignment log, attachments, unit sessions, ...), and every one is a
-- cascade or a set-null a re-read must not trigger. The one exemption is the
-- pin-move history: it records where a draft's dot was dragged, the in-place
-- re-read below PRESERVES it, and on master it already cascaded with the
-- draft. Runs as definer so RLS cannot hide a reference.
create or replace function public._openings_with_references(p_ids uuid[])
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  fk record;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'public.project_openings'::regclass
       and cardinality(c.conkey) = 1
       and c.conrelid <> 'public.project_opening_pin_moves'::regclass
       and c.conrelid <> 'public.project_openings'::regclass
  loop
    return query execute format(
      'select distinct %I::uuid from %s where %I = any($1)',
      fk.col, fk.tbl, fk.col
    ) using p_ids;
  end loop;
end;
$$;

-- Numeric equality that survives a browser round trip (a float read as 17
-- digits and sent back, or a numeric with more digits than a JS number
-- holds). Pins are 0..1 and sizes are inches; 1e-9 is far below both.
create or replace function public._num_differs(a numeric, b numeric)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when a is null and b is null then false
    when a is null or b is null then true
    else abs(a - b) > 0.000000001
  end;
$$;

revoke all on function public._planset_extraction_caller() from public, anon, authenticated;
revoke all on function public._planset_extraction_source(uuid, uuid) from public, anon, authenticated;
revoke all on function public._planset_mark_collisions(uuid, uuid, text, text[], boolean) from public, anon, authenticated;
revoke all on function public._raise_planset_collision(jsonb) from public, anon, authenticated;
revoke all on function public._openings_with_references(uuid[]) from public, anon, authenticated;
revoke all on function public._num_differs(numeric, numeric) from public, anon, authenticated;

-- ===========================================================================
-- 2. Openings: commit what the browser planned, or nothing
-- ===========================================================================
--
-- The browser still PLANS (planDraftPersistence: pins preserved, CAD wins,
-- vision-first). This function decides whether that plan is still TRUE:
--
--   p_snapshot        every live opening on the job, exactly as the browser
--                     read it before planning (EXISTING_OPENING_COLS). Any
--                     difference from the rows now on the job — a row added
--                     or removed, measured, assigned, re-pinned — refuses as
--                     stale: the plan was made against a job that no longer
--                     exists.
--   p_incoming_marks  every mark the read produced (markBase), including
--                     marks the planner skipped, so the collision check sees
--                     the whole read, not only what survived planning.
--   p_delete_ids      what the planner would remove. Each must be this
--                     document's own unprotected draft (or a legacy row with
--                     no source), or — on an authoritative specs read — an
--                     unprotected building draft sharing a read mark (CAD
--                     wins). Anything else refuses.
--   p_inserts         what the planner would add. Always stamped here with
--                     p_planset_id and confirmed = false whatever the payload
--                     says, and a specs read never places a pin.
--
--   p_types           one catalog sample per mark (catalogSamplesFromDrafts in
--                     api.ts): the global window_types row the mark resolves
--                     to (type_code = upper(mark)), what to fill into it, and
--                     a catalog product the read MATCHED for the mark, if any.
--
-- IDs AND HISTORY. Where a same-document draft and an insert carry the SAME
-- opening code, the row is UPDATED in place instead of deleted and re-made:
-- its id, its pin-move history and its flag survive a re-read. Only drafts
-- the new read no longer lists are deleted. (On master every re-read deleted
-- and re-inserted, minting new ids.)
--
-- CATALOG AND TYPE LINKS (2026-10-05, second pass). These were two browser
-- passes — ensureTypesFromSpecs, then linkSpecsToOpenings — run apart from
-- the openings save, so a read the save then refused, or one an old cached
-- app sent, had already written the GLOBAL catalog and re-typed another
-- source's openings. They are now steps of this transaction, after every
-- refusal above has been asked:
--
--   catalog  A mark with no window_types row gets a provisional one
--            (insert ... on conflict do nothing: window_types is GLOBAL and
--            this lock is per-project, so two jobs can race for mark "1").
--            An existing PROVISIONAL row has its blanks filled. A real
--            catalog product (provisional = false) is never touched — CHANGE
--            FROM MASTER, which filled a real product's blanks from whichever
--            job's CAD happened to name the same code.
--   link     Type ids land on live, unconfirmed, planned, non-field-added
--            openings whose mark the read names, ONLY when the row is this
--            document's, a legacy row with no source, or the other kind (a
--            plan callout of the same window). A type already on a row is
--            replaced only when it is null or a PROVISIONAL placeholder: a
--            real catalog product on a draft may be a person's pick, and
--            there is no column that says which, so it stays. Same rule for
--            the in-place re-read above. CHANGE FROM MASTER, which re-typed
--            any planned row; a wrongly matched product now needs a manual
--            fix rather than a re-read.
--   no-op    A read that adds and removes nothing still runs both, and each
--            writes only what differs, so re-reading the same file twice is
--            silent the second time.
--
-- The earlier draft's 7-argument signature is dropped first: with p_types
-- defaulted, both would match a 7-key call and PostgREST would refuse it as
-- ambiguous.
drop function if exists public.reconcile_planset_openings(uuid, uuid, jsonb, text[], uuid[], jsonb, boolean);

create or replace function public.reconcile_planset_openings(
  p_project_id uuid,
  p_planset_id uuid,
  p_snapshot jsonb,
  p_incoming_marks text[],
  p_delete_ids uuid[],
  p_inserts jsonb,
  p_specs_authoritative boolean default false,
  p_types jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_bad int;
  v_marks text[];
  v_delete uuid[] := coalesce(p_delete_ids, '{}'::uuid[]);
  v_inplace uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_list text;
  v_updated int := 0;
  v_inserted int := 0;
  v_deleted int := 0;
  v_linked int := 0;
  v_typed int := 0;
  v_t record;
  v_code text;
  v_type_id uuid;
  v_provisional boolean;
  -- mark_code (as the drafts carry it) -> catalog type id, for new rows
  v_type_by_mark jsonb := '{}'::jsonb;
  -- mark_base(mark) -> type id to LINK (a matched product wins), for links
  v_link_by_base jsonb := '{}'::jsonb;
  v_prev_marker text;
  v_test boolean := false;
begin
  perform public._planset_extraction_caller();

  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'array'
     or p_inserts is null or jsonb_typeof(p_inserts) <> 'array'
     or p_types is null or jsonb_typeof(p_types) <> 'array' then
    raise exception 'The plan-set save was incomplete. Nothing was changed; try again.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;

  -- One extraction commit per job at a time. Openings AND spec pages share
  -- this lock, so neither can interleave with the other's check-then-write.
  perform pg_advisory_xact_lock(
    hashtextextended('forge:planset-extraction:' || p_project_id::text, 0)
  );

  v_kind := public._planset_extraction_source(p_project_id, p_planset_id);

  -- Freeze every live opening on the job until commit. Field RPCs (assign,
  -- start, measure) and inserts that reference an opening wait here rather
  -- than slipping between the checks below and the writes after them.
  perform 1 from public.project_openings
   where project_id = p_project_id and removed_at is null
   for update;

  -- ---- stale snapshot ------------------------------------------------------
  with cur as (
    select o.* from public.project_openings o
     where o.project_id = p_project_id and o.removed_at is null
  ),
  snap as (
    select (e ->> 'id')::uuid as id, e
      from jsonb_array_elements(p_snapshot) e
  )
  select count(*) into v_bad
    from cur full join snap on snap.id = cur.id
   where cur.id is null or snap.id is null
      or cur.opening_code is distinct from (snap.e ->> 'opening_code')
      or cur.planset_id is distinct from (snap.e ->> 'planset_id')::uuid
      or coalesce(cur.confirmed, false) is distinct from coalesce((snap.e ->> 'confirmed')::boolean, false)
      or coalesce(cur.status, 'planned') is distinct from coalesce(snap.e ->> 'status', 'planned')
      or public._num_differs(cur.pin_x, (snap.e ->> 'pin_x')::numeric)
      or public._num_differs(cur.pin_y, (snap.e ->> 'pin_y')::numeric)
      or coalesce(cur.page_number, 1) is distinct from coalesce((snap.e ->> 'page_number')::int, 1)
      or cur.assigned_to is distinct from (snap.e ->> 'assigned_to')::uuid
      or cur.work_started_at is distinct from (snap.e ->> 'work_started_at')::timestamptz
      or public._num_differs(cur.ro_width_in, (snap.e ->> 'ro_width_in')::numeric)
      or public._num_differs(cur.ro_height_in, (snap.e ->> 'ro_height_in')::numeric)
      or coalesce(cur.ro_quick_ok, false) is distinct from coalesce((snap.e ->> 'ro_quick_ok')::boolean, false)
      or cur.condition is distinct from (snap.e ->> 'condition')
      or coalesce(cur.field_added, false) is distinct from coalesce((snap.e ->> 'field_added')::boolean, false);
  if v_bad > 0 then
    raise exception 'The windows on this job changed while the plan set was being read. Nothing was changed; read it again.'
      using errcode = 'P0001', hint = 'forge.planset.stale_snapshot';
  end if;

  -- ---- same-kind collision with another document ---------------------------
  select coalesce(array_agg(distinct m), '{}'::text[]) into v_marks
    from (
      select public.mark_base(x) as m
        from unnest(coalesce(p_incoming_marks, '{}'::text[])) x
       where nullif(trim(x), '') is not null
      union all
      select public.mark_base(e ->> 'opening_code')
        from jsonb_array_elements(p_inserts) e
       where nullif(trim(coalesce(e ->> 'opening_code', '')), '') is not null
    ) s;
  perform public._raise_planset_collision(
    public._planset_mark_collisions(p_project_id, p_planset_id, v_kind, v_marks, v_kind = 'specs')
  );

  -- ---- delete targets: this document's own drafts, or CAD wins -------------
  select string_agg(coalesce(o.opening_code, t.id::text), ', ') into v_list
    from unnest(v_delete) as t(id)
    left join public.project_openings o
      on o.id = t.id and o.project_id = p_project_id and o.removed_at is null
    left join public.project_plansets ps on ps.id = o.planset_id
   where o.id is null
      or not (
        -- a same-kind draft of THIS document, or a legacy row with no source
        ((case when ps.kind = 'specs' then 'specs' else 'building' end) = v_kind
          and (o.planset_id is null or o.planset_id = p_planset_id))
        or
        -- CAD wins: an authoritative specs read reclaims a building draft
        (v_kind = 'specs' and coalesce(p_specs_authoritative, false)
          and (case when ps.kind = 'specs' then 'specs' else 'building' end) = 'building'
          and public.mark_base(o.opening_code) = any (v_marks))
      );
  if v_list is not null then
    raise exception 'This read tried to remove windows that belong to another plan set (%). Nothing was changed.', v_list
      using errcode = 'P0001', hint = 'forge.planset.not_owned';
  end if;

  -- Protected: a person's record, never the extractor's guess. Mirrors
  -- hasFieldWork + isProtected in extract.ts, plus every referencing table.
  select string_agg(o.opening_code, ', ') into v_list
    from public.project_openings o
   where o.id = any (v_delete)
     and (
       coalesce(o.field_added, false)
       or coalesce(o.confirmed, false)
       or coalesce(o.status, 'planned') <> 'planned'
       or o.assigned_to is not null
       or o.work_started_at is not null
       or o.ro_width_in is not null
       or o.ro_height_in is not null
       or coalesce(o.ro_quick_ok, false)
       or (o.condition is not null and o.condition <> 'unknown')
       or o.id in (select public._openings_with_references(v_delete))
     );
  if v_list is not null then
    raise exception 'This read would remove windows that already have work or history on them (%). Nothing was changed.', v_list
      using errcode = 'P0001', hint = 'forge.planset.protected';
  end if;

  -- ---- inserts ---------------------------------------------------------------
  if exists (
    select 1 from jsonb_array_elements(p_inserts) e
     where nullif(trim(coalesce(e ->> 'opening_code', '')), '') is null
  ) or (
    select count(*) <> count(distinct e ->> 'opening_code')
      from jsonb_array_elements(p_inserts) e
  ) then
    raise exception 'The plan-set save was incomplete. Nothing was changed; try again.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;

  -- CAD wins on a plans read too: while a specs-kind opening survives, a
  -- building plan creates nothing (planDraftPersistence's specsOwnsJob).
  if v_kind = 'building'
     and jsonb_array_length(p_inserts) > 0
     and exists (
       select 1 from public.project_openings o
         join public.project_plansets ps on ps.id = o.planset_id
        where o.project_id = p_project_id and o.removed_at is null
          and ps.kind = 'specs' and not (o.id = any (v_delete))
     ) then
    raise exception 'The signed CAD set decides which windows exist on this job, so the building plan cannot add any. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;

  -- A code already live on the job, other than a draft this save replaces.
  select string_agg(distinct o.opening_code, ', ') into v_list
    from jsonb_array_elements(p_inserts) e
    join public.project_openings o
      on o.project_id = p_project_id and o.removed_at is null
     and o.opening_code = e ->> 'opening_code'
   where not (o.id = any (v_delete));
  if v_list is not null then
    raise exception 'These window codes are already on the job: %. Nothing was changed.', v_list
      using errcode = 'P0001', hint = 'forge.planset.code_conflict';
  end if;

  -- ---- catalog samples: only for marks this read names ----------------------
  -- Every sample's type_code must be its own mark upper-cased (so a payload
  -- cannot mint or fill an arbitrary global code), its mark must be one this
  -- read produced, each mark appears once, and a matched product must exist.
  if exists (
    select 1
      from jsonb_to_recordset(p_types)
           as t(mark_code text, type_code text, window_type_id uuid)
     where nullif(trim(coalesce(t.mark_code, '')), '') is null
        or t.type_code is distinct from upper(t.mark_code)
        or not (public.mark_base(t.mark_code) = any (v_marks))
        or (t.window_type_id is not null
            and not exists (select 1 from public.window_types w where w.id = t.window_type_id))
  ) or (
    select count(*) <> count(distinct e ->> 'mark_code') from jsonb_array_elements(p_types) e
  ) then
    raise exception 'The plan-set save was incomplete. Nothing was changed; try again.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;

  -- ---- write: catalog, in place, delete, insert, link -------------------------
  -- The marker is restored (not merely switched off) on the way out — see
  -- MARKERS in section 4b. An error rolls the whole transaction, marker
  -- included, back.
  v_prev_marker := current_setting('app.planset_extraction', true);
  perform set_config('app.planset_extraction', 'on', true);
  -- A test account reads plan sets only on the sandbox job, but window_types
  -- is GLOBAL: the sandbox cannot contain what it writes there. So a test
  -- account's read never creates or fills a catalog row; it links only to
  -- types that already exist.
  v_test := public.is_test_profile(auth.uid());

  for v_t in
    select *
      from jsonb_to_recordset(p_types) as t(
        mark_code text, type_code text, name text, category text,
        width_in numeric, height_in numeric, notes text, window_type_id uuid)
  loop
    v_code := v_t.type_code;
    v_type_id := null;
    -- Exact code first; a legacy row differing only in case second (the
    -- browser always matched case-insensitively), oldest wins so the answer
    -- is the same on every read.
    select w.id, coalesce(w.provisional, false) into v_type_id, v_provisional
      from public.window_types w
     where w.type_code = v_code;
    if v_type_id is null then
      select w.id, coalesce(w.provisional, false) into v_type_id, v_provisional
        from public.window_types w
       where upper(w.type_code) = v_code
       order by w.created_at nulls last, w.id
       limit 1;
    end if;

    if v_type_id is null and v_test then
      null;  -- see v_test above: no catalog row, so the mark stays untyped
             -- unless the read matched an existing product (below)
    elsif v_type_id is null then
      insert into public.window_types (
        type_code, name, category, width_in, height_in, notes, provisional
      ) values (
        v_code,
        coalesce(nullif(trim(v_t.name), ''), 'Mark #' || v_t.mark_code),
        v_t.category, v_t.width_in, v_t.height_in, v_t.notes,
        -- Not part of the closed catalog: flagged so it never masquerades as
        -- a real product in the brain (as ensureTypesFromSpecs always did).
        true
      )
      on conflict (type_code) do nothing
      returning id into v_type_id;
      if v_type_id is null then
        -- Another job's read created it first; use theirs.
        select w.id into v_type_id from public.window_types w where w.type_code = v_code;
      else
        v_typed := v_typed + 1;
      end if;
    elsif v_provisional and not v_test then
      -- Fill blanks only, and only on a provisional placeholder.
      update public.window_types w
         set width_in = coalesce(w.width_in, v_t.width_in),
             height_in = coalesce(w.height_in, v_t.height_in),
             category = coalesce(nullif(w.category, ''), v_t.category),
             notes = coalesce(nullif(w.notes, ''), v_t.notes)
       where w.id = v_type_id
         and ((w.width_in is null and v_t.width_in is not null)
           or (w.height_in is null and v_t.height_in is not null)
           or (nullif(w.category, '') is null and v_t.category is not null)
           or (nullif(w.notes, '') is null and v_t.notes is not null));
      if found then v_typed := v_typed + 1; end if;
    end if;

    v_type_by_mark := v_type_by_mark
      || jsonb_build_object(v_t.mark_code, v_type_id);
    v_link_by_base := v_link_by_base
      || jsonb_build_object(public.mark_base(v_t.mark_code), coalesce(v_t.window_type_id, v_type_id));
  end loop;

  -- Same document (or legacy), same kind, same code: keep the row and its id.
  -- Superseded building drafts (CAD wins) are never converted in place — the
  -- specs row they become is a different document's opening.
  select coalesce(array_agg(o.id), '{}'::uuid[]) into v_inplace
    from jsonb_array_elements(p_inserts) e
    join public.project_openings o
      on o.id = any (v_delete)
     and o.opening_code = e ->> 'opening_code'
     and (o.planset_id is null or o.planset_id = p_planset_id)
    left join public.project_plansets ps on ps.id = o.planset_id
   where (case when ps.kind = 'specs' then 'specs' else 'building' end) = v_kind;

  -- Computed first, then written only where something differs, so a re-read
  -- of an unchanged file touches no row (and fires no row trigger).
  with src as (
    select o.id,
           -- A draft with no resolved type never clears one; a type already
           -- on the row is replaced only when it is a provisional placeholder
           -- (CATALOG AND TYPE LINKS above) — a real product may be a
           -- person's pick.
           case
             when coalesce((e ->> 'window_type_id')::uuid,
                           (v_type_by_mark ->> (e ->> 'mark_code'))::uuid) is null
               then o.window_type_id
             when o.window_type_id is null
               or exists (select 1 from public.window_types w
                           where w.id = o.window_type_id and coalesce(w.provisional, false))
               then coalesce((e ->> 'window_type_id')::uuid,
                             (v_type_by_mark ->> (e ->> 'mark_code'))::uuid)
             else o.window_type_id
           end as new_type,
           e ->> 'label' as new_label,
           case when v_kind = 'specs' then 1
                else coalesce((e ->> 'page_number')::int, 1) end as new_page,
           case when v_kind = 'specs' then null else (e ->> 'pin_x')::numeric end as new_pin_x,
           case when v_kind = 'specs' then null else (e ->> 'pin_y')::numeric end as new_pin_y,
           case when v_kind = 'specs' then null else (e ->> 'origin_pin_x')::numeric end as new_opx,
           case when v_kind = 'specs' then null else (e ->> 'origin_pin_y')::numeric end as new_opy
      from jsonb_array_elements(p_inserts) e
      join public.project_openings o
        on o.id = any (v_inplace) and o.opening_code = e ->> 'opening_code'
  )
  update public.project_openings o
     set planset_id = p_planset_id,
         window_type_id = s.new_type,
         label = s.new_label,
         page_number = s.new_page,
         pin_x = s.new_pin_x,
         pin_y = s.new_pin_y,
         -- Write-once (seed_opening_origin_pin): only fills a blank origin.
         origin_pin_x = s.new_opx,
         origin_pin_y = s.new_opy,
         confirmed = false
    from src s
   where o.id = s.id
     and (o.planset_id is distinct from p_planset_id
       or o.window_type_id is distinct from s.new_type
       or o.label is distinct from s.new_label
       or o.page_number is distinct from s.new_page
       or public._num_differs(o.pin_x, s.new_pin_x)
       or public._num_differs(o.pin_y, s.new_pin_y)
       or (o.origin_pin_x is null and s.new_opx is not null)
       or coalesce(o.confirmed, false));
  get diagnostics v_updated = row_count;

  delete from public.project_openings
   where project_id = p_project_id
     and id = any (v_delete)
     and not (id = any (v_inplace));
  get diagnostics v_deleted = row_count;

  begin
    with ins as (
      insert into public.project_openings (
        project_id, planset_id, opening_code, window_type_id, label,
        page_number, pin_x, pin_y, origin_pin_x, origin_pin_y,
        origin_page_number, confirmed
      )
      select p_project_id, p_planset_id, e ->> 'opening_code',
             -- A matched product first, then the mark's own catalog type —
             -- the order ensureTypesFromSpecs gave (`d.window_type_id ??`).
             coalesce((e ->> 'window_type_id')::uuid,
                      (v_type_by_mark ->> (e ->> 'mark_code'))::uuid),
             e ->> 'label',
             case when v_kind = 'specs' then 1 else coalesce((e ->> 'page_number')::int, 1) end,
             case when v_kind = 'specs' then null else (e ->> 'pin_x')::numeric end,
             case when v_kind = 'specs' then null else (e ->> 'pin_y')::numeric end,
             case when v_kind = 'specs' then null else (e ->> 'origin_pin_x')::numeric end,
             case when v_kind = 'specs' then null else (e ->> 'origin_pin_y')::numeric end,
             case when v_kind = 'specs' then 1 else coalesce((e ->> 'page_number')::int, 1) end,
             false
        from jsonb_array_elements(p_inserts) e
       where not exists (
         select 1 from public.project_openings o
          where o.id = any (v_inplace) and o.opening_code = e ->> 'opening_code'
       )
      returning id
    )
    select coalesce(array_agg(id), '{}'::uuid[]), count(*)
      into v_new_ids, v_inserted
      from ins;
  exception when unique_violation then
    raise exception 'A window code in this read is already on the job. Nothing was changed; reload and try again.'
      using errcode = 'P0001', hint = 'forge.planset.code_conflict';
  end;

  -- ---- link: type the openings already on the job ----------------------------
  -- What linkSpecsToOpenings did, made source-safe. Rows this commit just
  -- wrote already carry their type and are not counted again.
  update public.project_openings o
     set window_type_id = (v_link_by_base ->> public.mark_base(o.opening_code))::uuid
   where o.project_id = p_project_id
     and o.removed_at is null
     and not coalesce(o.confirmed, false)
     and coalesce(o.status, 'planned') = 'planned'
     and not coalesce(o.field_added, false)
     and not (o.id = any (v_inplace))
     and not (o.id = any (v_new_ids))
     and v_link_by_base ? public.mark_base(o.opening_code)
     and (v_link_by_base ->> public.mark_base(o.opening_code)) is not null
     -- This document, a legacy row, or the OTHER kind — never a same-kind
     -- row of another document (the collision check refused those already;
     -- this says so again where the write happens).
     and (o.planset_id is null
          or o.planset_id = p_planset_id
          or coalesce((select case when ps.kind = 'specs' then 'specs' else 'building' end
                         from public.project_plansets ps where ps.id = o.planset_id),
                      'building') <> v_kind)
     and o.window_type_id is distinct from (v_link_by_base ->> public.mark_base(o.opening_code))::uuid
     and (o.window_type_id is null
          or exists (select 1 from public.window_types w
                      where w.id = o.window_type_id and coalesce(w.provisional, false)));
  get diagnostics v_linked = row_count;

  perform set_config('app.planset_extraction', coalesce(v_prev_marker, ''), true);

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'deleted', v_deleted,
    'linked', v_linked,
    'catalog_written', v_typed
  );
end;
$$;

comment on function public.reconcile_planset_openings(uuid, uuid, jsonb, text[], uuid[], jsonb, boolean, jsonb) is
  'Commit a planset read''s draft openings, catalog types and type links atomically under the per-project extraction lock. Refuses a stale snapshot, a same-kind mark owned by another document, a delete target that is not this document''s unprotected draft, and an inserted code already live. Re-reads update same-code drafts in place, keeping ids and pin history. Creates/fills only provisional catalog rows; links only this document''s, legacy and other-kind rows, never over a real catalog product. Foreman+, non-partner.';

revoke all on function public.reconcile_planset_openings(uuid, uuid, jsonb, text[], uuid[], jsonb, boolean, jsonb) from public, anon;
grant execute on function public.reconcile_planset_openings(uuid, uuid, jsonb, text[], uuid[], jsonb, boolean, jsonb) to authenticated;

-- ===========================================================================
-- 3. Mark specs: one page of a rich spec read, committed whole or not at all
-- ===========================================================================
--
-- Replaces the browser's collision read + drawing adoption + per-mark upsert.
-- Every rule that used to live in the browser is decided HERE, against rows
-- locked for this transaction, so there is no client snapshot to go stale:
--
--   * A mark whose spec row came from ANOTHER document refuses the whole
--     page (mark_collision), confirmed or not, text or picture.
--   * Confirmed rows, and rows a person wrote (source 'manual' — see
--     merge_mark_spec_extra: "a re-extract must not silently overwrite it" —
--     or 'field'), keep their text. They take a drawing only when they have
--     none at all, page + box + planset as one set (adoptableDrawingCoords).
--     CHANGE FROM MASTER: master's upsert overwrote unconfirmed 'manual' rows.
--   * extra.pane_grid already on file survives every re-read
--     (preservePaneGrid), confirmed or not.
--   * An unconfirmed row's drawing moves only when this read located one; a
--     page that found the mark's words but no box keeps the box on file.
--     CHANGE FROM MASTER: master's upsert wrote the draft's null over it.
--
-- Typing goes through jsonb_populate_record on the table's own row type, so
-- the function follows the table's column types (width_in became numeric in
-- 20260728140000) instead of restating them. Every column it names has been
-- on the table since 20260980000000, so the browser's drop-a-column retry is
-- not needed here: a database without this function refuses (update needed).
create or replace function public.commit_planset_mark_specs(
  p_project_id uuid,
  p_planset_id uuid,
  p_specs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_in jsonb;
  v_new public.project_mark_specs;
  v_old public.project_mark_specs;
  v_has_drawing boolean;
  v_saved int := 0;
  v_skipped int := 0;
  v_adopted int := 0;
  v_marks text[];
  v_prev_marker text;
begin
  perform public._planset_extraction_caller();

  if p_specs is null or jsonb_typeof(p_specs) <> 'array' then
    raise exception 'The spec save was incomplete. Nothing was changed; try again.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_specs) e
     where nullif(trim(coalesce(e ->> 'mark_code', '')), '') is null
        or coalesce(e ->> 'source', '') not in ('ai', 'deterministic')
  ) or (
    select count(*) <> count(distinct e ->> 'mark_code') from jsonb_array_elements(p_specs) e
  ) then
    raise exception 'The spec save was incomplete. Nothing was changed; try again.'
      using errcode = 'P0001', hint = 'forge.planset.invalid_plan';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('forge:planset-extraction:' || p_project_id::text, 0)
  );

  v_kind := public._planset_extraction_source(p_project_id, p_planset_id);

  perform 1 from public.project_mark_specs
   where project_id = p_project_id
   for update;

  select coalesce(array_agg(distinct e ->> 'mark_code'), '{}'::text[]) into v_marks
    from jsonb_array_elements(p_specs) e;
  perform public._raise_planset_collision(
    public._planset_mark_collisions(p_project_id, p_planset_id, v_kind, v_marks, true)
  );

  v_prev_marker := current_setting('app.planset_extraction', true);
  perform set_config('app.planset_extraction', 'on', true);

  for v_in in select e from jsonb_array_elements(p_specs) e loop
    v_new := jsonb_populate_record(null::public.project_mark_specs, v_in);
    v_has_drawing := v_new.image_page is not null and v_new.image_page >= 1
                     and v_new.image_bbox is not null
                     and jsonb_typeof(v_new.image_bbox) in ('object', 'array');

    select * into v_old
      from public.project_mark_specs s
     where s.project_id = p_project_id and s.mark_code = v_new.mark_code;

    if not found then
      insert into public.project_mark_specs (
        project_id, planset_id, mark_code, style, glass, color, size_code,
        width_in, height_in, operation, tempered, egress, u_factor, shgc,
        grids, screen, product_line, extra, image_page, image_bbox, source,
        unit_kind, door_kind, confirmed
      ) values (
        p_project_id, p_planset_id, v_new.mark_code, v_new.style, v_new.glass,
        v_new.color, v_new.size_code, v_new.width_in, v_new.height_in,
        v_new.operation, v_new.tempered, v_new.egress, v_new.u_factor,
        v_new.shgc, v_new.grids, v_new.screen, v_new.product_line,
        coalesce(v_new.extra, '{}'::jsonb),
        case when v_has_drawing then v_new.image_page end,
        case when v_has_drawing then v_new.image_bbox end,
        v_new.source, v_new.unit_kind, v_new.door_kind, false
      );
      v_saved := v_saved + 1;

    elsif v_old.planset_id is not null and v_old.planset_id <> p_planset_id then
      -- Unreachable after the collision check under this lock; kept so a
      -- later edit to that check cannot quietly turn into an overwrite.
      perform public._raise_planset_collision(jsonb_build_object(
        'marks', jsonb_build_array(v_old.mark_code),
        'planset_ids', jsonb_build_array(v_old.planset_id)));

    elsif coalesce(v_old.confirmed, false) or v_old.source in ('manual', 'field') then
      -- A person's words stay. A picture-less row may take this read's
      -- drawing, page + box + planset as one set.
      if v_has_drawing and v_old.image_page is null and v_old.image_bbox is null then
        update public.project_mark_specs
           set image_page = v_new.image_page,
               image_bbox = v_new.image_bbox,
               planset_id = p_planset_id
         where id = v_old.id;
        v_adopted := v_adopted + 1;
      end if;
      v_skipped := v_skipped + 1;

    else
      update public.project_mark_specs
         set planset_id = p_planset_id,
             style = v_new.style, glass = v_new.glass, color = v_new.color,
             size_code = v_new.size_code, width_in = v_new.width_in,
             height_in = v_new.height_in, operation = v_new.operation,
             tempered = v_new.tempered, egress = v_new.egress,
             u_factor = v_new.u_factor, shgc = v_new.shgc, grids = v_new.grids,
             screen = v_new.screen, product_line = v_new.product_line,
             extra = case
               when coalesce(v_old.extra -> 'pane_grid', 'null'::jsonb) <> 'null'::jsonb
                 then coalesce(v_new.extra, '{}'::jsonb)
                      || jsonb_build_object('pane_grid', v_old.extra -> 'pane_grid')
               else coalesce(v_new.extra, '{}'::jsonb)
             end,
             image_page = case when v_has_drawing then v_new.image_page else v_old.image_page end,
             image_bbox = case when v_has_drawing then v_new.image_bbox else v_old.image_bbox end,
             source = v_new.source,
             unit_kind = v_new.unit_kind,
             door_kind = v_new.door_kind
       where id = v_old.id;
      v_saved := v_saved + 1;
    end if;
  end loop;

  perform set_config('app.planset_extraction', coalesce(v_prev_marker, ''), true);

  return jsonb_build_object('saved', v_saved, 'skipped', v_skipped, 'adopted', v_adopted);
end;
$$;

comment on function public.commit_planset_mark_specs(uuid, uuid, jsonb) is
  'Commit one page of a rich spec read atomically under the per-project extraction lock. Refuses any mark whose spec row belongs to another plan set; never overwrites confirmed, manual or field text; keeps pane_grid; a protected row takes a drawing only when it has none. Foreman+, non-partner.';

revoke all on function public.commit_planset_mark_specs(uuid, uuid, jsonb) from public, anon;
grant execute on function public.commit_planset_mark_specs(uuid, uuid, jsonb) to authenticated;

-- ===========================================================================
-- 4. Old cached apps: refuse writes that go around the two functions
-- ===========================================================================
--
-- A PWA cached before this ships still runs the old saveDraftOpenings (DELETE
-- then INSERT, with the overlap guess that deleted PV 40's vinyl set) and the
-- old spec upsert. RLS cannot tell that phone from a manual edit, so these
-- gates key on what ONLY extraction writes, outside the marker:
--
--   project_openings
--     INSERT  a source-attributed DRAFT: planset_id set, confirmed false, not
--             field-added. A manual dot (addOpening, PlanModelEditor) is
--             confirmed = true; a field-added unit has no planset.
--     DELETE  a hard delete of a source-attributed row by a signed-in person
--             while the job is live. Removing a window is remove_opening (a
--             soft delete — an UPDATE); remove_field_unit deletes rows with no
--             planset; purge_project only runs on a job already in the trash.
--     UPDATE  planset_id moved onto a different document. Moving it to NULL
--             stays allowed: that is ON DELETE SET NULL from a planset.
--   project_mark_specs
--     INSERT  an extractor row (source ai/deterministic) carrying a planset.
--             An upsert fires BEFORE INSERT first, so the old upsert stops
--             here even where it would have become an update. Manual (Studio)
--             and field rows are untouched.
--     UPDATE  planset_id moved onto a document (old drawing adoption, the
--             ownership switch). Moving it to NULL — clearOrphanedDrawingCoords
--             and ON DELETE SET NULL — stays allowed. No manual edit path
--             writes planset_id.
--
--   window_types and project_openings.window_type_id
--     See section 4b (2026-10-05, third pass). The two updates the released
--     extractor makes BEFORE its delete/insert — the catalog gap-fill and the
--     type link — used to be indistinguishable from a person's catalog import
--     and type pick. Those person paths now go through validated functions,
--     so every other browser write of those columns is refused, and an old
--     app's FIRST extraction write fails before it has changed anything.
--
-- The old app then fails closed on what IS gated: a refused write stops its
-- chain, and because the old DELETE ran before its INSERT, the refusal lands
-- before anything is inserted. No JWT (migrations, the service key, pg_cron)
-- passes, as every guard on these tables already does.

create or replace function public.guard_planset_source_openings()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or coalesce(current_setting('app.planset_extraction', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.planset_id is not null
       and not coalesce(new.confirmed, false)
       and not coalesce(new.field_added, false) then
      raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then read the plan set again. Nothing was changed.'
        using errcode = 'P0001', hint = 'forge.planset.update_required';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Only a job already in the trash may lose source rows outside the
    -- marker (purge_project). Asked as "is it PROVABLY trashed", so a job row
    -- the caller cannot see refuses rather than waving the delete through.
    -- Legacy extracted drafts can have no planset_id. The old browser deletes
    -- those before inserting replacements; permitting that first delete would
    -- lose the drafts when the subsequent INSERT hits this gate. No current
    -- client hard-deletes a live opening for manual removal (that is an RPC).
    if (old.planset_id is not null or not coalesce(old.field_added, false))
       and not exists (select 1 from public.projects p
                        where p.id = old.project_id and p.deleted_at is not null) then
      raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then read the plan set again. Nothing was changed.'
        using errcode = 'P0001', hint = 'forge.planset.update_required';
    end if;
    return old;
  end if;

  -- UPDATE OF planset_id
  if new.planset_id is not null
     and new.planset_id is distinct from old.planset_id then
    raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then read the plan set again. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.planset.update_required';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_planset_source_openings on public.project_openings;
create trigger guard_planset_source_openings
  before insert or delete or update of planset_id on public.project_openings
  for each row execute function public.guard_planset_source_openings();

create or replace function public.guard_planset_source_mark_specs()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or coalesce(current_setting('app.planset_extraction', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.planset_id is not null and new.source in ('ai', 'deterministic') then
      raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then read the specs again. Nothing was changed.'
        using errcode = 'P0001', hint = 'forge.planset.update_required';
    end if;
    return new;
  end if;

  if new.planset_id is not null
     and new.planset_id is distinct from old.planset_id then
    raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then read the specs again. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.planset.update_required';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_planset_source_mark_specs on public.project_mark_specs;
create trigger guard_planset_source_mark_specs
  before insert or update of planset_id on public.project_mark_specs
  for each row execute function public.guard_planset_source_mark_specs();

revoke all on function public.guard_planset_source_openings() from public, anon, authenticated;
revoke all on function public.guard_planset_source_mark_specs() from public, anon, authenticated;

-- ===========================================================================
-- 4b. Catalog material and opening types: one door each
-- ===========================================================================
--
-- Section 4 left two old-browser writes open, and both happen BEFORE the old
-- app's delete/insert is refused:
--   (a) ensureTypesFromSpecs's gap-fill UPDATE of window_types
--       category / width_in / height_in / notes (the GLOBAL catalog);
--   (b) linkSpecsToOpenings's UPDATE of project_openings.window_type_id.
-- Neither was distinguishable from a person, because a person made the same
-- writes the same way: (a) through the catalog CSV import's direct upsert,
-- (b) through the review screen's direct type picker. So both people paths
-- move behind validated functions here, and then the tables can refuse
-- every other browser write of those columns.
--
-- MARKERS. Each function sets its own transaction-local marker, only AFTER
-- its validation, around only its own write, and RESTORES the previous value
-- (not 'off') before returning, so a caller that was already inside a marker
-- is not switched off early. set_config(..., true) changes roll back with the
-- transaction or the sub-transaction they were made in, so an error can
-- never leave one on. A browser cannot set one: set_config is in pg_catalog,
-- which PostgREST does not expose, and none of these functions takes a
-- marker (or anything that becomes one) as an argument.
--
--   app.planset_extraction   reconcile_planset_openings, commit_planset_mark_specs
--   app.opening_type_set     set_opening_type
--   app.catalog_import       import_window_types
--   app.window_assignment    assign_window_to_opening
--
-- Each gate names exactly the markers it accepts; a marker never opens a
-- table it was not made for. No JWT (migrations, pg_cron, edge functions on
-- the service key — synthesize-type-tips among them) passes every gate, as
-- every guard on these tables already does; the service key bypasses RLS and
-- is trusted the same way.
--
-- WHAT STAYS DIRECT, on purpose: window_types tips_json / watch_outs_json /
-- howto_json (TypeBrain knowledge edits, updateTypeKnowledge), name,
-- difficulty_rating, tutorial_url, required_capability, provisional and the
-- learning roll-ups; every project_openings column except window_type_id.
-- The old extractor never wrote any of those, so there is nothing to close.

-- ---- gate (a): window_types material columns, and new catalog rows --------
create or replace function public.guard_window_types_catalog_write()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_extraction boolean := coalesce(current_setting('app.planset_extraction', true), '') = 'on';
  v_import boolean := coalesce(current_setting('app.catalog_import', true), '') = 'on';
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- New catalog rows come from the import, or (provisional only) from a
    -- plan-set read. Nothing else in the app creates types; an old app's
    -- provisional insert and an old import's upsert both stop here. (An
    -- upsert fires BEFORE INSERT even for a row that already exists.)
    if v_import or (v_extraction and coalesce(new.provisional, false)) then
      return new;
    end if;
    raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then try again. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.catalog.update_required';
  end if;

  -- UPDATE OF category, width_in, height_in, notes — compared value by value,
  -- so an update that lists a column without changing it passes.
  if new.category is not distinct from old.category
     and new.width_in is not distinct from old.width_in
     and new.height_in is not distinct from old.height_in
     and new.notes is not distinct from old.notes then
    return new;
  end if;

  if v_import then
    return new;
  end if;

  -- The read may only fill BLANKS on a provisional placeholder — the rule
  -- reconcile_planset_openings follows, enforced again where the write lands.
  if v_extraction
     and coalesce(old.provisional, false)
     and (new.category is not distinct from old.category or nullif(old.category, '') is null)
     and (new.width_in is not distinct from old.width_in or old.width_in is null)
     and (new.height_in is not distinct from old.height_in or old.height_in is null)
     and (new.notes is not distinct from old.notes or nullif(old.notes, '') is null) then
    return new;
  end if;

  raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then try again. Nothing was changed.'
    using errcode = 'P0001', hint = 'forge.catalog.update_required';
end;
$$;

drop trigger if exists guard_planset_source_window_types on public.window_types;
drop function if exists public.guard_planset_source_window_types();
drop trigger if exists guard_window_types_catalog_write on public.window_types;
create trigger guard_window_types_catalog_write
  before insert or update of category, width_in, height_in, notes on public.window_types
  for each row execute function public.guard_window_types_catalog_write();

revoke all on function public.guard_window_types_catalog_write() from public, anon, authenticated;
comment on function public.guard_window_types_catalog_write() is
  'Refuses browser inserts into window_types, and browser changes to category/width_in/height_in/notes, unless import_window_types (app.catalog_import) or a plan-set read filling a provisional row''s blanks (app.planset_extraction) is making them. TypeBrain knowledge and other columns stay directly editable.';

-- ---- gate (b): project_openings.window_type_id --------------------------------
-- Every ACTUAL change, whatever the row's status: the old linker filtered on
-- a stale read, so it could land on a row assigned or confirmed since.
create or replace function public.guard_opening_type_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.window_type_id is not distinct from old.window_type_id then
    return new;
  end if;
  if auth.uid() is null
     or coalesce(current_setting('app.planset_extraction', true), '') = 'on'
     or coalesce(current_setting('app.opening_type_set', true), '') = 'on'
     or coalesce(current_setting('app.window_assignment', true), '') = 'on' then
    return new;
  end if;
  raise exception 'This phone is running an older version of Forge. Close and reopen the app to update it, then try again. Nothing was changed.'
    using errcode = 'P0001', hint = 'forge.opening_type.update_required';
end;
$$;

drop trigger if exists guard_opening_type_change on public.project_openings;
create trigger guard_opening_type_change
  before update of window_type_id on public.project_openings
  for each row execute function public.guard_opening_type_change();

revoke all on function public.guard_opening_type_change() from public, anon, authenticated;
comment on function public.guard_opening_type_change() is
  'Refuses a browser change to project_openings.window_type_id unless set_opening_type, assign_window_to_opening or a plan-set read is making it.';

-- ---- the person's door for (b): set_opening_type ------------------------------
--
-- The review screen's type picker. SECURITY DEFINER so the checks below — not
-- the caller's RLS — decide, and so it can read windows/profiles whatever the
-- caller sees; every check RLS would have made is made here explicitly.
--
-- Refusals (HINT; the MESSAGE is the crew's sentence):
--   forge.opening_type.auth          signed out / removed / partner / below foreman
--   forge.opening_type.not_found     no such opening, hidden, or job not visible / in the trash
--   forge.opening_type.installed     the unit is installed — its type is history now
--   forge.opening_type.stale         the type changed since the screen showed it
--   forge.opening_type.unknown_type  no such catalog type
--   forge.opening_type.unit_mismatch a physical unit of another type is assigned
create or replace function public.set_opening_type(
  p_opening_id uuid,
  p_window_type_id uuid,
  p_expected_type_id uuid
)
returns public.project_openings
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.project_openings;
  v_unit_type uuid;
  v_prev_marker text;
begin
  if v_uid is null then
    raise exception 'Sign in again before changing a window''s type.'
      using errcode = '42501', hint = 'forge.opening_type.auth';
  end if;
  if public.is_partner_user()
     or not exists (select 1 from public.profiles p
                     where p.id = v_uid and p.retired_at is null and p.access_revoked_at is null)
     or not public.is_foreman_plus(v_uid) then
    raise exception 'Only a foreman or above can change a window''s type.'
      using errcode = '42501', hint = 'forge.opening_type.auth';
  end if;

  select * into v_row from public.project_openings
   where id = p_opening_id
   for update;
  if not found or v_row.removed_at is not null
     or not public._ai_job_visible(v_row.project_id, v_uid) then
    raise exception 'That window is not on this job any more. Reload the page and try again.'
      using errcode = 'P0001', hint = 'forge.opening_type.not_found';
  end if;
  if v_row.status = 'installed' then
    raise exception 'This window is already installed, so its type can''t be changed here.'
      using errcode = 'P0001', hint = 'forge.opening_type.installed';
  end if;
  if v_row.window_type_id is distinct from p_expected_type_id then
    raise exception 'Someone changed this window''s type while you were looking. Reload to see the current type, then choose again.'
      using errcode = 'P0001', hint = 'forge.opening_type.stale';
  end if;
  if p_window_type_id is not distinct from v_row.window_type_id then
    return v_row;  -- nothing to change
  end if;
  if p_window_type_id is not null
     and not exists (select 1 from public.window_types w where w.id = p_window_type_id) then
    raise exception 'That window type is no longer in the catalog. Reload and choose again.'
      using errcode = 'P0001', hint = 'forge.opening_type.unknown_type';
  end if;
  if v_row.assigned_window_id is not null then
    select w.window_type_id into v_unit_type
      from public.windows w where w.id = v_row.assigned_window_id;
    -- Clearing the type counts too: the assigned unit's type would then be
    -- the only record of what goes here, and the next assignment would not
    -- be checked against anything.
    if p_window_type_id is null or v_unit_type is distinct from p_window_type_id then
      raise exception 'A unit from the warehouse is already assigned to this window, and it is a different type. Unassign it first, then change the type.'
        using errcode = 'P0001', hint = 'forge.opening_type.unit_mismatch';
    end if;
  end if;

  v_prev_marker := current_setting('app.opening_type_set', true);
  perform set_config('app.opening_type_set', 'on', true);
  update public.project_openings
     set window_type_id = p_window_type_id
   where id = p_opening_id
  returning * into v_row;
  perform set_config('app.opening_type_set', coalesce(v_prev_marker, ''), true);

  return v_row;
end;
$$;

revoke all on function public.set_opening_type(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_opening_type(uuid, uuid, uuid) to authenticated;
comment on function public.set_opening_type(uuid, uuid, uuid) is
  'The review screen''s type picker: foreman+, non-partner, job-visible; refuses a stale expected type, an installed or hidden opening, an unknown type and a mismatched assigned unit. The only browser path that changes project_openings.window_type_id.';

-- ---- the person's door for (a): import_window_types -------------------------
--
-- The catalog CSV import (/catalog, foreman+ in the app). Same upsert as the
-- browser made — on type_code, overwriting exactly name, category, width_in,
-- height_in, difficulty_rating, tutorial_url and notes (absent = null, as the
-- browser always sent all eight) — so ids, provisional flags, required
-- capability, TypeBrain knowledge and learning roll-ups are untouched.
--
-- TEST ACCOUNTS ARE REFUSED. The catalog is global: unlike a job, there is no
-- sandbox copy of it, so an import from the test account would change the
-- real catalog every crew member reads. (Before this, any signed-in
-- non-partner could write window_types directly under RLS; this narrows it.)
create or replace function public.import_window_types(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_inserted int := 0;
  v_total int := 0;
  v_prev_marker text;
  v_allowed constant text[] := array['type_code', 'name', 'category', 'width_in',
    'height_in', 'difficulty_rating', 'tutorial_url', 'notes'];
begin
  if v_uid is null then
    raise exception 'Sign in again before importing the catalog.'
      using errcode = '42501', hint = 'forge.catalog.auth';
  end if;
  if public.is_partner_user()
     or not exists (select 1 from public.profiles p
                     where p.id = v_uid and p.retired_at is null and p.access_revoked_at is null)
     or not public.is_foreman_plus(v_uid) then
    raise exception 'Only a foreman or above can import the window catalog.'
      using errcode = '42501', hint = 'forge.catalog.auth';
  end if;
  if public.is_test_profile(v_uid) then
    raise exception 'Test accounts can''t import the catalog — it is shared by every job, so there is no practice copy of it.'
      using errcode = '42501', hint = 'forge.catalog.test_account';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 5000
     or exists (
       select 1 from jsonb_array_elements(p_rows) e
        where jsonb_typeof(e) <> 'object'
           or exists (select 1 from jsonb_object_keys(e) k where not (k = any (v_allowed)))
           or nullif(trim(coalesce(e ->> 'type_code', '')), '') is null
           or nullif(trim(coalesce(e ->> 'name', '')), '') is null)
     or (select count(*) <> count(distinct e ->> 'type_code') from jsonb_array_elements(p_rows) e) then
    raise exception 'That catalog file could not be imported: every row needs a type code and a name, each code once. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.catalog.invalid';
  end if;

  -- One import at a time; a plan-set read racing for the same code is
  -- handled by its own on-conflict.
  perform pg_advisory_xact_lock(hashtextextended('forge:catalog-import', 0));

  v_prev_marker := current_setting('app.catalog_import', true);
  perform set_config('app.catalog_import', 'on', true);
  begin
    with up as (
      insert into public.window_types (
        type_code, name, category, width_in, height_in,
        difficulty_rating, tutorial_url, notes
      )
      select r.type_code, r.name, r.category, r.width_in, r.height_in,
             r.difficulty_rating, r.tutorial_url, r.notes
        from jsonb_to_recordset(p_rows) as r(
          type_code text, name text, category text, width_in numeric,
          height_in numeric, difficulty_rating int, tutorial_url text, notes text)
      on conflict (type_code) do update
        set name = excluded.name,
            category = excluded.category,
            width_in = excluded.width_in,
            height_in = excluded.height_in,
            difficulty_rating = excluded.difficulty_rating,
            tutorial_url = excluded.tutorial_url,
            notes = excluded.notes
      returning (xmax = 0) as was_inserted
    )
    select count(*) filter (where was_inserted), count(*)
      into v_inserted, v_total
      from up;
  exception when check_violation or invalid_text_representation
                 or numeric_value_out_of_range then
    raise exception 'That catalog file could not be imported: a size or difficulty value is not valid. Nothing was changed.'
      using errcode = 'P0001', hint = 'forge.catalog.invalid';
  end;
  perform set_config('app.catalog_import', coalesce(v_prev_marker, ''), true);

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_total - v_inserted,
    'total', v_total
  );
end;
$$;

revoke all on function public.import_window_types(jsonb) from public, anon;
grant execute on function public.import_window_types(jsonb) to authenticated;
comment on function public.import_window_types(jsonb) is
  'Catalog CSV import: foreman+, non-partner, not a test account; strict eight-column whitelist; upsert on type_code preserving ids and every column it does not name. The only browser path that creates window_types or changes their category/size/notes.';

-- ---- inventory assignment: assign_window_to_opening ----------------------------
--
-- Recreated with its CURRENT signature and body (20260715200000_lifecycle_
-- unify.sql) so gate (b) lets its one type write through. Unchanged: SECURITY
-- INVOKER, so the caller's RLS still governs every read and write exactly as
-- before (any signed-in non-partner, the warehouse's own path); the type is
-- still only ever FILLED from the assigned unit when the opening had none.
-- Changed: the marker around that update, a pinned search_path, and EXECUTE
-- made explicit — revoked from PUBLIC/anon (anon could already reach nothing:
-- every policy on these tables is `to authenticated`), granted to
-- authenticated and service_role. Same signature, so no overload is added.
create or replace function public.assign_window_to_opening(
  p_opening_id uuid,
  p_window_id uuid,
  p_actor text default null
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
  v_window windows;
  v_prev_marker text;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  if v_opening.status = 'installed' then
    raise exception 'opening % is already installed', v_opening.opening_code;
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;
  if v_window.status = 'installed' then
    raise exception '% is already installed', v_window.window_id;
  end if;
  if v_opening.window_type_id is not null
     and v_window.window_type_id <> v_opening.window_type_id then
    raise exception 'type mismatch: % is not the type planned for opening %',
      v_window.window_id, v_opening.opening_code;
  end if;

  update windows
  set project_id = v_opening.project_id
  where id = v_window.id
    and (project_id is distinct from v_opening.project_id);

  -- Validated above; the marker covers only this statement.
  v_prev_marker := current_setting('app.window_assignment', true);
  perform set_config('app.window_assignment', 'on', true);
  update project_openings
  set assigned_window_id = v_window.id,
      window_type_id = coalesce(window_type_id, v_window.window_type_id),
      status = 'assigned'
  where id = p_opening_id
  returning * into v_opening;
  perform set_config('app.window_assignment', coalesce(v_prev_marker, ''), true);

  insert into movements (window_id, event, project_id, actor, reason)
  values (
    v_window.id,
    'assigned',
    v_opening.project_id,
    p_actor,
    'assigned to opening ' || v_opening.opening_code
  );

  return v_opening;
end;
$$;

revoke all on function public.assign_window_to_opening(uuid, uuid, text) from public, anon;
grant execute on function public.assign_window_to_opening(uuid, uuid, text) to authenticated, service_role;

comment on function public.guard_planset_source_openings() is
  'Refuses source-attributed draft inserts, hard deletes of source-attributed rows on a live job, and planset_id moves onto a document, unless reconcile_planset_openings set app.planset_extraction for its own transaction. Stops cached old apps writing around the atomic commit.';
comment on function public.guard_planset_source_mark_specs() is
  'Refuses extractor spec rows carrying a planset, and planset_id moves onto a document, unless commit_planset_mark_specs set app.planset_extraction for its own transaction.';

-- ===========================================================================
-- 5. Proving it — db-dry-run probe and two-session test plan
-- ===========================================================================
--
-- Probe (scripts/dry-run-probes/, from TEMPLATE.sql, on dry_run_sandbox_job(),
-- ending with the forced error so nothing is kept). As a foreman JWT:
--   a. create specs plansets A and B on the sandbox job;
--   b. reconcile A with marks 1,2,3 (snapshot = current rows): 3 inserted;
--   c. reconcile B with marks 1,9: hint forge.planset.mark_collision, detail
--      marks ["1"]; A's three rows byte-identical afterwards;
--   d. reconcile A again with 1,2,4 (delete ids = A's 1,2,3; fresh snapshot):
--      rows 1 and 2 keep their ids (updated 2), 3 deleted, 4 inserted;
--   e. reconcile A with a snapshot missing one row: stale_snapshot;
--   f. add an opening_notes row on A's row 2, reconcile deleting it:
--      protected (proves the catalog reference sweep, not just the hand list);
--   g. commit_planset_mark_specs(B, mark 1): mark_collision; (A, mark 1 with a
--      new box on a confirmed picture-less row): adopted 1, text unchanged;
--   h. REST-shaped writes under the same JWT: insert {planset_id A,
--      confirmed false}: update_required; delete A's row: update_required;
--      insert {planset_id A, confirmed true} (a manual dot): succeeds;
--      update spec planset_id A -> null: succeeds; null -> A: update_required.
--   i. catalog + links, inside the commit:
--      - reconcile B (marks 1,9) after A owns 1: mark_collision, AND no
--        window_types row for code "9" exists afterwards (the refused read
--        minted nothing) and A's rows' window_type_id are unchanged;
--      - reconcile A with a new mark "Z7" (no catalog row): one provisional
--        row "Z7" created; its openings carry it;
--      - a provisional row with null width: filled; a REAL product
--        (provisional false) with null width and the same code: untouched;
--      - a building draft of plan P carrying provisional "4A": an
--        authoritative-or-not specs read of A with mark 4A matched to a real
--        product re-types it (other kind, placeholder); the same draft after
--        a manual pick of a real product: left alone; a confirmed one, a
--        field-added one, a same-kind row of B: left alone;
--      - re-read A unchanged twice: second call returns updated 0,
--        inserted 0, deleted 0, linked 0, catalog_written 0;
--      - REST insert into window_types {provisional true}: update_required;
--        {provisional false} (catalog import shape): succeeds.
--   j. old-client gates (section 4b), REST-shaped as a FOREMAN JWT:
--      - PATCH window_types {width_in} on a row whose width is null:
--        forge.catalog.update_required; PATCH the same row {tips_json}:
--        succeeds (TypeBrain); PATCH {category: <same value>}: succeeds;
--      - POST window_types {provisional false}: forge.catalog.update_required;
--      - PATCH project_openings {window_type_id} on a planned draft AND on an
--        assigned/confirmed row: forge.opening_type.update_required both;
--        PATCH {label} on the same row: succeeds.
--   k. set_opening_type as a foreman: (row, T2, <current>) succeeds and the
--      row reads T2; (row, T3, <old type>) -> stale; on an installed row ->
--      installed; with an assigned unit of type T1, (row, T2, T1) ->
--      unit_mismatch and (row, null, T1) -> unit_mismatch; as an installer,
--      a partner, and a revoked profile -> auth; a hidden row -> not_found.
--   l. import_window_types as a foreman: two rows (one new code, one existing
--      code with tips_json set) -> {inserted 1, updated 1, total 2}; the
--      existing row keeps its id, tips_json, provisional and
--      required_capability; a row with an extra key ("provisional") ->
--      forge.catalog.invalid, nothing written; as an installer -> auth; as
--      the test foreman (is_test) -> forge.catalog.test_account.
--   m. assign_window_to_opening on an untyped opening: succeeds and fills
--      the type from the unit (gate b passes under app.window_assignment);
--      on a typed opening with a mismatched unit: the original exception.
--   n. markers do not leak: inside one transaction call set_opening_type,
--      then (same transaction) a plain UPDATE of window_type_id ->
--      forge.opening_type.update_required; current_setting('app.opening_type_set',
--      true) after the call is its prior value ('' or null), not 'on'.
--   o. reconcile_planset_openings as the test foreman on the sandbox job with
--      a new mark: openings inserted, NO window_types row created.
--   As an installer JWT and as a partner JWT: both RPCs refuse forge.planset.auth.
--   Also purge_project on a trashed copy of the job: still succeeds.
--
-- Two-session concurrency (two psql connections, each with
-- set_config('request.jwt.claims', '<foreman claims>', true)):
--   S1: begin; select reconcile_planset_openings(job, A, ...);   -- holds lock
--   S2: begin; select reconcile_planset_openings(job, B, ...);   -- BLOCKS on
--       pg_advisory_xact_lock
--   S1: commit;
--   S2: unblocks, re-reads under the lock and refuses stale_snapshot (its
--       snapshot predates S1's rows) or mark_collision — never a partial write.
--   Repeat with S2 = commit_planset_mark_specs (same lock), and with S2 = an
--   installer's start_opening_work on a row S1 deletes: S2 blocks on S1's row
--   lock; after S1 commits the row is gone and S2 fails cleanly. If S2 goes
--   first, S1 blocks on the row, then refuses stale_snapshot (work_started_at
--   changed) instead of deleting worked-on data.
--   Type-pick race: S1 and S2 both read a row with type T1. S1:
--   set_opening_type(row, T2, T1) holds the row lock; S2:
--   set_opening_type(row, T3, T1) blocks; S1 commits; S2 re-reads T2 and
--   refuses forge.opening_type.stale. With S2 = a reconcile that would link
--   that row: it blocks on the row lock; window_type_id is not part of the
--   snapshot comparison, so it does not refuse — its link step re-reads the
--   row under the lock, sees S1's real (non-provisional) type, and leaves it.
--   If S1 picked a PROVISIONAL type, the link may replace it: provisional
--   placeholders are the extractor's to manage (accepted, see risks).
