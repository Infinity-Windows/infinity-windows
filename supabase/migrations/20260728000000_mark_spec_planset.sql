-- WHICH specs planset a mark's elevation drawing was located on.
--
-- 20260727000000_mark_spec_drawings.sql stores where a mark's "Outside View"
-- drawing sits: image_page (1-based page) + image_bbox (normalized box on that
-- page). Both are only meaningful against ONE SPECIFIC file. If someone
-- re-uploads or replaces the specs planset and the page order changes — a cover
-- sheet added, sheets reordered, a revision issued — every saved box silently
-- points at the wrong drawing. The crop still renders, still looks like a
-- window, and is simply the wrong unit. That's the worst kind of wrong: an
-- installer has no way to tell.
--
-- Remembering the planset the coordinates came from makes that detectable:
--   planset_id — the project_plansets row the page/box were read from.
-- The client compares it against the project's CURRENT specs planset and hides
-- a crop it can't vouch for (the spec TEXT still shows — losing a picture is
-- fine, showing the wrong picture is not).
--
-- `on delete set null` deliberately: if the planset row is deleted the drawing
-- becomes unverifiable, not the whole spec row. A NULL planset_id means
-- "unknown provenance", which is also what every row written before this
-- migration has — including the live Smith / PV Townhomes data — so the client
-- treats NULL as legacy-and-shown rather than stale-and-hidden. Hiding those
-- would delete working drawings from a job that's mid-install.
--
-- Additive + idempotent, and RLS is inherited unchanged from the table created
-- in 20260724000000_mark_specs.sql: read for any authenticated field role,
-- write for foreman+. The app degrades gracefully until this is applied (the
-- spec writer retries the insert without this column).

alter table if exists public.project_mark_specs
  add column if not exists planset_id uuid
    references public.project_plansets(id) on delete set null;

-- Lookups are "the drawings belonging to this planset" (staleness checks and
-- clearing coords when a planset is replaced), so index the column itself.
create index if not exists project_mark_specs_planset_idx
  on public.project_mark_specs (planset_id);

comment on column public.project_mark_specs.planset_id is
  'Specs planset that image_page/image_bbox were read from. NULL = unknown/legacy provenance (pre-dates this column); the app shows those drawings but hides ones whose planset is no longer the project''s current specs planset.';
