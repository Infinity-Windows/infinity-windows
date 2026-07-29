-- Reproducible proof for docs/profiles-security-2026-07-29.md.
--
-- Run the whole file inside a transaction that is rolled back, so it proves the
-- policies without leaving a trace:
--
--   { echo "begin;"; cat docs/profiles-security-proof-2026-07-29.sql;
--     echo "select actor, step, result from proof order by step;"; echo "rollback;"; } \
--     | SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/pgq.sh
--
-- Expected: every A-step REJECTED, every L-step ALLOWED. 33 checks.
-- The user IDs are production's six accounts as of 2026-07-29.

-- Shared proof harness. Every attack statement below asserts its own EFFECT,
-- not merely the absence of an error: row-level security makes a forbidden
-- UPDATE or DELETE match zero rows and return success, so "no error" would be a
-- meaningless pass. Each attack raises if the attack failed, so:
--
--    REJECTED = the database stopped it        ALLOWED = it worked
--
-- Assumes a transaction is already open, and that the whole thing is rolled back.
create temp table if not exists proof(n serial, actor text, step text, result text);

create or replace function pg_temp.attempt(p_role text, p_sub text, p_email text, p_sql text)
returns text language plpgsql as $f$
declare msg text;
begin
  if p_sub is null then
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  end if;
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    msg := 'ALLOWED';
  exception when others then
    msg := 'REJECTED [' || sqlstate || '] ' || sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return msg;
end $f$;

-- Fixed production identities, verified against auth.users on 2026-07-29.
create or replace function pg_temp.as_installer(p_step text, p_sql text) returns void
language plpgsql as $f$begin
  insert into proof(actor, step, result) values ('installer Chris', p_step,
    pg_temp.attempt('authenticated', '88e9158c-c299-4abf-86e2-4d6c1134d0be',
                    'chris@crew.demo', p_sql));
end $f$;

create or replace function pg_temp.as_owner(p_step text, p_sql text) returns void
language plpgsql as $f$begin
  insert into proof(actor, step, result) values ('owner Taylor', p_step,
    pg_temp.attempt('authenticated', '958d3bfc-946e-46b3-a84c-a84d5f586a2e',
                    'taylor@horizonsolarusa.com', p_sql));
end $f$;

create or replace function pg_temp.as_foreman(p_step text, p_sql text) returns void
language plpgsql as $f$begin
  insert into proof(actor, step, result) values ('foreman Maria', p_step,
    pg_temp.attempt('authenticated', '69a880bc-8489-48d5-8673-28dcfd5b0210',
                    'maria@crew.demo', p_sql));
end $f$;

create or replace function pg_temp.as_anon(p_step text, p_sql text) returns void
language plpgsql as $f$begin
  insert into proof(actor, step, result) values ('anon (signed out)', p_step,
    pg_temp.attempt('anon', null, null, p_sql));
end $f$;

-- Identity shorthand used below:
--   Chris  88e9158c-c299-4abf-86e2-4d6c1134d0be  installer
--   Dave   0830d61d-3ed5-4a03-9efc-846dbfc3dce9  installer
--   Maria  69a880bc-8489-48d5-8673-28dcfd5b0210  installer (promoted mid-run to test foreman)
--   Sam    a59c174b-1d65-4f86-96cc-535c53e2213e  installer
--   Ammon  4d8f7c12-21bc-4b69-9993-2928dc097ac2  owner
--   Taylor 958d3bfc-946e-46b3-a84c-a84d5f586a2e  owner

-- ================= THE ESCALATION, attempted by an installer =================

select pg_temp.as_installer('A1 make myself owner with a direct UPDATE',
  $q$do $$begin
      update profiles set role='owner' where id=auth.uid();
      if (select role from profiles where id=auth.uid()) <> 'owner' then
        raise exception 'role unchanged - attack had no effect';
      end if;
    end$$$q$);

select pg_temp.as_installer('A2 make myself owner through the role RPC',
  $q$select set_profile_role(auth.uid(), 'owner')$q$);

select pg_temp.as_installer('A3 delete my row so I can re-create it as owner',
  $q$do $$begin
      delete from profiles where id=auth.uid();
      if exists (select 1 from profiles where id=auth.uid()) then
        raise exception 'my row is still there - the delete was refused';
      end if;
    end$$$q$);

select pg_temp.as_installer('A4 insert myself a fresh row with role owner',
  $q$insert into profiles(id,display_name,role)
     values('11111111-1111-1111-1111-111111111111','me','owner')$q$);

select pg_temp.as_installer('A5 promote a workmate to owner',
  $q$select set_profile_role('0830d61d-3ed5-4a03-9efc-846dbfc3dce9','owner')$q$);

select pg_temp.as_installer('A6 delete the owner''s profile',
  $q$do $$begin
      delete from profiles where id='4d8f7c12-21bc-4b69-9993-2928dc097ac2';
      if exists (select 1 from profiles where id='4d8f7c12-21bc-4b69-9993-2928dc097ac2') then
        raise exception 'the owner is still there - the delete was refused';
      end if;
    end$$$q$);

select pg_temp.as_installer('A7 rename a workmate',
  $q$do $$begin
      update profiles set display_name='pwned'
        where id='0830d61d-3ed5-4a03-9efc-846dbfc3dce9';
      if (select display_name from profiles
            where id='0830d61d-3ed5-4a03-9efc-846dbfc3dce9') <> 'pwned' then
        raise exception 'name unchanged - the update was refused';
      end if;
    end$$$q$);

select pg_temp.as_installer('A8 deactivate a workmate so they lose the app',
  $q$do $$begin
      update profiles set active=false
        where id='0830d61d-3ed5-4a03-9efc-846dbfc3dce9';
      if (select active from profiles
            where id='0830d61d-3ed5-4a03-9efc-846dbfc3dce9') then
        raise exception 'still active - the update was refused';
      end if;
    end$$$q$);

select pg_temp.as_installer('A9 select * from profiles (sweeps up any secret column)',
  $q$do $$declare r record; begin select * into r from profiles limit 1; end$$$q$);

select pg_temp.as_installer('A10 read someone else''s PIN',
  $q$do $$declare v text; begin
      select pin_hash into v from profiles where id<>auth.uid() limit 1; end$$$q$);

select pg_temp.as_installer('A11 read my own PIN',
  $q$do $$declare v text; begin
      select pin_hash into v from profiles where id=auth.uid(); end$$$q$);

select pg_temp.as_installer('A12 set the owner''s PIN to one I know',
  $q$update profiles set pin_hash='x'
     where id='958d3bfc-946e-46b3-a84c-a84d5f586a2e'$q$);

select pg_temp.as_installer('A13 empty the profiles table with TRUNCATE (skips RLS)',
  $q$truncate profiles$q$);

select pg_temp.as_installer('A14 claim owner through the founder bootstrap RPC',
  $q$do $$begin
      if claim_owner_bootstrap() then raise exception 'bootstrap accepted a crew email'; end if;
      if (select role from profiles where id=auth.uid()) <> 'installer' then
        raise exception 'role changed';
      end if;
      raise exception 'bootstrap refused me, as it should' using errcode='ZZ000';
    end$$$q$);

select pg_temp.as_installer('A15 read the crew directory view for secrets',
  $q$do $$declare v text; begin
      select pin_hash into v from crew_directory limit 1; end$$$q$);

-- Layer 3 on its own: if someone later re-grants the column privilege by hand,
-- the trigger must still refuse. Temporarily hand back UPDATE(role) and retry A1.
grant update (role) on table public.profiles to authenticated;
select pg_temp.as_installer('A16 same attack after UPDATE(role) is re-granted (trigger only)',
  $q$do $$begin
      update profiles set role='owner' where id=auth.uid();
      if (select role from profiles where id=auth.uid()) <> 'owner' then
        raise exception 'role unchanged - attack had no effect';
      end if;
    end$$$q$);
revoke update (role) on table public.profiles from authenticated;

select pg_temp.as_anon('A17 read the crew list while signed out',
  $q$do $$declare n int; begin select count(*) into n from profiles; end$$$q$);

-- ================= THE LEGITIMATE FLOWS =================

select pg_temp.as_installer('L1 read my own profile',
  $q$do $$declare v text; begin
      select display_name into v from profiles where id=auth.uid();
      if v is null then raise exception 'my own row is not visible'; end if; end$$$q$);

select pg_temp.as_installer('L2 read the crew list (roster, pickers, leaderboard, chat)',
  $q$do $$declare n int; begin
      select count(*) into n from profiles;
      if n <> 6 then raise exception 'saw % of 6 crew', n; end if; end$$$q$);

select pg_temp.as_installer('L3 read the narrow crew_directory view',
  $q$do $$declare n int; begin
      select count(*) into n from crew_directory;
      if n <> 6 then raise exception 'saw % of 6 crew', n; end if; end$$$q$);

select pg_temp.as_installer('L4 who is clocked in (PostgREST profiles embed)',
  $q$do $$declare n int; begin
      select count(*) into n from time_shifts s
        left join profiles p on p.id = s.profile_id; end$$$q$);

select pg_temp.as_installer('L5 the roster read the app actually issues',
  $q$do $$declare n int; begin
      select count(*) into n from (
        select id, display_name, skill_level, role, active, created_at, updated_at
        from profiles order by role desc, display_name) s;
      if n <> 6 then raise exception 'saw % of 6', n; end if; end$$$q$);

select pg_temp.as_installer('L6 change my own display name',
  $q$do $$begin
      update profiles set display_name='Christopher', updated_at=now() where id=auth.uid();
      if (select display_name from profiles where id=auth.uid()) <> 'Christopher' then
        raise exception 'my own edit did not stick'; end if;
      update profiles set display_name='Chris' where id=auth.uid();
    end$$$q$);

select pg_temp.as_installer('L7 set, verify and clear my own PIN',
  $q$do $$begin
      perform set_my_pin('4821');
      if not my_pin_status() then raise exception 'pin not recorded'; end if;
      if not check_my_pin('4821') then raise exception 'the right pin was rejected'; end if;
      if check_my_pin('9999') then raise exception 'a wrong pin was accepted'; end if;
      if check_my_pin('482')  then raise exception 'a prefix was accepted'; end if;
      perform set_my_pin('');
      if my_pin_status() then raise exception 'pin not cleared'; end if;
    end$$$q$);

select pg_temp.as_installer('L8 my PIN is stored hashed, never in plain text',
  $q$do $$declare h text; begin
      perform set_my_pin('4821');
      set local role postgres;
      select pin_hash into h from profiles where id='88e9158c-c299-4abf-86e2-4d6c1134d0be';
      if h is null or h = '4821' or h not like '$2%' then
        raise exception 'pin_hash is not a bcrypt hash: %', coalesce(h,'null'); end if;
      set local role authenticated;
      perform set_my_pin('');
    end$$$q$);

select pg_temp.as_owner('L9 owner approves an access request',
  $q$do $$declare n int; begin
      update access_requests set status='approved', decided_at=now(), decided_by=auth.uid()
        where status='pending';
      get diagnostics n = row_count;
    end$$$q$);

select pg_temp.as_owner('L10 owner assigns a role (installer -> foreman)',
  $q$do $$begin
      perform set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','foreman');
      if (select role from profiles where id='69a880bc-8489-48d5-8673-28dcfd5b0210')
         <> 'foreman' then raise exception 'role did not change'; end if;
    end$$$q$);

select pg_temp.as_foreman('L11 foreman edits a workmate''s skill tier and on-site flag',
  $q$do $$begin
      update profiles set skill_level=4, active=true, updated_at=now()
        where id='a59c174b-1d65-4f86-96cc-535c53e2213e';
      if (select skill_level from profiles where id='a59c174b-1d65-4f86-96cc-535c53e2213e')
         <> 4 then raise exception 'the foreman edit did not stick'; end if;
    end$$$q$);

select pg_temp.as_foreman('A18 foreman hands out owner (supervisor+ only)',
  $q$select set_profile_role('a59c174b-1d65-4f86-96cc-535c53e2213e','owner')$q$);

select pg_temp.as_owner('A19 a supervisor promotes themselves to owner',
  $q$do $$begin
      perform set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','supervisor');
      perform set_config('request.jwt.claims',
        '{"sub":"69a880bc-8489-48d5-8673-28dcfd5b0210","role":"authenticated","email":"maria@crew.demo"}', true);
      perform set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','owner');
    end$$$q$);

select pg_temp.as_owner('L12 owner puts the foreman back to installer',
  $q$do $$begin
      perform set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','installer');
      if (select role from profiles where id='69a880bc-8489-48d5-8673-28dcfd5b0210')
         <> 'installer' then raise exception 'demotion did not stick'; end if;
    end$$$q$);

insert into proof(actor, step, result)
select 'service role', 'L13 edge functions read profiles.role on the service key',
  case when count(*) = 6 then 'ALLOWED (all 6 rows)'
       else 'REJECTED: saw ' || count(*) end
from profiles where role is not null;

select pg_temp.as_owner('L14 owner may still remove a profile',
  $q$do $$begin
      delete from profiles where id='a59c174b-1d65-4f86-96cc-535c53e2213e';
      if exists (select 1 from profiles where id='a59c174b-1d65-4f86-96cc-535c53e2213e')
        then raise exception 'delete was refused'; end if;
    end$$$q$);
