-- Where each mark's ELEVATION DRAWING lives on the specs planset.
--
-- Installers already see a mark's spec TEXT (style, glass, color, size,
-- operation). They also want the picture — the "Outside View" elevation the
-- manufacturer drew for that mark. Rather than copy pixels into storage, we
-- remember WHERE the drawing is on the specs planset the project already has,
-- and the app crops that region out of the rendered page on demand (and
-- inverts it to white-on-black so it reads on the dark install sheet).
--
-- Two columns are enough to locate it:
--   image_page — 1-based page of the SPECS planset the drawing is on.
--   image_bbox — normalized [x0,y0,x1,y1] (0..1, origin top-left) of the
--                drawing within that fully rendered page. Resolution
--                independent, so the same box works for a thumbnail and for
--                the full-screen zoom.
--
-- The box comes from the same Claude VISION pass that transcribes the spec
-- table, is validated client-side (4 finite numbers, in range, positive area,
-- sane size) and is simply null when the model didn't give a usable one — the
-- spec card then shows text only.
--
-- Additive + idempotent, and RLS is inherited unchanged from the table created
-- in 20260724000000_mark_specs.sql: read for any authenticated field role,
-- write for foreman+. The app degrades gracefully until this is applied (the
-- spec writer retries without these columns, and drawings stay hidden).

alter table if exists public.project_mark_specs
  add column if not exists image_page integer,
  add column if not exists image_bbox jsonb;

comment on column public.project_mark_specs.image_page is
  '1-based page of the specs planset holding this mark''s elevation drawing.';
comment on column public.project_mark_specs.image_bbox is
  'Normalized [x0,y0,x1,y1] (0..1, top-left origin) of the elevation drawing on image_page.';
