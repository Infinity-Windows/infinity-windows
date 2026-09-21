// Actual migration and authenticated PostgreSQL permissions; no live records.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE??'@electric-sql/pglite');
const db=new PGlite();
await db.exec(`create role authenticated; create role anon; create role service_role;create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,rank integer,role text,is_partner boolean default false,active boolean default false,retired_at timestamptz,access_revoked_at timestamptz);
create function my_role_rank() returns integer language sql stable security definer as $$select rank from profiles where id=auth.uid()$$;
insert into profiles(id,rank,role) select ('00000000-0000-4000-8000-00000000000'||i)::uuid,i-1,(array['installer','foreman','supervisor','owner'])[i] from generate_series(1,4) i;
`);
await db.exec(await readFile(new URL('../supabase/migrations/20261021000000_role_scoped_app_updates.sql',import.meta.url),'utf8'));
// Seed dates refer to release day; the fixture works even before that date.
await db.exec("update app_release_notes set published_on=current_date");
async function role(n){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[`00000000-0000-4000-8000-00000000000${n}`]);await db.exec('set role authenticated');}
async function ids(){return(await db.query('select id from app_release_notes order by id')).rows.map(n=>n.id);}
await role(1);assert.equal((await ids()).length,3);assert(!(await ids()).includes('2026-09-21-leave-review'));
await assert.rejects(()=>db.exec("insert into app_release_notes select * from app_release_notes"));
await assert.rejects(()=>db.exec("update app_release_notes set audience=array[0]"));
await assert.rejects(()=>db.exec("delete from app_release_notes"));
await role(2);assert.equal((await ids()).length,4);
await role(3);assert.equal((await ids()).length,5);
await role(4);assert.equal((await ids()).length,5);
for(const condition of ['is_partner=true','retired_at=now()','access_revoked_at=now()']){
 await db.exec('reset role');await db.exec(`update profiles set is_partner=false,retired_at=null,access_revoked_at=null; update profiles set ${condition} where rank=3;`);await role(4);assert.equal((await ids()).length,0);
}
await db.exec('reset role');await db.exec("update profiles set access_revoked_at=null;update app_release_notes set withdrawn_at=now() where id='2026-09-21-photos';update app_release_notes set published_on=current_date+1 where id='2026-09-21-voice'");
await role(1);assert.equal((await ids()).length,1);
await db.exec('reset role');await db.exec("update profiles set role='unknown' where rank=0");await role(1);assert.equal((await ids()).length,0);
await db.exec('reset role');await db.exec('set role anon');await assert.rejects(()=>db.exec('select * from app_release_notes'));
await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',false);set role authenticated;");assert.equal((await ids()).length,0);
console.log('App updates: role audiences, off-site access, revoked/retired/partner denial, withdrawn/future notes and read-only grants passed.');await db.close();
