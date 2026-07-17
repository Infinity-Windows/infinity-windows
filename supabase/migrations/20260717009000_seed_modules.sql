-- Quality: seed the empty/thin modules so every screen shows real content in
-- the prototype (tools, a safety-talk rotation, and how-to guides beyond CAS3050).

-- Tools: common commercial install kit, a couple assigned to a lead.
insert into tools (name, calibration_due, note, holder_id)
select v.name, v.cal::date, v.note,
  case when v.assign then (select id from profiles order by role desc limit 1) else null end
from (values
  ('Hilti rotary laser',        '2026-10-01', 'Level reference for sills',           true),
  ('6ft box level',             null,          'Primary plumb/level check',           true),
  ('Torque screwdriver',        '2026-09-15', 'Pressure-plate torque 35-50 in-lb',   false),
  ('Vacuum lifting cups (pair)','2026-12-01', 'Rated 150 lb/cup on clean dry glass',  false),
  ('Moisture meter',            '2026-08-20', 'Substrate check before sealant',      false),
  ('Sealant gun (pneumatic)',   null,          'For long perimeter runs',             false),
  ('Digital caliper',           '2026-11-05', 'RO + shim gap verification',          false),
  ('Anemometer',                '2026-09-30', 'Wind check before lifts above 1 story', false)
) as v(name, cal, note, assign)
where not exists (select 1 from tools t where t.name = v.name);

-- Safety talks: a week-long rotation so a fresh one shows each day.
insert into safety_talks (title, body, talk_date)
select v.title, v.body, v.d::date
from (values
  ('Glass handling',       'Two people minimum over 150 lb. Carry lites on edge, never flat. Coated/tempered edges cut — gloves on, cups rated for the surface.', current_date + 1),
  ('Sealant & solvents',   'Read the SDS. Ventilate when tooling in enclosed spaces, skin protection for MEKP/primer, no open flame near solvents.', current_date + 2),
  ('Lift & rigging',       'Inspect straps and cups before every pick. Nobody under a suspended unit. Set A-frames braced and loaded evenly.', current_date + 3),
  ('Ladders & lifts',      'Three points of contact. Level the base. Scissor/boom lift: harness, gate closed, check the ground rating.', current_date + 4),
  ('Housekeeping',         'Clear the drop zone, cap exposed screws, sweep glass shards immediately. A clean deck is a safe deck.', current_date + 5),
  ('Heat & hydration',     'On hot elevations rotate shade breaks, water every 20 min. Dark glass against sun cracks — and burns hands.', current_date + 6)
) as v(title, body, d)
where not exists (select 1 from safety_talks s where s.title = v.title);

-- How-to guides beyond CAS3050: seed two more common types with structured steps.
update window_types set
  howto_json = '[
    {"title":"Verify the rough opening","detail":"Width at 3 points, height at 2, both diagonals. A double-hung binds fast if the sill is not level — fix the opening, never force the frame."},
    {"title":"Set the sill dead level","detail":"Shim at the setting points only, snug not tight. The sill is where a hung window lives or dies."},
    {"title":"Set and check reveal","detail":"Even reveal on all four sides before fastening. A tapered reveal tells you which corner is off."},
    {"title":"Fasten per schedule, re-check square","detail":"One over-driven screw racks the frame and drops the sashes. Check diagonals after each side."},
    {"title":"Flash jambs then head, foam light","detail":"Laps shed downhill. Low-expansion foam in passes so the jambs do not bow and jam the balances."}
  ]'::jsonb,
  howto_generated_at = now()
where type_code = 'DH2846';

update window_types set
  howto_json = '[
    {"title":"Confirm glass spec and safety bug","detail":"A large picture unit is heavy and often tempered/laminated. Check the etched bug and recalc crew/lift gear before it comes up."},
    {"title":"Dry-fit and stage on A-frames","detail":"Set on edge, never flat — a fixed lite this size will pop its IGU seal if racked during handling."},
    {"title":"Set on blocks, center the reveal","detail":"Setting blocks at the quarter points carry the weight. Center the unit so the perimeter joint is uniform for backer rod."},
    {"title":"Anchor without racking","detail":"Fixed units still rack. Fasten progressively and keep diagonals equal; a racked picture unit shows as a wavy reflection."},
    {"title":"Backer rod + tooled sealant","detail":"Rod to half the joint width, tool the same day. Big lites move a lot thermally — the joint must stretch, not shear."}
  ]'::jsonb,
  howto_generated_at = now()
where type_code = 'PIC6060';
