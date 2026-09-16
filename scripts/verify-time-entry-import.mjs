// Synthetic payroll only. Real generated import SQL and provenance migration,
// executed in disposable PostgreSQL with no production credentials or network.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const fixture = JSON.parse(execFileSync('python3',['scripts/test_time_entry_import.py','--sql-fixture'],{encoding:'utf8'}));
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
create table profiles(id uuid primary key,display_name text,role text,is_test boolean default false);
create table projects(id uuid primary key,job_code text,name text,deleted_at timestamptz,is_test boolean default false);
create table cost_codes(id uuid primary key,code text unique,label text,active boolean default true);
create table time_shifts(id uuid primary key,profile_id uuid references profiles,project_id uuid references projects,cost_code_id uuid references cost_codes,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int,status text,note text);
create table cleanup_calls(profile_id uuid);
create function _close_stale_sessions(p uuid) returns void language sql as $$insert into cleanup_calls values(p)$$;
grant usage on schema public,auth to authenticated,anon;
grant select,insert,update on time_shifts to authenticated,anon;
`);
const migration = await readFile(new URL('../supabase/migrations/20261013000000_time_entry_import_provenance.sql',import.meta.url),'utf8');
await db.exec(migration); await db.exec(migration);
await db.exec('create trigger unit_sessions_on_clock_in after insert on time_shifts for each row execute function unit_sessions_on_clock_in()');
const p=fixture.payload, entry=p.entries[0];
for(const row of p.profiles) await db.query('insert into profiles(id,display_name,role) values($1,$2,$3)',[row.id,row.display_name,'installer']);
for(const row of p.cost_codes) await db.query('insert into cost_codes(id,code,label) values($1,$2,$3)',[row.id,row.code,row.label]);
let checks=0;
async function rows(sql,args=[]) { return (await db.query(sql,args)).rows; }
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
async function refused(sql,pattern) { await assert.rejects(()=>db.exec(sql),pattern); await db.exec('rollback; reset role;'); checks++; }
equal((await rows('select count(*)::int n from time_shifts'))[0].n,0);
await db.exec(fixture.preview); equal((await rows('select count(*)::int n from time_shifts'))[0].n,0);
await db.exec(fixture.apply);
let saved=await rows('select *,extract(epoch from clock_out_at-clock_in_at)-break_seconds as net from time_shifts');
equal(saved.length,1); equal(saved[0].status,'submitted'); equal(saved[0].break_seconds,1800); equal(Number(saved[0].net),27000);
equal(saved[0].source_import.original.Project,'Unassigned source job');
equal((await rows('select count(*)::int n from cleanup_calls'))[0].n,0);
await db.exec(fixture.apply); equal(await rows('select *,extract(epoch from clock_out_at-clock_in_at)-break_seconds as net from time_shifts'),saved);
await db.exec("set role authenticated");
await db.query('update time_shifts set note=$1 where id=$2',['Ordinary correction',entry.id]);
equal((await rows('select note from time_shifts'))[0].note,'Ordinary correction');
await refused("update time_shifts set source_import=null",/import service/);
await db.exec('set role anon'); await refused("update time_shifts set source_import_key=null",/import service/);
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[entry.profile_id]);
await refused("update time_shifts set source_import_key=null",/import service/); // security-definer calls retain real identity.
await db.exec("select set_config('request.jwt.claim.sub','',false)");
await refused("update time_shifts set source_import='{}'::jsonb",/incomplete/);
await db.query("insert into time_shifts(id,profile_id,clock_in_at,clock_out_at,break_seconds,status) values('00000000-0000-4000-8000-000000000099',$1,'2026-09-02T14:00Z','2026-09-02T15:00Z',0,'submitted')",[entry.profile_id]);
equal((await rows('select count(*)::int n from cleanup_calls'))[0].n,1);
await db.query('delete from time_shifts where id=$1',[entry.id]);
await refused(fixture.apply,/snapshot changed/); equal((await rows('select count(*)::int n from time_shifts'))[0].n,1);
await db.exec('truncate time_shifts');
await db.exec("update profiles set display_name='Renamed fixture employee'");
await refused(fixture.apply,/Employee mapping changed/); equal((await rows('select count(*)::int n from time_shifts'))[0].n,0);
await db.query('update profiles set display_name=$1',[p.profiles[0].display_name]);
// Verify no partial insert can survive even a trigger that changes the saved hours.
await db.exec(`create function corrupt_fixture() returns trigger language plpgsql as $$begin new.break_seconds=0; return new;end;$$;
create trigger corrupt_fixture before insert on time_shifts for each row execute function corrupt_fixture();`);
await refused(fixture.apply,/differs from reviewed plan/); equal((await rows('select count(*)::int n from time_shifts'))[0].n,0);
console.log(`${checks} disposable import database checks passed.`);
await db.close();
