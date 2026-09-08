-- Later delivery columns and partner policy sweep, reduced to the tables under
-- test. Schedule/Travel tables and their original policies come from the actual
-- committed migrations, not copies of the proposed replacement policies.
create table public.package_deliveries (id uuid primary key, label text, expected_at timestamptz);
alter table schedule_assignments alter column project_id drop not null;
alter table schedule_assignments add column created_via text;
alter table vehicle_project_assignments add column assigned_at timestamptz default now();
alter table schedule_assignments add column kind text default 'install';
alter table schedule_assignments add column delivery_id uuid references package_deliveries(id);
alter table vehicle_project_assignments add foreign key (assignment_id) references schedule_assignments(id) on delete cascade;
do $$ declare p record; begin
 for p in select * from pg_policies where schemaname='public' loop
  execute format('alter policy %I on public.%I using (not public.is_partner_user() and (%s))%s',
   p.policyname,p.tablename,p.qual,
   case when p.with_check is not null then format(' with check (not public.is_partner_user() and (%s))',p.with_check) else '' end);
 end loop;
end $$;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
grant all on all tables in schema public,storage to anon,authenticated,service_role;

insert into profiles(id,role,is_partner) values
 ('00000000-0000-0000-0000-000000000001','installer',false),
 ('00000000-0000-0000-0000-000000000002','installer',false),
 ('00000000-0000-0000-0000-000000000003','foreman',false),
 ('00000000-0000-0000-0000-000000000004','supervisor',false),
 ('00000000-0000-0000-0000-000000000005','owner',false),
 ('00000000-0000-0000-0000-000000000006','supervisor',true),
 ('00000000-0000-0000-0000-000000000007','admin',false),
 ('00000000-0000-0000-0000-000000000008','big_boss',false),
 ('00000000-0000-0000-0000-000000000009','unexpected-role',false);
insert into projects values ('00000000-0000-0000-0000-000000000101');
insert into trips(id,name,start_date,end_date,status) values
 ('00000000-0000-0000-0000-000000000201','Published','2026-09-01','2026-09-10','published'),
 ('00000000-0000-0000-0000-000000000202','Draft','2026-09-01','2026-09-10','draft'),
 ('00000000-0000-0000-0000-000000000203','Other trip','2026-09-01','2026-09-10','published');
insert into trip_crew(trip_id,profile_id)
 select t.id,p.id from trips t cross join profiles p
 where (right(t.id::text,3) in ('201','202') and right(p.id::text,3) in ('001','002','003'))
 or (right(t.id::text,3)='203' and right(p.id::text,3)='002');
insert into flights(id,trip_id,profile_id) values
 ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000303','00000000-0000-0000-0000-000000000201',null),
 ('00000000-0000-0000-0000-000000000304','00000000-0000-0000-0000-000000000202',null),
 ('00000000-0000-0000-0000-000000000305','00000000-0000-0000-0000-000000000203',null);
insert into lodging(id,trip_id,name) select
 ('00000000-0000-0000-0000-000000000'||(400+row_number() over(order by id))::text)::uuid,id,name from trips;
insert into ground_transport(trip_id) select id from trips;
insert into procedures(trip_id,title) select id,name from trips;
insert into procedures(title) values ('Company template');
insert into trip_contacts(trip_id,name) select id,name from trips;
insert into trip_attachments(id,trip_id,flight_id,lodging_id,storage_path) values
 ('00000000-0000-0000-0000-000000000501','00000000-0000-0000-0000-000000000201',null,null,'00000000-0000-0000-0000-000000000201/shared.pdf'),
 ('00000000-0000-0000-0000-000000000502','00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000301',null,'00000000-0000-0000-0000-000000000201/mine.pdf'),
 ('00000000-0000-0000-0000-000000000503','00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000302',null,'00000000-0000-0000-0000-000000000201/other.pdf'),
 ('00000000-0000-0000-0000-000000000504','00000000-0000-0000-0000-000000000202',null,null,'00000000-0000-0000-0000-000000000202/draft.pdf'),
 ('00000000-0000-0000-0000-000000000505','00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000305',null,'00000000-0000-0000-0000-000000000201/cross-flight.pdf'),
 ('00000000-0000-0000-0000-000000000506','00000000-0000-0000-0000-000000000201',null,'00000000-0000-0000-0000-000000000403','00000000-0000-0000-0000-000000000201/cross-lodging.pdf'),
 ('00000000-0000-0000-0000-000000000507','00000000-0000-0000-0000-000000000201',null,null,'00000000-0000-0000-0000-000000000203/wrong-folder.pdf'),
 ('00000000-0000-0000-0000-000000000508','00000000-0000-0000-0000-000000000203',null,null,'00000000-0000-0000-0000-000000000203/other-trip.pdf');
insert into storage.objects(bucket_id,name) select 'trip-attachments',storage_path from trip_attachments;
insert into storage.objects(bucket_id,name) values ('trip-attachments','orphan.pdf');
insert into schedule_assignments(id,project_id,start_date,end_date) values
 ('00000000-0000-0000-0000-000000000601','00000000-0000-0000-0000-000000000101','2026-09-01','2026-09-10');
insert into schedule_assignment_members(assignment_id,profile_id,role) values
 ('00000000-0000-0000-0000-000000000601','00000000-0000-0000-0000-000000000001','installer');
insert into schedule_events(assignment_id,kind) values ('00000000-0000-0000-0000-000000000601','created');
insert into vehicle_project_assignments(id,project_id,assignment_id) values
 ('00000000-0000-0000-0000-000000000701','00000000-0000-0000-0000-000000000101',null),
 ('00000000-0000-0000-0000-000000000702','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000601');
insert into package_deliveries values ('00000000-0000-0000-0000-000000000801','Fixture delivery',null);
