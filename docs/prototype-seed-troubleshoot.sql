-- Troubleshooting seed for install-capture + brain loop.
-- Safe to re-run: uses fixed window_ids / opening codes and ON CONFLICT / NOT EXISTS.
-- Paste into SQL editor OR: npx supabase db query --linked -f docs/prototype-seed-troubleshoot.sql

-- ---------------------------------------------------------------------------
-- Physical inventory units (license plates) across statuses for SMITH
-- ---------------------------------------------------------------------------
with
  types as (
    select type_code, id from window_types
    where type_code in ('CAS3050','DH2846','PIC4836','DH3252','SL6040')
  ),
  smith as (select id from projects where job_code = 'SMITH'),
  oak as (select id from projects where job_code = 'OAKRIDGE'),
  slot as (
    select id, address from locations where address in ('S-01-A','S-01-B','S-02-A','S-02-B','J-SMITH-A','R-DOCK-A')
  )
insert into windows (window_id, window_type_id, status, project_id, location_id, received_at, notes)
select v.window_id, t.id, v.status, v.project_id, l.id, now() - (v.days_ago || ' days')::interval, v.notes
from (values
  -- SMITH stock / staged / loaded
  ('W-CAS3050-0001', 'CAS3050', 'staged',       (select id from smith), 'J-SMITH-A', 3, 'Staged for Smith living room'),
  ('W-CAS3050-0002', 'CAS3050', 'in_warehouse', (select id from smith), 'S-01-A',    5, null),
  ('W-CAS3050-0003', 'CAS3050', 'loaded',       (select id from smith), null,       2, 'On truck today'),
  ('W-CAS3050-0004', 'CAS3050', 'in_warehouse', null,                   'S-01-B',    8, 'Unassigned spare'),
  ('W-DH2846-0001',  'DH2846',  'staged',       (select id from smith), 'J-SMITH-A', 3, null),
  ('W-DH2846-0002',  'DH2846',  'in_warehouse', (select id from smith), 'S-02-A',    4, null),
  ('W-DH2846-0003',  'DH2846',  'inbound',      (select id from smith), 'R-DOCK-A',  0, 'Needs putaway'),
  ('W-PIC4836-0001', 'PIC4836', 'in_warehouse', (select id from smith), 'S-02-B',    6, null),
  -- OAKRIDGE
  ('W-DH3252-0001',  'DH3252',  'in_warehouse', (select id from oak),   'S-01-A',   10, null),
  ('W-DH3252-0002',  'DH3252',  'staged',       (select id from oak),   null,       2, 'Bay not set'),
  ('W-SL6040-0001',  'SL6040',  'in_warehouse', (select id from oak),   'S-02-A',    7, null)
) as v(window_id, type_code, status, project_id, address, days_ago, notes)
join types t on t.type_code = v.type_code
left join slot l on l.address = v.address
on conflict (window_id) do update set
  status = excluded.status,
  project_id = excluded.project_id,
  location_id = excluded.location_id,
  notes = excluded.notes;

-- Keep ID counters ahead of seeded plates so receive_window doesn't collide
insert into window_id_counters (window_type_id, last_seq)
select t.id, greatest(coalesce(c.last_seq, 0), 10)
from window_types t
left join window_id_counters c on c.window_type_id = t.id
where t.type_code in ('CAS3050','DH2846','PIC4836','DH3252','SL6040')
on conflict (window_type_id) do update set last_seq = greatest(window_id_counters.last_seq, excluded.last_seq);

-- ---------------------------------------------------------------------------
-- SMITH openings (confirmed) — triggers demand rollup into project_windows
-- ---------------------------------------------------------------------------
insert into project_openings (
  project_id, opening_code, window_type_id, label, page_number,
  pin_x, pin_y, assigned_window_id, status, confirmed
)
select
  p.id,
  v.opening_code,
  t.id,
  v.label,
  1,
  v.pin_x,
  v.pin_y,
  w.id,
  v.status,
  true
from projects p
cross join (values
  ('W1',   'CAS3050', 'Living room north',  0.22, 0.35, 'W-CAS3050-0001', 'assigned'),
  ('W2',   'CAS3050', 'Living room south',  0.55, 0.38, null,              'planned'),
  ('W3',   'CAS3050', 'Kitchen east',       0.78, 0.55, 'W-CAS3050-0003', 'assigned'),
  ('W4',   'DH2846',  'Bedroom 2 west',     0.30, 0.70, 'W-DH2846-0001',  'assigned'),
  ('W5',   'DH2846',  'Bedroom 2 east',     0.60, 0.72, null,              'planned'),
  ('W6',   'DH2846',  'Hall bath',          0.45, 0.50, null,              'planned'),
  ('W7',   'PIC4836', 'Stairwell fixed',    0.15, 0.20, null,              'planned'),
  -- Already-installed openings (paired with events below)
  ('W1A',  'CAS3050', 'Office (done)',      0.40, 0.25, null,              'installed'),
  ('W1B',  'CAS3050', 'Den (done)',         0.65, 0.28, null,              'installed'),
  ('W1C',  'CAS3050', 'Mudroom (done)',     0.85, 0.40, null,              'installed'),
  ('W4A',  'DH2846',  'Guest BR (done)',    0.20, 0.80, null,              'installed')
) as v(opening_code, type_code, label, pin_x, pin_y, window_id, status)
join window_types t on t.type_code = v.type_code
left join windows w on w.window_id = v.window_id
where p.job_code = 'SMITH'
on conflict (project_id, opening_code) do update set
  window_type_id = excluded.window_type_id,
  label = excluded.label,
  pin_x = excluded.pin_x,
  pin_y = excluded.pin_y,
  assigned_window_id = excluded.assigned_window_id,
  status = excluded.status,
  confirmed = true;

-- A couple of unconfirmed drafts (Opening Review UI)
insert into project_openings (
  project_id, opening_code, window_type_id, label, page_number, confirmed, status
)
select p.id, v.opening_code, t.id, v.label, 1, false, 'planned'
from projects p
cross join (values
  ('W8', 'DH2846', 'Draft — laundry (unconfirmed)'),
  ('W9', 'CAS3050', 'Draft — porch (unconfirmed)')
) as v(opening_code, type_code, label)
join window_types t on t.type_code = v.type_code
where p.job_code = 'SMITH'
  and not exists (
    select 1 from project_openings o
    where o.project_id = p.id and o.opening_code = v.opening_code
  );

-- OAKRIDGE: fewer openings so Map/hub still has a second job to click
insert into project_openings (
  project_id, opening_code, window_type_id, label, page_number,
  pin_x, pin_y, status, confirmed
)
select p.id, v.opening_code, t.id, v.label, 1, v.pin_x, v.pin_y, 'planned', true
from projects p
cross join (values
  ('C101', 'DH3252', 'Unit C101 living', 0.25, 0.30),
  ('C102', 'DH3252', 'Unit C102 living', 0.55, 0.30),
  ('C103', 'SL6040', 'Unit C103 slider', 0.40, 0.60)
) as v(opening_code, type_code, label, pin_x, pin_y)
join window_types t on t.type_code = v.type_code
where p.job_code = 'OAKRIDGE'
on conflict (project_id, opening_code) do update set
  window_type_id = excluded.window_type_id,
  label = excluded.label,
  pin_x = excluded.pin_x,
  pin_y = excluded.pin_y,
  confirmed = true,
  status = excluded.status;

-- Force demand sync (also fired by trigger on confirm)
select sync_project_windows_from_openings(id) from projects where job_code in ('SMITH','OAKRIDGE');

-- ---------------------------------------------------------------------------
-- Install events (3+ on CAS3050 so tip synthesis works)
-- ---------------------------------------------------------------------------
insert into install_events (
  project_opening_id, window_type_id, installer, minutes, quality_grade,
  difficulty, went_well, went_poorly, obstacles, tools_helped,
  time_vs_estimate, safety_notes, do_again, transcript_raw, started_at, created_at
)
select
  o.id,
  o.window_type_id,
  v.installer,
  v.minutes,
  v.grade,
  v.difficulty,
  v.went_well,
  v.went_poorly,
  v.obstacles,
  v.tools_helped,
  v.time_vs_estimate,
  v.safety_notes,
  v.do_again,
  v.transcript,
  now() - (v.days_ago || ' days')::interval,
  now() - (v.days_ago || ' days')::interval
from project_openings o
join projects p on p.id = o.project_id and p.job_code = 'SMITH'
join (values
  ('W1A', 'jamie@crew', 42, 4,
   'Felt medium — shim dance took a minute',
   'Sill was square; foam sealed clean',
   'Upper hinge screws wanted to cam out',
   'Drywall dust in the rough opening',
   'Impact with clutch + plastic shims',
   'Estimate 40m, actual 42m — close',
   'Eye pro when cutting nailing fin',
   'Pre-check RO with diagonal tape before setting',
   'Okay so this was the office casement. Difficulty felt medium. What went well was the sill was square and the foam sealed clean. What didn''t go well — upper hinge screws wanted to cam out. Obstacle was drywall dust in the RO. Impact with clutch and plastic shims helped. Time was basically on estimate. Safety — eye pro when cutting the fin. Next time I''d pre-check the rough opening with diagonal tape before setting.',
   12),
  ('W1B', 'alex@crew', 55, 3,
   'Harder than catalog — out of square RO',
   'Flashing tape held on first pass',
   'Had to back-bevel the fin on the latch side',
   'RO was 3/8 out of square',
   '4-ft level + Japanese pull saw for fin',
   'Estimate 40m, actual 55m',
   'Watch fingers on tempered edge',
   'Bring a Japanese pull saw when RO is racked',
   'Den casement. Felt harder than the catalog rating because the rough opening was out of square by three eighths. Flashing tape held on the first pass which was good. Had to back-bevel the nailing fin on the latch side. Four foot level and a Japanese pull saw helped. Ran long — fifty five minutes versus forty estimate. Next time bring the pull saw whenever the RO looks racked.',
   9),
  ('W1C', 'jamie@crew', 38, 5,
   'Easy once we staged the unit outside the mudroom',
   'Two-person set, no scratch on cladding',
   'Nothing major',
   'Tight exterior access — fence in the way',
   'Suction cups + foam gun',
   'Beat estimate by a few minutes',
   'Call out pinch points on the swing',
   'Stage the unit outside the opening before the lift',
   'Mudroom install. Easy once we staged the unit outside. Two person set, no scratch on the cladding. Fence made exterior access tight. Suction cups and foam gun helped. Beat the estimate. Call out pinch points on the swing. Next time stage the unit outside the opening before the lift.',
   5),
  ('W4A', 'sam@crew', 28, 4,
   'Straightforward double-hung',
   'Balances seated on first try',
   'Screen track had a burr',
   'None really',
   'File for the screen track burr',
   'On estimate',
   'None',
   'Keep a small file in the pouch for screen tracks',
   'Guest bedroom double hung. Straightforward. Balances seated on first try. Screen track had a burr — filed it. On estimate. Keep a small file in the pouch for screen tracks.',
   7)
) as v(opening_code, installer, minutes, grade, difficulty, went_well, went_poorly, obstacles, tools_helped, time_vs_estimate, safety_notes, do_again, transcript, days_ago)
  on v.opening_code = o.opening_code
where not exists (
  select 1 from install_events e where e.project_opening_id = o.id
);

-- Seed synthesized tips on CAS3050 so brain card has something before a live GPT call
update window_types set
  tips_json = '[
    "Pre-check RO with diagonal tape before setting the unit",
    "Stage the unit outside the opening before the lift",
    "Use impact with clutch + plastic shims on casement hinges",
    "Bring a Japanese pull saw when the RO is racked",
    "Call out pinch points on the swing path"
  ]'::jsonb,
  watch_outs_json = '[
    "Upper hinge screws can cam out on casements",
    "Out-of-square RO by 3/8\" will blow the time estimate",
    "Tempered edges — watch fingers"
  ]'::jsonb,
  outcome_difficulty = 3,
  tips_synthesized_at = now(),
  tips_install_count = 3
where type_code = 'CAS3050';

-- Sample movements so WindowDetail history isn't empty
insert into movements (window_id, event, project_id, actor, reason, created_at)
select w.id, v.event, w.project_id, v.actor, v.reason, now() - (v.hours_ago || ' hours')::interval
from windows w
join (values
  ('W-CAS3050-0001', 'received', 'jamie@crew', null, 80),
  ('W-CAS3050-0001', 'putaway',  'jamie@crew', null, 70),
  ('W-CAS3050-0001', 'staged',   'alex@crew',  'Smith load plan', 30),
  ('W-CAS3050-0001', 'assigned', 'alex@crew',  'assigned to opening W1', 20),
  ('W-CAS3050-0003', 'loaded',   'jamie@crew', 'Truck 2', 6),
  ('W-DH2846-0003',  'received', 'sam@crew',   null, 4)
) as v(window_id, event, actor, reason, hours_ago)
  on v.window_id = w.window_id
where not exists (
  select 1 from movements m
  where m.window_id = w.id and m.event = v.event and m.reason is not distinct from v.reason
);

-- Done. Quick sanity counts:
select 'windows' as what, count(*)::text as n from windows
union all select 'openings', count(*)::text from project_openings
union all select 'install_events', count(*)::text from install_events
union all select 'smith_project_windows', count(*)::text
  from project_windows pw join projects p on p.id = pw.project_id where p.job_code = 'SMITH';
