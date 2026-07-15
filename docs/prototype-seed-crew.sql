-- Demo crew profiles + foreman-push assignments for the dispatch board.
-- Safe to re-run. Requires the auth users to already exist (created via admin API).

-- Profiles keyed to auth.users, with skill tiers + a lead.
insert into profiles (id, display_name, skill_level, role, active)
select u.id, v.name, v.skill, v.role, true
from (values
  ('taylor@horizonsolarusa.com', 'Taylor',  5, 'lead'),
  ('ammon@horizonsolarusa.com',  'Ammon',   4, 'installer'),
  ('dave@crew.demo',             'Dave',    3, 'installer'),
  ('maria@crew.demo',            'Maria',   3, 'installer'),
  ('sam@crew.demo',              'Sam',     2, 'installer'),
  ('chris@crew.demo',            'Chris',   1, 'installer')
) as v(email, name, skill, role)
join auth.users u on u.email = v.email
on conflict (id) do update set
  display_name = excluded.display_name,
  skill_level = excluded.skill_level,
  role = excluded.role,
  active = true;

-- Assign a few SMITH openings across the crew so My Work + the board demo.
-- W1 (fits) -> Maria; W3 (tight, loaded) -> Ammon; W2/W6 -> Sam/Chris (easier);
-- leave W5/W7 unassigned for the lead to auto-distribute.
with smith as (select id from projects where job_code = 'SMITH')
update project_openings o
set assigned_to = p.id,
    assigned_by = (select id from profiles where display_name = 'Taylor'),
    assigned_at = now(),
    sequence = v.seq
from (values
  ('W1', 'Maria', 0),
  ('W2', 'Sam',   0),
  ('W3', 'Ammon', 0),
  ('W6', 'Chris', 0)
) as v(code, name, seq)
join profiles p on p.display_name = v.name
where o.opening_code = v.code
  and o.project_id = (select id from smith);

select o.opening_code, pr.display_name as assigned, o.sequence
from project_openings o
left join profiles pr on pr.id = o.assigned_to
where o.project_id = (select id from projects where job_code = 'SMITH')
order by o.opening_code;
