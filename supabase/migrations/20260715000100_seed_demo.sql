-- Demo seed: a starter slice of the catalog, stock racks, and two sample jobs.
-- Replace/extend window_types with the real 100-type catalog via the app or CSV import.

insert into window_types (type_code, name, category, width_in, height_in, difficulty_rating) values
  ('CAS3050', 'Casement 30x50', 'casement', 30, 50, 2),
  ('CAS3660', 'Casement 36x60', 'casement', 36, 60, 2),
  ('DH2846',  'Double-Hung 28x46', 'double-hung', 28, 46, 1),
  ('DH3252',  'Double-Hung 32x52', 'double-hung', 32, 52, 1),
  ('SL6040',  'Slider 60x40', 'slider', 60, 40, 3),
  ('SL7248',  'Slider 72x48', 'slider', 72, 48, 3),
  ('PIC4836', 'Picture 48x36', 'picture', 48, 36, 2),
  ('PIC6048', 'Picture 60x48', 'picture', 60, 48, 3),
  ('BAY9648', 'Bay 96x48', 'specialty', 96, 48, 5),
  ('AWN3624', 'Awning 36x24', 'specialty', 36, 24, 2)
on conflict (type_code) do nothing;

-- Stock zone: racks 01-06, slots A-F
insert into locations (zone, rack, slot, capacity)
select 'S', lpad(r::text, 2, '0'), chr(64 + s), 6
from generate_series(1, 6) r, generate_series(1, 6) s
on conflict do nothing;

-- Receiving + damage holding spots
insert into locations (zone, rack, slot, capacity) values
  ('R', 'DOCK', 'A', 50),
  ('D', 'HOLD', 'A', 20)
on conflict do nothing;

-- Two sample jobs with staging bays
insert into projects (job_code, name, address) values
  ('SMITH', 'Smith Residence', '412 Maple St'),
  ('OAKRIDGE', 'Oakridge Apartments Bldg C', '900 Oakridge Dr')
on conflict (job_code) do nothing;

insert into locations (zone, rack, slot, capacity)
select 'J', p.job_code, s.slot, 10
from projects p, (values ('A'), ('B')) as s(slot)
on conflict do nothing;

insert into project_windows (project_id, window_type_id, quantity)
select p.id, t.id, q.qty
from projects p
join (values
  ('SMITH', 'CAS3050', 4),
  ('SMITH', 'DH2846', 6),
  ('SMITH', 'PIC4836', 1),
  ('OAKRIDGE', 'DH3252', 24),
  ('OAKRIDGE', 'SL6040', 8)
) as q(job_code, type_code, qty) on q.job_code = p.job_code
join window_types t on t.type_code = q.type_code
on conflict do nothing;
