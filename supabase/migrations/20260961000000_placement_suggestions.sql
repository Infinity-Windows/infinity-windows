-- Vision placement (wave V-A): the plans place their own windows.
--
-- Before this, a schedule read told the app a mark EXISTS ("#12, QTY 2") and a
-- floor-plan read told it nothing about where #12 actually sits — a human had
-- to drag every pin by hand on the map, or trace every dot by hand on the 3D
-- model. Nothing in between ever looked at the plan page itself and read off a
-- position. This migration adds the storage for that reading, and nothing else:
-- a machine guess is never a placement until a foreman looks at it.
--
-- suggested_pin_x / suggested_pin_y / suggested_page_number are exact twins of
-- the real pin_x / pin_y / page_number columns (20260715120000, seeded further
-- by 20260730130000's origin_pin_x) — same normalized-0..1 shape, same meaning,
-- deliberately a SEPARATE set of columns rather than writing the real ones
-- directly. The real columns are what ProjectMap's placePin drag writes and
-- what adapter.ts's buildFitViewJob reads to place a window on the live 3D map
-- (fitview/adapter.ts) — a suggestion is not a placement, and the live map must
-- never be able to confuse the two by accident. suggested_at / suggested_confidence
-- ride along so the review tray can show "34 min ago, 82% sure" rather than a
-- bare dot.
--
-- RESCAN LAW (receipts precedent, 20260957000000's apply_receipt_extraction):
-- re-running Find placements must never clobber a mark a human has already
-- placed. Unlike receipts' fill-missing-only merge (several independent
-- fields, each locked the moment it is non-null), placement has exactly one
-- signal that means "a human has settled this": the mark's REAL pin_x is no
-- longer null. So the write below is a single atomic UPDATE guarded by
-- `pin_x is null` — a mark with a real pin, however it got one (this flow's
-- Confirm, or a plain drag on the map), is untouched by every future rescan.
-- A DISMISSED suggestion (suggested_pin_x cleared, pin_x still null) is fair
-- game for the next rescan to suggest again — dismiss means "not now", not
-- "never".

alter table project_openings
  add column if not exists suggested_pin_x numeric
    check (suggested_pin_x is null or (suggested_pin_x >= 0 and suggested_pin_x <= 1)),
  add column if not exists suggested_pin_y numeric
    check (suggested_pin_y is null or (suggested_pin_y >= 0 and suggested_pin_y <= 1)),
  add column if not exists suggested_page_number integer,
  add column if not exists suggested_at timestamptz,
  add column if not exists suggested_confidence numeric
    check (suggested_confidence is null or (suggested_confidence >= 0 and suggested_confidence <= 1));

comment on column project_openings.suggested_pin_x is
  'Vision-placement''s guess at this mark''s normalized x on suggested_page_number. Never read by the live map (adapter.ts reads pin_x only) — a foreman confirming it in the trace tool is what promotes it to a real pin_x. Cleared (not overwritten) once pin_x is set.';
comment on column project_openings.suggested_pin_y is
  'Companion to suggested_pin_x. See that column''s comment.';
comment on column project_openings.suggested_page_number is
  'Which planset page suggested_pin_x/y are normalized against — the floor-plan page the vision read found this mark''s callout on.';
comment on column project_openings.suggested_at is
  'When Find placements last wrote this suggestion. Null once confirmed or dismissed.';
comment on column project_openings.suggested_confidence is
  'The vision read''s own 0..1 confidence in this callout match, shown on the suggested dot so a foreman can tell a plain guess from a firm one.';

-- ------------------------------------------------------- apply_placement_suggestions
-- The machine-write path, called by the client right after extract-placement
-- returns a raw reading — same shape as apply_receipt_extraction: never called
-- with a human-typed value (Confirm/dismiss in the trace tool write pin_x /
-- suggested_pin_x directly, through the ordinary project_openings update path
-- that guard_opening_pin_move already gates foreman+ for real pins). This
-- function's whole job is THE LAW above: skip any opening that already has a
-- real pin. Done as one statement per call rather than a client
-- read-then-write loop, for the same race reason receipts gives — a foreman
-- could be confirming dot #7 in one tab the instant a rerun of Find placements
-- lands in another.
create or replace function public.apply_placement_suggestions(
  p_project_id uuid,
  p_suggestions jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_applied int := 0;
begin
  if public.my_role_rank() < 1 then
    raise exception 'Only a foreman or above can place windows on the plan.'
      using errcode = '42501';
  end if;

  with incoming as (
    select
      (rec ->> 'opening_id')::uuid as opening_id,
      (rec ->> 'x')::numeric as x,
      (rec ->> 'y')::numeric as y,
      (rec ->> 'page')::int as page,
      nullif(rec ->> 'confidence', '')::numeric as confidence
    from jsonb_array_elements(coalesce(p_suggestions, '[]'::jsonb)) as rec
  )
  update project_openings o
  set suggested_pin_x = i.x,
      suggested_pin_y = i.y,
      suggested_page_number = i.page,
      suggested_at = now(),
      suggested_confidence = i.confidence
  from incoming i
  where o.id = i.opening_id
    and o.project_id = p_project_id
    and o.pin_x is null; -- THE LAW: a mark with a real pin is never touched

  get diagnostics v_applied = row_count;
  return v_applied;
end;
$$;

comment on function public.apply_placement_suggestions(uuid, jsonb) is
  'Writes Find placements'' raw reading into suggested_pin_x/y/page/at/confidence, skipping any opening that already has a real pin_x (rescan-never-overwrites-confirmed, the receipts precedent). Foreman+ only. Returns how many rows it actually applied.';

revoke all on function public.apply_placement_suggestions(uuid, jsonb) from public, anon;
grant execute on function public.apply_placement_suggestions(uuid, jsonb) to authenticated;
