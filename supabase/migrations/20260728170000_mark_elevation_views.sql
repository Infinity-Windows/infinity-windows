-- Where each mark is drawn on the EXTERIOR ELEVATION sheets, as a reference.
--
-- These rows are NOT openings, and nothing in the app may ever count them as
-- openings. An elevation sheet draws the same windows the floor plan already
-- numbers, seen from outside, and the draughtsman writes each window's number
-- again on every view it appears in — which is exactly why PR #127 stopped
-- counting callouts off elevation pages (Black Desert: 99 openings → 42, the
-- true number). This table keeps the information that fix throws away, for
-- the one thing it is genuinely good for: showing an installer WHERE ON THE
-- BUILDING the window they are holding actually sits.
--
-- One row = one mark drawn once in one titled drawing on one elevation sheet:
--   page_number  — 1-based page of the BUILDING planset (the elevation sheet).
--   region_index — which drawing on that page, 0-based top to bottom. A sheet
--                  holds two or three separate drawings, each with its own
--                  title underneath, so the page alone does not identify a view.
--   view_name    — the sheet's OWN title for that drawing, verbatim, e.g.
--                  "FRONT ELEVATION - SOUTH". Plain-English wording for the
--                  crew is derived from this in the app, so it can be reworded
--                  without a migration. Null when the sheet never named it.
--   pin_x/pin_y  — the callout number's centre, normalized 0..1, top-left
--                  origin, same space as project_openings.pin_x/pin_y.
--   label_w/h    — the callout number's own size (normalized), so the app can
--                  ring the number it actually found instead of guessing.
--   crop_bbox    — normalized [x0,y0,x1,y1] of the drawing region to show, so
--                  the phone crops the sheet without re-deriving any geometry.
--
-- Why this cannot bring the over-count back:
--   * separate table, no qty / status / confirmed / window_type_id, referenced
--     by no count, no inventory path and no install flow — only by the
--     read-only reference card;
--   * it is written from the callouts the opening extractor DROPPED (the same
--     one split decides both sides), so a callout can never become both an
--     opening and a reference row;
--   * the unique index below makes a re-extract idempotent: one row per mark
--     per drawing, however many times the number is repeated inside it.
--
-- Additive + idempotent, RLS mirrors project_mark_specs: read for any
-- authenticated crew member, write for foreman+. The app degrades to showing
-- nothing at all until this is applied.

create table if not exists project_mark_elevation_views (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The building planset these coordinates were measured against. A replaced
  -- planset must not have another file's boxes cropped out of it.
  planset_id uuid not null references project_plansets(id) on delete cascade,
  -- Base mark without instance suffix, e.g. "9", "13A" — shared by every
  -- opening that uses the mark, exactly like project_mark_specs.
  mark_code text not null,

  page_number integer not null,
  region_index integer not null default 0,
  view_name text,

  pin_x double precision not null,
  pin_y double precision not null,
  label_w double precision,
  label_h double precision,
  crop_bbox jsonb,

  created_at timestamptz not null default now(),

  unique (planset_id, mark_code, page_number, region_index)
);

comment on table project_mark_elevation_views is
  'Reference only: where a mark is drawn on the exterior elevation sheets. Never an opening — see project_openings for the count.';
comment on column project_mark_elevation_views.view_name is
  'The sheet''s own title for this drawing, verbatim (e.g. "FRONT ELEVATION - SOUTH"). Null when unnamed.';
comment on column project_mark_elevation_views.crop_bbox is
  'Normalized [x0,y0,x1,y1] (0..1, top-left origin) of the drawing region to crop out of page_number.';

create index if not exists project_mark_elevation_views_project_idx
  on project_mark_elevation_views (project_id, mark_code);

alter table project_mark_elevation_views enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_elevation_views'
      and policyname = 'mark_elevation_views_select_authed'
  ) then
    create policy "mark_elevation_views_select_authed" on project_mark_elevation_views
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_elevation_views'
      and policyname = 'mark_elevation_views_insert_foreman'
  ) then
    create policy "mark_elevation_views_insert_foreman" on project_mark_elevation_views
      for insert to authenticated
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_elevation_views'
      and policyname = 'mark_elevation_views_update_foreman'
  ) then
    create policy "mark_elevation_views_update_foreman" on project_mark_elevation_views
      for update to authenticated
      using (public.is_foreman_plus(auth.uid()))
      with check (public.is_foreman_plus(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_mark_elevation_views'
      and policyname = 'mark_elevation_views_delete_foreman'
  ) then
    create policy "mark_elevation_views_delete_foreman" on project_mark_elevation_views
      for delete to authenticated
      using (public.is_foreman_plus(auth.uid()));
  end if;
end;
$$;

grant select on project_mark_elevation_views to authenticated;
grant insert, update, delete on project_mark_elevation_views to authenticated;
grant all on project_mark_elevation_views to service_role;
