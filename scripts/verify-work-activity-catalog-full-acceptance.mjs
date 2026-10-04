// Complete authored 0841 assembly on the source-matched disposable schema.
// PGlite SET ROLE is useful for SQL behavior, but is not a genuine login proof.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('supabase/migrations/20261108410000_work_activity_engine_cutover.sql',root),'utf8');
const catalog=readFileSync(new URL('supabase/migrations/20261108420000_work_activity_catalog.sql',root),'utf8');
const schema=readFileSync(new URL('scripts/fixtures/work-activity-engine-online-schema.sql',root),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(hash(source),'e2c57266fa2f63e345b8ce232d737c7810c7e9509334b9abae56d7c8b77b5d15');
assert.equal(hash(catalog),'a97e733bd06c4ea8632ed330b02ffb14d90cad748395dcbc7a3cfafbf178d002');
assert.equal(hash(schema),'ee41a980b19f76baa8637101b62703ecdf798a32eccbb0e9f074fbfd71c62471');
const module=process.env.PGLITE_MODULE??'@electric-sql/pglite';
const moduleUrl=isAbsolute(module)?pathToFileURL(module).href:import.meta.resolve(module);
const {PGlite}=await import(moduleUrl);
const {pgcrypto}=await import(new URL('./contrib/pgcrypto.js',moduleUrl));
const {uuid_ossp}=await import(new URL('./contrib/uuid_ossp.js',moduleUrl));
const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
let checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const one=async(s,a=[])=>(await db.query(s,a)).rows[0];
const as=async(uid,role='authenticated')=>{
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid??'']);
  await db.exec('set role '+role);
};
const read=async(job,unit=null)=>(await one('select work_activity_catalog($1,$2) value',[job,unit])).value;
const refused=async(s,args=[],code='42501')=>{
  let error;try{await db.query(s,args);}catch(e){error=e;}
  assert.equal(error?.code,code,error?.message??'Expected SQL refusal');checks++;
};
const unavailable=v=>{
  assert.deepEqual(Object.keys(v).sort(),['asOf','availability','projectId','protocolVersion','selection','totals','unit'].sort());
  assert.equal(v.availability,'unavailable');
  assert.equal(v.projectId,null);assert.equal(v.unit,null);assert.equal(v.selection,null);
  assert.deepEqual(v.totals,{availability:'unavailable',reasonCode:'not_ready'});
  assert.equal(v.protocolVersion,1);check(Number.isFinite(Date.parse(v.asOf)),'Finite unavailable timestamp');
};
// Count every relevant private table, including epoch, receipt, state,
// configuration and observation stores. READ ONLY independently catches a
// hidden write even if a future table is omitted by this count inventory.
const privateNames=async()=>(await db.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'work_%' or relname like 'personal_activity_%') order by relname")).rows.map(r=>r.relname);
let privateTables;
const counts=async()=>{
  await db.exec('reset role');
  const values={};
  for(const name of privateTables)values[name]=Number((await one(`select count(*) n from public."${name}"`)).n);
  return values;
};
const readOnly=async(actor,job,unit=null)=>{
  await as(actor);
  await db.exec('begin isolation level read committed read only');
  try {const result=await read(job,unit);await db.exec('commit');return result;}
  catch(e){await db.exec('rollback');throw e;}
};

try{
  await db.exec(schema);
  await db.exec(source.slice(source.indexOf('-- INSTALLED_SOURCE_GUARD:'),source.indexOf('-- INSTALLED_GRAPH_GUARD:')));
  await db.exec('begin;'+source.slice(source.indexOf('-- DEVELOPMENT_PRIVATE_PREFIX:')).replace(/rollback;\s*$/,'commit;'));
  await db.exec(catalog);
  await db.exec('set search_path=public,pg_temp');
  privateTables=await privateNames();check(privateTables.length>=15,'Complete private table inventory');
  const [owner,crew,foreman,qa,partner,revoked,otherQa]=[1,2,3,4,5,6,7].map(id);
  const [job,hidden,sandbox,deleted]=[10,11,12,13].map(id);
  const [unit,missingUnit]=[20,21].map(id);
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5),($6),($7)',[owner,crew,foreman,qa,partner,revoked,otherQa]);
  await db.query("insert into profiles(id,display_name,role,is_test,is_partner) values($1,'Synthetic owner','owner',false,false),($2,'Synthetic crew','installer',false,false),($3,'Synthetic supervisor','supervisor',false,false),($4,'Synthetic QA','installer',true,false),($5,'Synthetic partner','supervisor',false,true),($6,'Synthetic revoked','owner',false,false),($7,'Synthetic unrelated QA','installer',true,false)",[owner,crew,foreman,qa,partner,revoked,otherQa]);
  await db.query('update profiles set access_revoked_at=clock_timestamp() where id=$1',[revoked]);
  await db.query("insert into projects(id,job_code,name,is_test) values($1,'CAT-JOB','Catalog job',false),($2,'CAT-HIDDEN','Hidden job',true),($3,'CAT-QA','Sandbox job',true),($4,'CAT-DELETED','Deleted job',false)",[job,hidden,sandbox,deleted]);
  await db.query('insert into sandbox_projects(project_id) values($1)',[sandbox]);
  await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[deleted]);
  const initial=await counts();
  for(const actor of [owner,crew,foreman]){
    const v=await readOnly(actor,job);check(v.availability==='available'&&v.projectId===job&&v.selection===null,'Visible no-menu job');
  }
  unavailable(await readOnly(crew,hidden));
  unavailable(await readOnly(crew,deleted));
  unavailable(await readOnly(crew,id(999)));
  unavailable(await readOnly(qa,job));
  check((await readOnly(qa,sandbox)).availability==='available','QA selected sandbox access');
  check((await readOnly(foreman,sandbox)).availability==='available','Supervisor may see test job');
  assert.deepEqual(await counts(),initial);checks++;
  for(const actor of [partner,revoked]){await as(actor);await refused('select work_activity_catalog($1,null)',[job]);}
  await as(null,'anon');await refused('select work_activity_catalog($1,null)',[job]);
  await as(null,'authenticated');await refused('select work_activity_catalog($1,null)',[job]);
  await as(owner);await refused('select work_activity_catalog(null,null)',[],'23514');
  for(const isolation of ['repeatable read','serializable']){
    await db.exec('begin isolation level '+isolation);
    try{await refused('select work_activity_catalog($1,null)',[job],'25001');}
    finally{await db.exec('rollback');}
  }
  await as(owner);
  const fields=[{id:'truth',label_en:'True?',label_es:'Verdad?',type:'boolean',required:true}];
  await db.query("select work_publish_activity_version($1,'catalog_general',0,'general','Original label','Etiqueta original',false,$2)",[id(100),fields]);
  await db.query("select work_publish_activity_version($1,'catalog_specific',0,'specific','Unit task','Unidad',false,'[]')",[id(101)]);
  await db.exec('reset role');
  const defs=(await db.query("select d.code,d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code like 'catalog_%' order by d.code")).rows;
  check(defs.length===2,'Two actual published immutable versions');
  const items=defs.map((d,i)=>({definitionId:d.definition_id,versionId:d.version_id,position:i,enabled:true}));
  await as(owner);await db.query("select work_publish_menu_version($1,'catalog_menu',0,'Original menu','Menu original',$2)",[id(102),items]);
  await db.exec('reset role');
  const menu=(await one("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='catalog_menu'")).id;
  await as(owner);await db.query('select work_select_job_menu($1,$2,$3,0)',[id(103),job,menu]);
  const selection=await readOnly(crew,job);
  check(selection.selection.selectionRevision===1&&selection.selection.menuVersionId===menu,'Exact selected immutable version');
  check(selection.selection.activities.length===2&&selection.selection.activities.find(a=>a.scope==='specific').ineligibleReason==='unit_required','Specific needs selected unit');
  check(selection.selection.activities.find(a=>a.scope==='general').eligibleNow,'General available without unit');
  check(selection.totals.availability==='unavailable'&&!('paidSeconds' in selection),'No invented totals');
  await as(owner);await db.query('select custom_work_command($1,\'unit\',$2)',[id(104),{id:unit,revision:0,project_id:job,label:'Synthetic unit',facts:{},dimension_observation:{width:2,height:3,unit:'ft',source:'estimated'},expected_fact_revision:0}]);
  const withUnit=await readOnly(crew,job,unit);
  check(withUnit.unit.id===unit&&withUnit.unit.fact.dimensions.original.width===2,'Raw original unit observation');
  check(withUnit.selection.activities.find(a=>a.scope==='specific').eligibleNow,'Specific accepts eligible original dimensions');
  unavailable(await readOnly(crew,job,missingUnit));
  unavailable(await readOnly(crew,hidden,unit));
  // The original mapped opening remains an independent permission source.
  const opening=id(30),mapped=id(31);
  await as(owner);
  await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'Catalog origin')",[opening,job]);
  await as(owner);
  await db.query('select custom_work_command($1,\'unit\',$2)',[id(107),{id:mapped,revision:0,project_id:job,opening_id:opening,label:'Mapped origin',facts:{},dimension_observation:{width:7,height:8,unit:'in',source:'measured'},expected_fact_revision:0}]);
  const mappedBefore=await readOnly(crew,job,mapped);
  check(mappedBefore.unit.fact.dimensions.original.width===7,'Mapped original observation is retained');
  await as(owner);
  await db.query('update project_openings set project_id=$1 where id=$2',[sandbox,opening]);
  unavailable(await readOnly(crew,job,mapped));
  await as(owner);
  await db.query('update project_openings set project_id=$1 where id=$2',[job,opening]);
  const mappedAfter=await readOnly(crew,job,mapped);
  check(mappedAfter.unit.fact.originOpeningEpoch!==mappedBefore.unit.fact.originOpeningEpoch,'Opening move-away-and-back changes origin epoch');
  const before=await counts();
  await readOnly(owner,job,unit);await readOnly(crew,job,unit);await readOnly(foreman,job,unit);
  assert.deepEqual(await counts(),before);checks++;
  // A later definition version does not silently replace the selected bytes.
  await as(owner);await db.query("select work_publish_activity_version($1,'catalog_general',1,'general','New label','Etiqueta nueva',false,$2)",[id(105),fields]);
  const pinned=await readOnly(crew,job,unit);
  check(pinned.selection.selectionId===selection.selection.selectionId&&pinned.selection.activities.find(a=>a.scope==='general').labelEn==='Original label','Selection and version labels remain pinned');
  await as(owner);await db.query("select work_retire_activity($1,'catalog_general',2)",[id(106)]);
  const retired=await readOnly(crew,job,unit);
  check(retired.selection.eligibleNow===false&&retired.selection.activities.every(a=>!a.eligibleNow),'Retired enabled child holds whole menu');
  console.log(JSON.stringify({result:'PASS',checks,privateTables:privateTables.length,cutoverSha256:hash(source),catalogSha256:hash(catalog),scope:'Complete authored 0841 assembly in source-matched PGlite; real-login and two-backend waits require PG17 acceptance'}));
}finally{await db.close();}
