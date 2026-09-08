-- These are execution tests under real PostgreSQL roles, not SQL text matches.
create function pg_temp.check_true(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
-- Each attempted write is rolled back in its own subtransaction. A denied
-- UPDATE/DELETE legitimately affects zero rows; INSERT normally raises 42501.
create function pg_temp.check_write(statement text, expected bigint) returns void language plpgsql as $$
declare affected bigint;
begin
 begin
  execute statement;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'FAILED write (% rows expected %): %',affected,expected,statement; end if;
  raise exception using errcode='ZX001',message='rollback successful probe';
 exception when sqlstate 'ZX001' then null;
 when insufficient_privilege then
  if expected <> 0 then raise exception 'FAILED allowed write: %',statement; end if;
 end;
end $$;

-- Assigned installer and foreman: published instructions only, personal/crew
-- flights, no schedule writes. The foreman has no personal flight in fixtures.
do $$ declare person text; own_count integer; begin
 foreach person in array array['001','003'] loop
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000'||person,true);
  own_count := case when person='001' then 2 else 1 end;
  perform pg_temp.check_true((select count(*)=1 from trips),'crew published trip only');
  perform pg_temp.check_true((select count(*)=3 from trip_crew),'crew published roster only');
  perform pg_temp.check_true((select count(*)=own_count from flights),'personal and whole-crew flights only');
  perform pg_temp.check_true((select count(*)=1 from lodging),'published lodging only');
  perform pg_temp.check_true((select count(*)=1 from ground_transport),'published ground only');
  perform pg_temp.check_true((select count(*)=1 from trip_contacts),'published contacts only');
  perform pg_temp.check_true((select count(*)=2 from procedures),'published and company procedures');
  perform pg_temp.check_true((select count(*)=own_count from trip_attachments),'attachment metadata follows passenger and parent trip');
  perform pg_temp.check_true((select count(*)=own_count from storage.objects),'file objects match visible metadata; no orphan or cross-trip file');
  perform pg_temp.check_true((select count(*)=1 from schedule_assignments),'internal calendar reads preserved');
  perform pg_temp.check_true((select count(*)=1 from schedule_assignment_members),'internal membership reads preserved');
  perform pg_temp.check_true((select count(*)=1 from schedule_events),'internal event reads preserved');
  perform pg_temp.check_write($q$insert into schedule_assignments(project_id,start_date,end_date) values ('00000000-0000-0000-0000-000000000101','2026-09-01','2026-09-02')$q$,0);
  perform pg_temp.check_write($q$update schedule_assignments set note='unauthorized'$q$,0);
  perform pg_temp.check_write($q$delete from schedule_assignments$q$,0);
  perform pg_temp.check_write($q$insert into schedule_assignment_members(assignment_id,profile_id,role) values ('00000000-0000-0000-0000-000000000601','00000000-0000-0000-0000-000000000002','installer')$q$,0);
  perform pg_temp.check_write($q$update schedule_assignment_members set role='foreman'$q$,0);
  perform pg_temp.check_write($q$delete from schedule_assignment_members$q$,0);
  perform pg_temp.check_write($q$insert into schedule_events(kind) values ('published')$q$,0);
  perform pg_temp.check_write($q$update schedule_events set kind='published'$q$,0);
  perform pg_temp.check_write($q$delete from schedule_events$q$,0);
  perform pg_temp.check_write($q$update trips set status='published'$q$,0);
  perform pg_temp.check_write($q$update flights set confirmation_code='unauthorized'$q$,0);
  perform pg_temp.check_write($q$insert into trip_crew(trip_id,profile_id) values ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-000000000001')$q$,0);
  perform pg_temp.check_write($q$insert into trip_attachments(trip_id,storage_path) values ('00000000-0000-0000-0000-000000000201','forged.pdf')$q$,0);
  perform pg_temp.check_write($q$insert into storage.objects(bucket_id,name) values ('trip-attachments','forged.pdf')$q$,0);
  perform pg_temp.check_write($q$update storage.objects set name='forged.pdf'$q$,0);
  perform pg_temp.check_write($q$delete from storage.objects$q$,0);
  perform pg_temp.check_write($q$update vehicle_project_assignments set note='job-level update' where assignment_id is null$q$,1);
  perform pg_temp.check_write($q$update vehicle_project_assignments set assignment_id='00000000-0000-0000-0000-000000000601' where assignment_id is null$q$,0);
  perform pg_temp.check_write($q$update vehicle_project_assignments set assignment_id=null where assignment_id is not null$q$,0);
  perform pg_temp.check_write($q$delete from vehicle_project_assignments where assignment_id is not null$q$,0);
  perform pg_temp.check_write($q$insert into vehicle_project_assignments(assignment_id) values ('00000000-0000-0000-0000-000000000601')$q$,0);
  perform pg_temp.check_write($q$select schedule_delivery('00000000-0000-0000-0000-000000000801',now(),array[]::uuid[])$q$,0);
 end loop;
 perform set_config('role','postgres',true);
end $$;

-- Removing membership revokes new table/object access immediately. Existing
-- signed URLs are bearer tokens until their expiry; that separate storage API
-- property cannot be proven or changed by a PostgreSQL-only test.
begin;
delete from trip_crew where profile_id='00000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select pg_temp.check_true((select count(*)=0 from trips),'removed crew loses trip');
select pg_temp.check_true((select count(*)=0 from flights),'removed passenger loses flight');
select pg_temp.check_true((select count(*)=0 from trip_attachments),'removed crew loses metadata');
select pg_temp.check_true((select count(*)=0 from storage.objects),'removed crew loses object access');
rollback;

-- Supervisor, owner and both supported legacy manager roles retain editors,
-- uploads before metadata registration, cleanup of orphan files, and delivery.
do $$ declare person text; begin
 foreach person in array array['004','005','007','008'] loop
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000'||person,true);
  perform pg_temp.check_true((select count(*)=3 from trips),'manager draft access');
  perform pg_temp.check_true((select count(*)=5 from flights),'manager all passengers');
  perform pg_temp.check_true((select count(*)=8 from trip_attachments),'manager can repair malformed metadata');
  perform pg_temp.check_true((select count(*)=9 from storage.objects),'manager can clean orphan uploads');
  perform pg_temp.check_write($q$insert into schedule_assignments(project_id,start_date,end_date) values ('00000000-0000-0000-0000-000000000101','2026-09-01','2026-09-02')$q$,1);
  perform pg_temp.check_write($q$update schedule_assignments set note='manager'$q$,1);
  perform pg_temp.check_write($q$delete from schedule_assignments$q$,1);
  perform pg_temp.check_write($q$insert into schedule_assignment_members(assignment_id,profile_id,role) values ('00000000-0000-0000-0000-000000000601','00000000-0000-0000-0000-000000000002','installer')$q$,1);
  perform pg_temp.check_write($q$update schedule_assignment_members set role='foreman'$q$,1);
  perform pg_temp.check_write($q$delete from schedule_assignment_members$q$,1);
  perform pg_temp.check_write($q$insert into schedule_events(kind) values ('published')$q$,1);
  perform pg_temp.check_write($q$update schedule_events set kind='published'$q$,1);
  perform pg_temp.check_write($q$delete from schedule_events$q$,1);
  perform pg_temp.check_write($q$update trips set status='published'$q$,3);
  perform pg_temp.check_write($q$update vehicle_project_assignments set note='manager'$q$,2);
  perform pg_temp.check_write($q$insert into storage.objects(bucket_id,name) values ('trip-attachments','new-upload.pdf')$q$,1);
  perform pg_temp.check_write($q$delete from storage.objects where name='orphan.pdf'$q$,1);
  perform pg_temp.check_write($q$select schedule_delivery('00000000-0000-0000-0000-000000000801','2026-09-09 08:00Z',array['00000000-0000-0000-0000-000000000001']::uuid[])$q$,1);
 end loop;
 perform set_config('role','postgres',true);
end $$;

-- Partner cannot exploit a supervisor rank, a table policy, file access, or
-- the SECURITY DEFINER delivery entry point to cross the partner wall.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',true);
select pg_temp.check_true((select count(*)=0 from trips),'partner trips');
select pg_temp.check_true((select count(*)=0 from schedule_assignments),'partner schedule');
select pg_temp.check_true((select count(*)=0 from vehicle_project_assignments),'partner vehicle links');
select pg_temp.check_true((select count(*)=0 from storage.objects),'partner file objects');
select pg_temp.check_true(not travel_can_read_trip('00000000-0000-0000-0000-000000000201'),'partner helper');
select pg_temp.check_write($q$update trips set status='published'$q$,0);
select pg_temp.check_write($q$update schedule_assignments set note='partner'$q$,0);
select pg_temp.check_write($q$insert into storage.objects(bucket_id,name) values ('trip-attachments','partner.pdf')$q$,0);
select pg_temp.check_write($q$select schedule_delivery('00000000-0000-0000-0000-000000000801',now(),array[]::uuid[])$q$,0);
rollback;

-- Unknown roles must not pass a negative-list manager check.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000009',true);
select pg_temp.check_write($q$update schedule_assignments set note='unknown'$q$,0);
select pg_temp.check_write($q$select schedule_delivery('00000000-0000-0000-0000-000000000801',now(),array[]::uuid[])$q$,0);
rollback;

begin;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.check_true((select count(*)=0 from trips),'anonymous trips');
select pg_temp.check_true((select count(*)=0 from schedule_assignments),'anonymous schedule');
select pg_temp.check_true((select count(*)=0 from storage.objects),'anonymous objects');
select pg_temp.check_write($q$select travel_can_read_trip('00000000-0000-0000-0000-000000000201')$q$,0);
select pg_temp.check_write($q$select travel_can_read_attachment('00000000-0000-0000-0000-000000000501')$q$,0);
rollback;

-- Service-role system jobs still bypass table RLS.
begin;
set local role service_role;
select pg_temp.check_true((select count(*)=3 from trips),'service role trips');
select pg_temp.check_write($q$update schedule_assignments set note='system'$q$,1);
rollback;

-- Existing delivery creation and rescheduling retain one assignment and replace
-- its roster in the same transaction, not a duplicate calendar entry.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',true);
select schedule_delivery('00000000-0000-0000-0000-000000000801','2026-09-09 08:00Z',array['00000000-0000-0000-0000-000000000001']::uuid[]);
select schedule_delivery('00000000-0000-0000-0000-000000000801','2026-09-10 09:00Z',array['00000000-0000-0000-0000-000000000002']::uuid[]);
select pg_temp.check_true((select count(*)=1 from schedule_assignments where delivery_id is not null),'delivery idempotent identity');
select pg_temp.check_true((select count(*)=1 from schedule_assignment_members m join schedule_assignments a on a.id=m.assignment_id where a.delivery_id is not null and m.profile_id='00000000-0000-0000-0000-000000000002'),'delivery replaced crew');
select pg_temp.check_true((select expected_at='2026-09-10 09:00Z'::timestamptz from package_deliveries),'delivery date updated');
rollback;
