-- Dual planset roles per job: building floor plans (map) vs specs/schedule
-- (mark → size/type/color). Existing uploads default to building so the map
-- keeps a background PDF; re-upload or tag as specs for schedule extract.

alter table project_plansets
  add column if not exists kind text not null default 'building'
    check (kind in ('building', 'specs'));

create index if not exists project_plansets_kind_idx
  on project_plansets(project_id, kind, created_at desc);

comment on column project_plansets.kind is
  'building = floor/elevation drawings for the map; specs = window/door schedule';
