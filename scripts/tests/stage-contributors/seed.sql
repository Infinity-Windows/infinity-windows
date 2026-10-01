insert into profiles(id,role,active,display_name) values
 ('00000000-0000-4000-8000-000000000001','foreman',false,'Fixture Foreman A'),
 ('00000000-0000-4000-8000-000000000007','foreman',true,'Fixture Foreman B'),
 ('00000000-0000-4000-8000-000000000002','installer',false,'Fixture Worker A'),
 ('00000000-0000-4000-8000-000000000003','installer',true,'Fixture Worker B'),
 ('00000000-0000-4000-8000-000000000004','installer',true,'Fixture Worker C');
insert into projects(id,name,job_code,is_test) values('00000000-0000-4000-8000-000000000010','Contributor fixture','FIXTURE',false);
insert into project_openings(id,project_id,opening_code,status,assigned_to) values
 ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010','Concurrent opening','planned','00000000-0000-4000-8000-000000000002'),
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000010','Timed existing opening','installed','00000000-0000-4000-8000-000000000003');
insert into custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts,revision) values
 ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001','Existing timed unit','Fixed window','{"installation_complete":"Yes","note":"Original evidence"}',3);
insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status,break_seconds) values
 ('00000000-0000-4000-8000-000000000080','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000010',now()-interval '3 hours',now()-interval '1 hour','approved',900);
insert into custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,stage,started_at,ended_at,outcome,shift_status) values
 ('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000080','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000040','unit','Installing',now()-interval '2 hours',now()-interval '1 hour','finished','approved');
insert into unit_sessions(profile_id,opening_id,started_at,ended_at,end_reason) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000021',now()-interval '2 hours',now()-interval '1 hour','finish');
insert into task_sessions(profile_id,opening_id,state) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000021','done');
insert into opening_phases(opening_id,started_by,status) values('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000003','submitted');
insert into points_ledger values('00000000-0000-4000-8000-000000000082','00000000-0000-4000-8000-000000000003','fixture',42,'Preserved points','approved');
create table fixture_preserved(table_name text primary key,rows jsonb);
do $$ declare t text; begin
 foreach t in array array['profiles','time_shifts','custom_work_sessions','unit_sessions','task_sessions','opening_phases','points_ledger','project_openings','opening_assignment_events'] loop
  execute format('insert into fixture_preserved select %L,coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]''::jsonb) from public.%I x',t,t);
 end loop;
 insert into fixture_preserved select 'saved_unit',to_jsonb(u) from custom_work_units u where id='00000000-0000-4000-8000-000000000040';
end $$;
