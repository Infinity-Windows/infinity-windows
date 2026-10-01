-- Additional synthetic units, one isolated case per contention scenario.
create table qc_race_cases(name text primary key, opening uuid not null, expected text not null);
create table qc_race_results(session text primary key, outcome text not null);
grant select on qc_race_cases to authenticated;
grant insert,select on qc_race_results to authenticated;
insert into project_openings(id,project_id,opening_code,status)
select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '00000000-0000-4000-8000-000000000202', 'RACE-'||n, 'installed'
from generate_series(401,404) n;
insert into qc_checks(project_opening_id,status,note,checked_by,checked_at)
values ('00000000-0000-4000-8000-000000000402','callback','seed','00000000-0000-4000-8000-000000000002',now()),
       ('00000000-0000-4000-8000-000000000404','callback','seed','00000000-0000-4000-8000-000000000002',now());
insert into qc_race_cases(name,opening,expected)
select c.name,o.id,coalesce(q.review_version::text,'none')
from (values ('legacy-insert',401),('legacy-update',402),('same-request',403),('guarded',404)) c(name,n)
join project_openings o on o.id = ('00000000-0000-4000-8000-'||lpad(c.n::text,12,'0'))::uuid
left join qc_checks q on q.project_opening_id=o.id;
insert into points_ledger(ref,status) select opening::text,'pending' from qc_race_cases;
