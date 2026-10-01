-- Disposable PostgreSQL fixture; platform stubs match the existing AI regression harness.

create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,partner boolean default false,display_name text,retired_at timestamptz,access_revoked_at timestamptz,is_test boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz,name text,job_code text,address text,is_test boolean default false,allowed_modes text[] default '{data}',created_at timestamptz default now());
create table project_pipeline(project_id uuid primary key references projects on delete cascade,ready_state text not null default 'ready',updated_at timestamptz,updated_by uuid);
create table window_types(id uuid primary key,name text,width_in numeric,height_in numeric);
create table project_mark_specs(project_id uuid,mark_code text,style text,operation text,width_in int,height_in int);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz,opening_code text,label text,window_type_id uuid,assigned_to uuid,assigned_by uuid,assigned_at timestamptz);
create table opening_assignment_events(opening_id uuid,from_profile uuid,to_profile uuid,changed_by uuid,via text);
create function log_assignment() returns trigger language plpgsql security definer as $$begin if new.assigned_to is distinct from old.assigned_to then insert into opening_assignment_events values(new.id,old.assigned_to,new.assigned_to,auth.uid(),case when new.assigned_to is null then 'unassign' else coalesce(nullif(current_setting('app.assignment_via',true),''),'dispatch') end); end if; return new; end$$;
create trigger log_assignment after update of assigned_to on project_openings for each row execute function log_assignment();
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid,opening_id uuid,started_at timestamptz default now(),ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid references profiles on delete cascade,opening_id uuid,state text default 'on_task',started_at timestamptz default now(),ended_at timestamptz);
create table opening_phases(id uuid primary key default gen_random_uuid(),opening_id uuid,started_by uuid,status text,paused_at timestamptz);
create table project_messages(id uuid primary key default gen_random_uuid(),project_id uuid,author_id uuid,body text,mentions uuid[]);
create table service_job_supervisors(project_id uuid,profile_id uuid);
create table sandbox_projects(project_id uuid primary key);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,owner uuid default auth.uid(),created_at timestamptz default now(),primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to authenticated;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql stable as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$select exists(select 1 from profiles where id=p and role in ('supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
-- Same semantics as guard_test_account_sandbox_only for project_id tables and projects.id.
create function guard_stub() returns trigger language plpgsql security definer as $$
declare pid uuid; begin
  if auth.uid() is null or not is_test_profile(auth.uid()) then return coalesce(new,old); end if;
  pid := case when tg_table_name='projects' then (to_jsonb(coalesce(new,old))->>'id')::uuid else (to_jsonb(coalesce(new,old))->>'project_id')::uuid end;
  if not is_sandbox_project(pid) then raise exception 'This is a test login. It can only change the automation sandbox job, not a real one.' using errcode='42501'; end if;
  return coalesce(new,old); end $$;
create function attach_sandbox_guards() returns void language plpgsql as $$
declare t text; begin
  for t in select table_name::text from information_schema.columns c join information_schema.tables x using(table_schema,table_name)
    where c.table_schema='public' and c.column_name='project_id' and x.table_type='BASE TABLE' and table_name<>'sandbox_projects' union select 'projects' loop
    execute format('drop trigger if exists zz_sandbox on public.%I', t);
    execute format('create trigger zz_sandbox before insert or update or delete on public.%I for each row execute function guard_stub()', t);
  end loop; end $$;
-- The real end_break closes the break into break_seconds.
create function end_break(p uuid) returns time_shifts language sql security definer as $$
  update time_shifts set break_seconds=coalesce(break_seconds,0)+extract(epoch from now()-break_started_at)::int,break_started_at=null where id=p returning *$$;
grant select on profiles,projects to authenticated;

alter table profiles add column is_partner boolean generated always as (partner) stored;
create table app_release_notes(id text primary key,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);
create table ai_spend_limits(id int primary key,min_role text not null default 'foreman',monthly_cap_cents int default 15000,per_user_daily_calls int default 40,enforced boolean default true,updated_at timestamptz);
insert into ai_spend_limits(id) values(1);
create table points_ledger(id uuid primary key,profile_id uuid,kind text,points int,ref text,status text);
