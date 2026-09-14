process.on('uncaughtException', e => { console.error(e.message, e.detail ?? '', e.where ?? '', e.stack?.split('\n').slice(-3).join('\n') ?? ''); process.exit(1); });
// Disposable database proof: no production URL, token, or network database.
// PGLITE_MODULE=/tmp/forge-execution-db-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-stg-warehouse.mjs
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const migration = await readFile(new URL('../supabase/migrations/20261010000000_stg_warehouse_portal.sql', import.meta.url), 'utf8');
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create schema storage;
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;
create policy fixture_bucket_access on storage.objects for all to authenticated using(true) with check(true);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,is_partner boolean default false,active boolean default true);
create function is_partner_user() returns boolean language sql security definer set search_path=public as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function my_role_rank() returns int language sql security definer set search_path=public as $$select case role when 'owner' then 3 else 0 end from profiles where id=auth.uid()$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
create table projects(id uuid primary key,deleted_at timestamptz,materials_finalized_at timestamptz,materials_finalized_by uuid,job_code text);
create table partner_job_grants(id uuid default gen_random_uuid(),partner_profile_id uuid references profiles,project_id uuid references projects,unique(partner_profile_id,project_id));
alter table partner_job_grants enable row level security;
create table storage_containers(id uuid primary key default gen_random_uuid(),serial text,name text,kind text,active boolean default true,project_id uuid references projects,parent_container_id uuid,location_id uuid);
create table locations(id uuid primary key,address text);
create table package_deliveries(id uuid primary key default gen_random_uuid(),label text,expected_at timestamptz,created_by text);
create table schedule_assignments(delivery_id uuid,start_date date,end_date date);
create sequence serial_seq;
create table packages(id uuid primary key default gen_random_uuid(), serial text default ('PKG-'||nextval('serial_seq')),short_code text,status text check(status in ('minted','blank','received','stored','checked_out')),project_id uuid references projects,container_id uuid references storage_containers,location_id uuid,area text,note text,mfr_mark text,part_type text,part_index int,part_total int,delivery_id uuid,category text,bound_at timestamptz,bound_by text);
create table movements(id uuid primary key default gen_random_uuid(),package_id uuid references packages,event text,project_id uuid references projects,actor text,reason text,created_at timestamptz default now(),container_id uuid,from_container_id uuid,to_container_id uuid,from_location_id uuid,to_location_id uuid,undoes uuid unique,client_id uuid unique,supply_id uuid,qty numeric);
create table attachments(id uuid primary key default gen_random_uuid(),package_id uuid,project_id uuid,kind text,storage_path text,created_by text,created_at timestamptz default now(),deleted_at timestamptz,window_id uuid,install_event_id uuid);
create table issues(id uuid primary key default gen_random_uuid(),package_id uuid,project_id uuid,kind text,status text default 'open',urgency text,note text,created_by uuid,photo_path text);
create table project_marks(id uuid primary key,project_id uuid,mark_code text);
create table package_marks(package_id uuid,mark_id uuid,unique(package_id,mark_id));
create table supplies(id uuid primary key,name text,unit text,on_hand numeric);
create table supply_orders(id uuid primary key default gen_random_uuid(),project_id uuid,supply_id uuid,qty numeric,status text default 'needed',created_at timestamptz default now());
create function issue_package_short_code() returns text language sql as $$select substr(gen_random_uuid()::text,1,6)$$;
create function job_bay_box(p_project uuid) returns uuid language sql security definer as $$select id from storage_containers where project_id=p_project and kind='bay' limit 1$$;
`);
// Reconstitute the exact legacy core bodies whose early authorization is strengthened.
for (const m of migration.matchAll(/create or replace function stg_private\.(?:receive_minted_packages|checkout_packages|store_packages)\([\s\S]*?\$\$;/g)) {
  await db.exec(m[0].replace('stg_private.','public.'));
}
// Purge and account retirement are covered by repository schema tests; these
// preserved functions reference unrelated office tables outside this fixture.
await db.exec(migration.split('-- Preserve job purge behavior')[0]);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.query(`insert into profiles(id,role,is_partner) values ($1,'owner',false),($2,'installer',true),($3,'installer',true),($4,'installer',false)`,[id(1),id(2),id(3),id(4)]);
await db.query(`insert into projects(id,job_code) values ($1,'SHARED'),($2,'PRIVATE')`,[id(10),id(11)]);
await db.query(`insert into partner_job_grants(partner_profile_id,project_id) values ($1,$2)`,[id(2),id(10)]);
await db.query(`insert into storage_containers(id,serial,name,kind,project_id) values ($1,'CTR-1','Job bay','bay',$2),($3,'CTR-2','Private job name','crate',$4)`,[id(20),id(10),id(21),id(11)]);
await db.query(`insert into package_deliveries(id,label,expected_at) values($1,'Private customer manifest',now())`,[id(30)]);
await db.query(`insert into packages(id,serial,status,project_id,container_id,delivery_id) values ($1,'PKG-1','minted',$2,null,$5),($3,'PKG-SECRET','stored',$4,$6,$5),($7,'PKG-MIXED','stored',$2,$6,$5)`,[id(40),id(10),id(41),id(11),id(30),id(21),id(42)]);
await db.query(`insert into supplies values($1,'Job sealant','tube',20),($2,'Private supply','each',50)`,[id(50),id(51)]);
await db.query(`insert into supply_orders(project_id,supply_id,qty) values($1,$2,8)`,[id(10),id(50)]);
await db.query(`insert into project_marks values($1,$2,'1')`,[id(60),id(10)]);
let checks=0, seq=100, actor=null;
async function user(n) { actor=n ? id(n) : null; await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[n ? id(n) : '']); await db.exec('set role authenticated'); }
async function denied(fn) { await assert.rejects(fn); checks++; }
async function view(job=10) { return (await db.query('select stg_warehouse($1) data',[id(job)])).rows[0].data; }
async function send(action,input={},key=id(++seq),job=10) { return (await db.query('select stg_warehouse_command($1,$2,$3,$4) data',[key,id(job),action,{...input,actor}])).rows[0].data; }
function pick(w,ids) { const p=w.packages.filter(x=>ids.includes(x.id)); return {packages:p.map(x=>x.id),expected:Object.fromEntries(p.map(x=>[x.id,{status:x.status,container_id:x.container_id,location_id:x.location_id,version:x.version}]))}; }
await user(2);
const w=await view(); assert.equal(w.packages.length,2); checks++;
assert.equal(JSON.stringify(w).includes('PKG-SECRET'),false); checks++;
assert.equal(JSON.stringify(w).includes('Private customer manifest'),false); checks++;
assert.equal(JSON.stringify(w).includes('Private job name'),false); checks++;
assert.equal(JSON.stringify(w).includes('Private supply'),false); checks++;
await denied(()=>view(11));
await denied(()=>db.exec('select * from stg_private.receive_minted_packages(array[]::uuid[])'));
await denied(()=>db.query('select receive_minted_packages($1)',[[id(41)]]));
await denied(()=>send('receive',pick(w,[id(40)])));
await denied(()=>db.query('select set_partner_warehouse_permissions($1,$2)',[id(2),['receive']]));
await user(1);
await db.query('select set_partner_warehouse_permissions($1,$2)',[id(2),['receive','tag','move','checkout','arrival','damage','supplies','finalize','undo','containers','deliveries']]);checks++;
await denied(()=>view());
await user(2);
const photoPath=`packages/${id(40)}/stg/${id(2)}/${id(75)}.jpg`;
await db.query("insert into storage.objects(bucket_id,name) values('install-media',$1)",[photoPath]);checks++;
await db.query('select stg_attach_warehouse_photo($1,$2,$3)',[id(10),id(40),photoPath]);checks++;
await db.query('select stg_attach_warehouse_photo($1,$2,$3)',[id(10),id(40),photoPath]);
assert.equal((await db.query('select * from stg_warehouse_photos($1,$2)',[id(10),id(40)])).rows.length,1);checks++;
assert.equal((await db.query('select * from storage.objects')).rows.length,1);checks++;
await denied(()=>db.query("insert into storage.objects(bucket_id,name) values('install-media',$1)",[`packages/${id(41)}/stg/${id(2)}/${id(76)}.jpg`]));
await denied(()=>db.query('select stg_attach_warehouse_photo($1,$2,$3)',[id(10),id(41),photoPath]));
await denied(()=>db.query('select stg_warehouse_photos($1,$2)',[id(10),id(41)]));
assert.equal((await db.query('select * from stg_warehouse_photos($1,$2)',[id(10),id(40)])).rows.length,1);checks++;
await db.exec('reset role');await db.query("insert into storage.objects(bucket_id,name) values('private-documents','secret.pdf')");await user(2);
assert.equal((await db.query('select * from storage.objects')).rows.length,1);checks++;
assert.equal((await db.query("delete from storage.objects returning *")).rows.length,0);checks++;
let key=id(++seq); let input=pick(await view(),[id(40)]);
const first=await send('receive',input,key); assert.equal(first.count,1);checks++;
assert.deepEqual(await send('receive',input,key),first);checks++;
await denied(()=>send('checkout',input,key));
await denied(()=>send('receive',{...input,packages:[id(41)]}));
await denied(async()=>send('move',{...pick(await view(),[id(40)]),container:id(99)}));
let moved=await send('stage',pick(await view(),[id(40)]));assert.equal(moved.count,1);checks++;
assert.equal((await view()).packages.find(x=>x.id===id(40)).container_id,id(20));checks++;
let stale=pick(await view(),[id(40)]);
const checked=await send('checkout',stale);assert.equal(checked.count,1);checks++;
await denied(()=>send('stage',stale));
await denied(()=>send('undo',{command:moved.command}));
const undone=await send('undo',{command:checked.command});assert.equal(undone.count,1);checks++;
await denied(()=>send('undo',{command:checked.command}));
await denied(()=>send('finalize'));
await denied(()=>send('supplies',{supply:id(51),qty:1}));
key=id(++seq);await send('supplies',{supply:id(50),qty:2},key);await send('supplies',{supply:id(50),qty:2},key);checks++;
await send('damage',{...pick(await view(),[id(40)]),note:'Cracked corner'});checks++;
await send('tag',{mark:'1',total:2});checks++;
await denied(()=>send('tag',{mark:'foreign',total:2}));
await send('container_create',{name:'STG crate',kind:'crate'});checks++;
const crate=(await view()).containers.find(x=>x.name==='STG crate');assert.ok(crate);checks++;
await send('container_move',{container:crate.id,parent:id(20),expected_parent:null});checks++;
await denied(()=>send('container_move',{container:id(21),parent:id(20),expected_parent:null}));
await denied(()=>send('container_move',{container:crate.id,parent:id(21),expected_parent:id(20)}));
await denied(()=>send('delivery_update',{delivery:id(30),label:'Cannot change shared truck',expected_at:null,expected_before:null}));
await send('delivery_create',{...pick(await view(),[id(42)]),label:'STG load',expected_at:null});checks++;
const delivery=(await view()).deliveries.find(d=>d.label==='STG load');assert.ok(delivery);checks++;
await send('delivery_update',{delivery:delivery.id,label:'STG revised load',expected_at:'2026-09-20T12:00:00Z',expected_before:null});checks++;
await denied(()=>send('delivery_update',{delivery:delivery.id,label:'Stale edit',expected_at:null,expected_before:null}));
await db.exec('reset role');await db.query("insert into packages(id,serial,status) values($1,'PKG-BLANK','blank')",[id(70)]);await user(2);
await send('bind',{serial:'PKG-BLANK',mark:'1',part_index:1,part_total:1,part_type:'glass'});checks++;
assert.equal((await view()).packages.find(p=>p.id===id(70)).status,'received');checks++;
await denied(()=>send('bind',{serial:'PKG-SECRET',mark:'1',part_index:1,part_total:1,part_type:'glass'}));
await denied(()=>db.query('select stg_warehouse_command($1,$2,$3,$4)',[id(++seq),id(10),'receive',{actor:id(3)}]));
const onHand=(await view()).packages.filter(p=>['received','stored'].includes(p.status));
await send('checkout',pick(await view(),onHand.map(p=>p.id)));checks++;
await send('finalize');assert.ok((await view()).finalized_at);checks++;
await denied(()=>send('undo',{command:first.command}));
await send('reopen');assert.equal((await view()).finalized_at,null);checks++;
await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[id(2)]);await user(2);await denied(()=>view());
await db.exec('reset role');await db.query('update profiles set active=true where id=$1',[id(2)]);
await user(3);await denied(()=>view());await denied(()=>send('undo',{command:first.command}));
await user(1);await db.query('select set_partner_warehouse_permissions($1,$2)',[id(2),[]]);
await user(2);await denied(()=>send('receive',input,first.command));
await user(4);await db.query('select receive_minted_packages($1)',[[id(40)]]);checks++;
await db.exec('reset role');
assert.equal((await db.query('select on_hand from supplies where id=$1',[id(50)])).rows[0].on_hand,'18');checks++;
await db.query('delete from partner_job_grants where partner_profile_id=$1',[id(2)]);
await user(2);await denied(()=>view());
// PR #595's exact file helper, with only its two required tables in this fixture.
// Verify Warehouse first, then Workflow, including revocation and fail-closed
// behavior if Workflow is absent. No proposal sharing is inferred from job grants.
await db.exec('reset role');
await db.exec(`
create table proposal_partner_shares(partner_profile_id uuid,job_id uuid,document_ids uuid[]);
create table proposal_documents(id uuid,job_id uuid,ready boolean,storage_path text);
insert into storage.objects(bucket_id,name) values('proposal-files','shared.pdf'),('proposal-files','private.pdf'),('proposal-files','draft.pdf');
`);
await db.query('insert into proposal_documents values($1,$2,true,$3),($4,$2,true,$5),($6,$2,false,$7)',[id(80),id(90),'shared.pdf',id(81),'private.pdf',id(82),'draft.pdf']);
await db.query('insert into proposal_partner_shares values($1,$2,$3)',[id(2),id(90),[id(80),id(82)]]);
await user(2);
assert.equal((await db.query("select * from storage.objects where bucket_id='proposal-files'")).rows.length,0);checks++;
await db.exec('reset role');
await db.exec(`
create function public.proposal_partner_file(p_path text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_partner_user() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active)
 and exists(select 1 from public.proposal_partner_shares s join public.proposal_documents d on d.job_id=s.job_id and d.id=any(s.document_ids)
 where s.partner_profile_id=auth.uid() and d.ready and d.storage_path=p_path);
$$;
revoke all on function public.proposal_partner_file(text) from public,anon;
grant execute on function public.proposal_partner_file(text) to authenticated;
create policy "proposal shared file read" on storage.objects for select to authenticated
using(bucket_id='proposal-files' and public.is_partner_user() and public.proposal_partner_file(name));
`);
await user(2);
assert.deepEqual((await db.query("select name from storage.objects where bucket_id='proposal-files'")).rows,[{name:'shared.pdf'}]);checks++;
await denied(()=>db.query("insert into storage.objects(bucket_id,name) values('proposal-files','partner-upload.pdf')"));
await user(3);
assert.equal((await db.query("select * from storage.objects where bucket_id='proposal-files'")).rows.length,0);checks++;
await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[id(2)]);await user(2);
assert.equal((await db.query("select * from storage.objects where bucket_id='proposal-files'")).rows.length,0);checks++;
await db.exec('reset role');
await db.query('update profiles set active=true where id=$1',[id(2)]);
await db.exec('delete from proposal_partner_shares');await user(2);
assert.equal((await db.query("select * from storage.objects where bucket_id='proposal-files'")).rows.length,0);checks++;
await user(1);
assert.equal((await db.query("select * from storage.objects where bucket_id='proposal-files'")).rows.length,3);checks++;
console.log(`${checks} isolated partner warehouse checks passed. Production was not contacted.`);
await db.close();
