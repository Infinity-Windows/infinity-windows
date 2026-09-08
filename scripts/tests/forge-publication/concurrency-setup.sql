-- Fresh synthetic plan for two separate connections publishing concurrently.
insert into schedule_assignments(id,project_id,start_date,end_date) values ('00000000-0000-0000-0000-000000000605','00000000-0000-0000-0000-000000000101','2026-11-02','2026-11-06');
insert into schedule_assignment_members(assignment_id,profile_id,role) values ('00000000-0000-0000-0000-000000000605','00000000-0000-0000-0000-000000000001','installer');
insert into trips(id,project_id,name,start_date,end_date) values ('00000000-0000-0000-0000-000000000206','00000000-0000-0000-0000-000000000101','Concurrent fixture','2026-11-01','2026-11-07');
insert into trip_crew(trip_id,profile_id) values ('00000000-0000-0000-0000-000000000206','00000000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_create_plan('00000000-0000-0000-0000-000000000903','Concurrent fixture',array['00000000-0000-0000-0000-000000000605']::uuid[],array['00000000-0000-0000-0000-000000000206']::uuid[]);
reset role;
create table public.fixture_review_token(token text);
insert into fixture_review_token select workflow_review_plan('00000000-0000-0000-0000-000000000903')->>'review_token';
grant select on fixture_review_token to authenticated;
-- Force the duplicate requests to overlap while holding the publication lock.
create function public.fixture_pause_publication() returns trigger language plpgsql as $$ begin perform pg_sleep(0.25); return new; end $$;
create trigger fixture_pause before insert on workflow_plan_revisions for each row execute function fixture_pause_publication();
