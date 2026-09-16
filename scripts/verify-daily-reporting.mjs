// Real PostgreSQL roles against disposable records. No network or crew data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key, role text, active boolean default true, access_revoked_at timestamptz, partner boolean default false);
create table projects(id uuid primary key, deleted_at timestamptz);
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function my_role_rank() returns int language sql stable security definer as $$select case role when 'foreman' then 1 when 'supervisor' then 2 when 'owner' then 3 else 0 end from profiles where id=auth.uid()$$;
create function _is_lead(p uuid) returns boolean language sql stable security definer as $$select coalesce((select role in ('foreman','supervisor','owner') from profiles where id=p),false)$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$select coalesce((select role in ('supervisor','owner') from profiles where id=p),false)$$;
`);
const source = name => readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
await db.exec(await source('20260949000000_daily_logs.sql'));
await db.exec(await source('20260951000000_share_with_builder.sql'));
const migration = await source('20261014000000_installer_daily_reporting.sql');
await db.exec(migration);
await db.exec(migration);
// Give table privileges so RLS, not a missing grant, decides direct access.
await db.exec('grant select,insert,update,delete on daily_logs to authenticated');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const roles=['installer','foreman','supervisor','owner','installer','installer','unknown','installer','lead','admin','big_boss','owner'];
for(let i=0;i<roles.length;i++) await db.query('insert into profiles(id,role,active,access_revoked_at,partner) values($1,$2,$3,$4,$5)',[id(i+1),roles[i],i!==7,i===5?'2026-01-01T00:00:00Z':null,[4,11].includes(i)]);
await db.query('insert into projects values($1,null),($2,now())',[id(90),id(91)]);
let checks=0;
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
async function user(n){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('set role authenticated');}
async function denied(fn){await assert.rejects(fn);checks++;}
async function file(notes='Finished frames',day="current_date - 1",project=id(90),flow='fine'){
  return (await db.query(`select * from file_daily_log($1,${day},p_notes=>$2,p_day_flow=>$3)`,[project,notes,flow])).rows[0];
}
for(const actor of [1,2,3,4,8,9,10,11]){
  await user(actor);equal((await db.query('select can_file_daily_log() ok')).rows[0].ok,true);
}
await user(1);
const first=await file('  Finished frames  ');
equal(first.filed_by,id(1));equal(first.updated_by,null);equal(first.notes,'Finished frames');equal(first.customer_visible,false);
await user(2);const updated=await file('Foreman adds a detail');equal(updated.id,first.id);equal(updated.filed_by,id(1));equal(updated.updated_by,id(2));
await user(1);equal((await file('Installer adds a detail')).updated_by,id(1));
equal((await db.query('select count(*)::int n from daily_logs')).rows[0].n,1);
await denied(()=>db.query('select set_log_customer_visible($1,true)',[first.id]));
await user(2);await denied(()=>db.query('select set_log_customer_visible($1,true)',[first.id]));
await user(3);equal((await db.query('select * from set_log_customer_visible($1,true)',[first.id])).rows[0].customer_visible,true);
await user(1);equal((await file()).customer_visible,true);
for(const actor of [0,5,6,7,12,99]){
  await user(actor);equal((await db.query('select can_file_daily_log() ok')).rows[0].ok,false);
  equal((await db.query('select count(*)::int n from daily_logs')).rows[0].n,0);
  await denied(()=>file('Must not save'));
}
await user(1);
for(const note of [null,'  ']) await denied(()=>file(note));
await denied(()=>file('Future','current_date + 1'));
await denied(()=>file('No date','null'));
await denied(()=>file('No project',undefined,null));
await denied(()=>file('Removed project',undefined,id(91)));
await denied(()=>file('Missing project',undefined,id(92)));
await denied(()=>file('Bad day flow',undefined,undefined,'unknown'));
await denied(()=>db.query('insert into daily_logs(project_id,log_date,notes,filed_by) values($1,current_date,$2,$3)',[id(90),'Bypass',id(1)]));
equal((await db.query("update daily_logs set notes='Bypass' returning id")).rows.length,0);
equal((await db.query('delete from daily_logs returning id')).rows.length,0);
await user(8);equal((await file('Not on site today, still allowed to report','current_date - 2')).filed_by,id(8));
await db.exec('reset role; set role anon');
await denied(()=>db.query('select can_file_daily_log()'));
await denied(()=>file());
await db.close();
console.log(`${checks} daily reporting database checks passed.`);
