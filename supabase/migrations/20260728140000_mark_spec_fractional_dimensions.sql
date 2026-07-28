-- Let a mark's spec carry a half-inch: project_mark_specs.width_in / height_in
-- become numeric, matching window_types.width_in / height_in and
-- project_openings.ro_width_in / ro_height_in.
--
-- WHY THE COLUMN WAS WRONG
-- 20260724000000_mark_specs.sql declared these `int` because, at the time, the
-- only source of a dimension was `decodeSizeCode` — a 4-digit call size read as
-- feet+inches ("3060" → 36 × 72). That decode can only ever produce whole
-- inches, so an integer column looked like a faithful description of the data
-- and went unnoticed on the one job we had.
--
-- It stopped being true the moment a dimension could come from the sheet
-- instead of the code. Shop drawings are dimensioned to the fraction the unit
-- is actually built to — `901(35 1/2")`, `2273(89 1/2")` — and the printed
-- dimension now WINS over a decode it disagrees with (20260728, printedSize).
-- The first supplier whose sheets print genuine half-inches therefore fed 89.5
-- into an int4 column and Postgres refused the whole row:
--   invalid input syntax for type integer: "89.5"  [22P02]
-- Not a rounded size on a spec card — NO spec rows at all for those pages, and
-- installers looking at blank spec cards for every opening of those marks.
--
-- Every real dimension a window or door can have is a fraction, so the column,
-- not the value, was the thing that was wrong.
--
-- SAFETY
-- integer → numeric is a WIDENING: every int4 value is exactly representable as
-- numeric, so the existing whole-inch rows (Smith Residence's 36, 72, 32, 54, …)
-- come through unchanged and no value is rounded, truncated, or lost. Postgres
-- casts int4 → numeric implicitly, so no USING clause is needed. No unscaled
-- numeric limit applies either — we deliberately do NOT pin numeric(p,s),
-- because a fixed scale would just re-create this bug at a finer fraction.
--
-- Nothing depends on these columns (no view, no generated column, no function
-- signature — only `set_opening_rough_opening`, which is project_openings), so
-- the ALTER cannot cascade. It takes a brief ACCESS EXCLUSIVE lock and rewrites
-- the table, which at this table's size (tens of rows per project) is instant.
--
-- Idempotent: guarded on the current type, so re-running is a no-op.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_mark_specs'
      and column_name = 'width_in'
      and data_type <> 'numeric'
  ) then
    alter table project_mark_specs alter column width_in type numeric;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_mark_specs'
      and column_name = 'height_in'
      and data_type <> 'numeric'
  ) then
    alter table project_mark_specs alter column height_in type numeric;
  end if;
end;
$$;

comment on column project_mark_specs.width_in is
  'Width in inches. Numeric, not integer: a real window is dimensioned to the '
  'fraction it is built to (35.5"), and the dimension printed on the shop '
  'drawing overrides the whole-inch call-size decode when the two disagree.';

comment on column project_mark_specs.height_in is
  'Height in inches. Numeric for the same reason as width_in — half-inch and '
  'eighth-inch dimensions are normal on a shop drawing.';
