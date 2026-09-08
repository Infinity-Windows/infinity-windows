-- Synthetic multi-day assignment: verify real transactional splitting and RLS.
create function pg_temp.ok(p boolean,label text) returns void language plpgsql as $$
begin if p is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
 begin execute statement; exception when others then return; end;
 raise exception 'FAILED: expected rejection: %',statement;
end $$;
insert into projects values ('00000000-0000-0000-0000-000000001101');
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,status,note,color,created_via,published_at,updated_at)
values ('00000000-0000-0000-0000-000000001102','00000000-0000-0000-0000-000000001101','2026-09-09','2026-09-13','07:30','published','Keep the ladder','#ff9900','ai','2026-09-01','2026-09-08');
insert into schedule_assignment_members(assignment_id,profile_id,role) values
 ('00000000-0000-0000-0000-000000001102','00000000-0000-0000-0000-000000000001','installer'),
 ('00000000-0000-0000-0000-000000001102','00000000-0000-0000-0000-000000000003','foreman');
insert into vehicle_project_assignments(project_id,assignment_id,vehicle_id,start_date,end_date,note) values
 ('00000000-0000-0000-0000-000000001101','00000000-0000-0000-0000-000000001102','00000000-0000-0000-0000-000000001103','2026-09-09','2026-09-13','Trailer');
set role anon;
select pg_temp.denied($q$select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08')$q$);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select pg_temp.denied($q$select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08')$q$);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',false);
select pg_temp.denied($q$select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08')$q$);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select pg_temp.denied($q$select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-07')$q$);
-- Deliberate audit failure rolls back parent, member and vehicle mutations.
reset role;
create function pg_temp.reject_day_audit() returns trigger language plpgsql as $$
begin if new.payload->>'scope'='day' then raise exception 'Synthetic audit failure'; end if; return new; end $$;
create trigger test_day_audit before insert on schedule_events for each row execute function pg_temp.reject_day_audit();
set role authenticated;
select pg_temp.denied($q$select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08')$q$);
select pg_temp.ok((select count(*)=1 and max(end_date)='2026-09-13' from schedule_assignments where project_id='00000000-0000-0000-0000-000000001101'),'failed split rolled back');
reset role;
drop trigger test_day_audit on schedule_events;
set role authenticated;
select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08');
-- Lost-response retry neither splits again nor removes a second day.
select schedule_remove_day('00000000-0000-0000-0000-000000001102','2026-09-11','2026-09-08');
select pg_temp.ok((select count(*)=2 and bool_and(status='published' and start_time='07:30' and note='Keep the ladder' and color='#ff9900' and created_via='ai' and published_at='2026-09-01') from schedule_assignments where project_id='00000000-0000-0000-0000-000000001101'),'split preserves metadata');
select pg_temp.ok((select count(*)=4 from schedule_assignment_members m join schedule_assignments a on a.id=m.assignment_id where a.project_id='00000000-0000-0000-0000-000000001101'),'both crews retained');
select pg_temp.ok((select count(*)=2 and bool_and(v.start_date=a.start_date and v.end_date=a.end_date and v.note='Trailer') from vehicle_project_assignments v join schedule_assignments a on a.id=v.assignment_id where a.project_id='00000000-0000-0000-0000-000000001101'),'both vehicle bookings aligned');
select pg_temp.ok((select array_agg(d::date order by d)=array['2026-09-09','2026-09-10','2026-09-12','2026-09-13']::date[] from schedule_assignments a cross join lateral generate_series(a.start_date,a.end_date,'1 day') d where a.project_id='00000000-0000-0000-0000-000000001101'),'only selected middle day removed');
-- First and last edges trim; the final single day deletes only its assignment.
select schedule_remove_day(id,'2026-09-09',updated_at) from schedule_assignments where id='00000000-0000-0000-0000-000000001102';
select schedule_remove_day(id,'2026-09-13',updated_at) from schedule_assignments where project_id='00000000-0000-0000-0000-000000001101' and start_date='2026-09-12';
select pg_temp.ok((select count(*)=2 and bool_and(start_date=end_date) from schedule_assignments where project_id='00000000-0000-0000-0000-000000001101'),'first and last edges trimmed');
select schedule_remove_day(id,'2026-09-10',updated_at) from schedule_assignments where id='00000000-0000-0000-0000-000000001102';
select pg_temp.ok((select count(*)=1 and min(start_date)='2026-09-12' from schedule_assignments where project_id='00000000-0000-0000-0000-000000001101'),'single-day removal preserves other block');
select pg_temp.ok((select count(*)=1 from vehicle_project_assignments where project_id='00000000-0000-0000-0000-000000001101'),'single day cascades own vehicle only');
select pg_temp.denied($q$select schedule_remove_day(a.id,a.start_date,a.updated_at) from schedule_assignments a join workflow_plan_assignments l on l.assignment_id=a.id limit 1$q$);
reset role;
