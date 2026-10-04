// Offline schema reconstruction research. No network or operational records.
// Every reconstructed expression must match the installed catalog hash.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where},null,2));process.exit(1);});
const input=process.env.WORK_ACTIVITY_SCHEMA_CANDIDATES;
assert.ok(input,'WORK_ACTIVITY_SCHEMA_CANDIDATES is required');
const data=JSON.parse(readFileSync(input,'utf8')), shape=data.shape;
const module=process.env.PGLITE_MODULE??'@electric-sql/pglite';
const moduleUrl=isAbsolute(module)?pathToFileURL(module).href:import.meta.resolve(module);
const {PGlite}=await import(moduleUrl);
const pgcryptoPath=new URL('./contrib/pgcrypto.js',moduleUrl).href;
const uuidPath=new URL('./contrib/uuid_ossp.js',moduleUrl).href;
const {pgcrypto}=await import(pgcryptoPath);
// uuid-ossp is loaded only if the already bundled extension is available.
let uuidExtension;try{uuidExtension=(await import(uuidPath)).uuid_ossp;}catch{}
const db=new PGlite({extensions:{pgcrypto,...(uuidExtension?{uuid_ossp:uuidExtension}:{})}});
const qi=s=>'"'+s.replaceAll('"','""')+'"';const ql=s=>"'"+s.replaceAll("'","''")+"'";
const hash=s=>createHash('sha256').update(s).digest('hex');
const fq=(schema,name)=>qi(schema)+'.'+qi(name);
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const one=async(sql,args=[])=>(await rows(sql,args))[0];
const serverVersion=(await one('show server_version_num')).server_version_num;
const built=[],errors=[],matches={functions:[],defaults:[],checks:[],keys:[],indexes:[],views:[],policies:[]};
const attempt=async(sql)=>{try{await db.exec(sql);return null;}catch(e){return e.code??'unknown';}};
const install=async(sql)=>{await db.exec(sql);built.push(sql+';');};
const excluded=new Set();
const roles=new Set(['authenticated','anon','service_role','authenticator','supabase_admin','supabase_auth_admin','dashboard_user']);
for(const r of shape.relations){roles.add(r.owner);for(const a of r.acl??[])roles.add(a.split('=')[0].replace(/^"|"$/g,''));}
for(const f of data.functions){roles.add(f.installed.owner);for(const a of f.installed.acl??[])roles.add(a.split('=')[0].replace(/^"|"$/g,''));}
for(const role of [...roles].filter(x=>x&&x!=='postgres').sort())await install(`create role ${qi(role)} nologin`);
await install('create schema auth;create schema extensions;create schema storage;set search_path=public,extensions;set check_function_bodies=off');
await install('create extension pgcrypto with schema extensions');
if(uuidExtension)await install('create extension "uuid-ossp" with schema extensions');
await install(`create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 grant usage on schema auth to authenticated,anon,service_role`);
const columnsFor=r=>shape.columns.filter(c=>c.schema===r.schema&&c.relation===r.name).sort((a,b)=>a.number-b.number);
const generated={
 'public.locations.address':{expression:"zone || '-' || rack || '-' || slot",source:'20260715000000_inventory_core.sql generated address'},
 'auth.users.confirmed_at':data.providerCandidates[0],
};
for(const r of shape.relations.filter(r=>r.kind==='c')){
 await install(`create type ${fq(r.schema,r.name)} as (${columnsFor(r).filter(c=>!c.dropped).map(c=>qi(c.name)+' '+c.typeSql).join(',')})`);
}
for(const r of shape.relations.filter(r=>r.kind==='r')){
 const columns=columnsFor(r);
 if(columns.some(c=>!c.dropped&&c.typeSchema!=='pg_catalog')){excluded.add(r.schema+'.'+r.name);errors.push({kind:'external_type_relation',name:r.schema+'.'+r.name});continue;}
 const defs=columns.map(c=>{
  if(c.dropped)return qi('fixture_dropped_'+c.number)+' integer';
  let sql=qi(c.name)+' '+c.typeSql;
  if(c.generated){const g=generated[r.schema+'.'+r.name+'.'+c.name];assert.ok(g,'Unresolved generated column '+r.name+'.'+c.name);sql+=' generated always as ('+g.expression+') stored';}
  if(c.notNull)sql+=' not null';
  return sql;
 });
 await install(`create table ${fq(r.schema,r.name)} (${defs.join(',')})`);
 for(const c of columns.filter(c=>c.dropped))await install(`alter table ${fq(r.schema,r.name)} drop column ${qi('fixture_dropped_'+c.number)}`);
 for(const c of columns.filter(c=>c.generated)){
  const actual=await one('select pg_get_expr(d.adbin,d.adrelid,false) expression from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid=$1::regclass and a.attname=$2',[r.schema+'.'+r.name,c.name]);
  assert.equal(hash(actual.expression),c.defaultSha256,'Generated expression hash mismatch '+r.name+'.'+c.name);
  matches.defaults.push({relation:r.schema+'.'+r.name,column:c.name,sha256:c.defaultSha256,source:generated[r.schema+'.'+r.name+'.'+c.name].source});
 }
}
for(const s of shape.sequences){
 const owner=s.ownedBy?.find(o=>o.dependencyKind==='i');
 if(owner){
  const column=shape.columns.find(c=>c.schema===owner.schema&&c.relation===owner.relation&&c.name===owner.column);
  await install(`alter table ${fq(owner.schema,owner.relation)} alter column ${qi(owner.column)} add generated ${column.identity==='a'?'always':'by default'} as identity (sequence name ${fq(s.schema,s.name)} start with ${s.start} increment by ${s.increment} minvalue ${s.minimum} maxvalue ${s.maximum} cache ${s.cache} ${s.cycle?'cycle':'no cycle'})`);
 }else{
  await install(`create sequence ${fq(s.schema,s.name)} as ${s.dataType} start with ${s.start} increment by ${s.increment} minvalue ${s.minimum} maxvalue ${s.maximum} cache ${s.cache} ${s.cycle?'cycle':'no cycle'}`);
  for(const o of s.ownedBy??[])await install(`alter sequence ${fq(s.schema,s.name)} owned by ${fq(o.schema,o.relation)}.${qi(o.column)}`);
 }
}
for(const f of data.functions){
 const error=await attempt(f.definition);
 if(error){errors.push({kind:'function_creation',name:f.identity,code:error});continue;}
 const actual=await one("select oid,prosrc from pg_proc where pronamespace='public'::regnamespace and proname=$1 and pg_get_function_identity_arguments(oid)=$2",[f.name,f.arguments]);
 if(!actual||hash(actual.prosrc)!==f.bodySha256)throw new Error('Actual function identity/body mismatch '+f.identity);
 built.push(f.definition+';');matches.functions.push(f.identity);
}
console.log(JSON.stringify({phase:'structural skeleton',relations:shape.relations.filter(r=>r.kind==='r').length-excluded.size,sourceFunctions:matches.functions.length,unresolved:errors.length}));
// Source candidates are compiled on the actual typed empty relation. Adding a
// CHECK never executes source work; there are no fixture people or source rows.
for(const c of shape.constraints.filter(c=>c.kind==='c')){
 const key=c.relationSchema+'.'+c.relation;if(excluded.has(key))continue;
 const candidates=data.checks.filter(x=>x.table===c.relation);let matched=false;
 const seen=new Set();
 for(const candidate of candidates){
  if(seen.has(candidate.expression))continue;seen.add(candidate.expression);
  const sql=`alter table ${fq(c.relationSchema,c.relation)} add constraint ${qi(c.name)} check (${candidate.expression})${c.noInherit?' no inherit':''}${c.validated?'':' not valid'}`;
  if(await attempt(sql))continue;
  const actual=await one('select pg_get_constraintdef(oid,false) definition from pg_constraint where conrelid=$1::regclass and conname=$2',[key,c.name]);
  if(hash(actual.definition)===c.definitionSha256){built.push(sql+';');matches.checks.push({relation:key,name:c.name,source:candidate.source,line:candidate.line,sha256:c.definitionSha256});matched=true;break;}
  await db.exec(`alter table ${fq(c.relationSchema,c.relation)} drop constraint ${qi(c.name)}`);
 }
 if(!matched)errors.push({kind:'check_expression',relation:key,name:c.name,sha256:c.definitionSha256,candidates:seen.size});
}
console.log(JSON.stringify({phase:'CHECK expressions',matched:matches.checks.length,unresolved:errors.filter(e=>e.kind==='check_expression').length}));
// Defaults with the same installed deparser hash share an expression, but each
// typed destination is compiled and verified independently before acceptance.
const defaultCache=new Map();
for(const c of shape.columns.filter(c=>c.hasDefault&&!c.generated&&!c.dropped)){
 const key=c.schema+'.'+c.relation;if(excluded.has(key))continue;
 const local=data.defaults.filter(x=>x.table===c.relation);
 const candidates=[...(defaultCache.has(c.defaultSha256)?[defaultCache.get(c.defaultSha256)]:[]),...local,...data.defaults.filter(x=>['0','1','false','true','null','now()','clock_timestamp()','gen_random_uuid()',"''","'{}'","'[]'"].includes(x.expression.toLowerCase()))];
 let matched=false;const seen=new Set();
 for(const candidate of candidates){
  if(seen.has(candidate.expression))continue;seen.add(candidate.expression);
  const sql=`alter table ${fq(c.schema,c.relation)} alter column ${qi(c.name)} set default ${candidate.expression}`;
  if(await attempt(sql))continue;
  const actual=await one('select pg_get_expr(d.adbin,d.adrelid,false) expression from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid=$1::regclass and a.attname=$2',[key,c.name]);
  if(actual&&hash(actual.expression)===c.defaultSha256){built.push(sql+';');defaultCache.set(c.defaultSha256,candidate);matches.defaults.push({relation:key,column:c.name,source:candidate.source,line:candidate.line,sha256:c.defaultSha256});matched=true;break;}
  await db.exec(`alter table ${fq(c.schema,c.relation)} alter column ${qi(c.name)} drop default`);
 }
 if(!matched)errors.push({kind:'default_expression',relation:key,column:c.name,sha256:c.defaultSha256,candidates:seen.size});
}
console.log(JSON.stringify({phase:'default expressions',matched:matches.defaults.length,unresolved:errors.filter(e=>e.kind==='default_expression').length}));
// Plain key definitions were returned by the catalog without expression text.
// Install referenced keys before FKs, then compare the actual server deparser.
for(const kind of ['p','u','f'])for(const c of shape.constraints.filter(c=>c.kind===kind)){
 const key=c.relationSchema+'.'+c.relation;
 if(excluded.has(key)||excluded.has(c.parentSchema+'.'+c.parentRelation))continue;
 assert.equal(typeof c.definition,'string','Missing plain key definition '+c.name);
 const sql=`alter table ${fq(c.relationSchema,c.relation)} add constraint ${qi(c.name)} ${c.definition}`;
 const error=await attempt(sql);
 if(error){errors.push({kind:'key_creation',relation:key,name:c.name,code:error});continue;}
 const actual=await one('select pg_get_constraintdef(oid,false) definition from pg_constraint where conrelid=$1::regclass and conname=$2',[key,c.name]);
 assert.equal(hash(actual.definition),c.definitionSha256,'Key definition mismatch '+c.name);
 built.push(sql+';');matches.keys.push({relation:key,name:c.name,sha256:c.definitionSha256});
}
console.log(JSON.stringify({phase:'PK/UNIQUE/FK',matched:matches.keys.length,unresolved:errors.filter(e=>e.kind==='key_creation').length}));
for(const idx of shape.indexes){
 const key=idx.schema+'.'+idx.relation;if(excluded.has(key))continue;
 const existing=await one('select pg_get_indexdef(to_regclass($1),0,false) definition',[idx.schema+'.'+idx.name]);
 if(existing?.definition){
  if(hash(existing.definition)!==idx.definitionSha256)errors.push({kind:'key_index_definition',relation:key,name:idx.name});
  else matches.indexes.push({relation:key,name:idx.name,source:'key constraint',sha256:idx.definitionSha256});
  continue;
 }
 const candidates=[...(idx.definition?[{sql:idx.definition,source:'installed plain index metadata'}]:[]),...data.indexes.filter(x=>x.name===idx.name)];
 let matched=false;
 for(const candidate of candidates){
  if(await attempt(candidate.sql))continue;
  const actual=await one('select pg_get_indexdef(to_regclass($1),0,false) definition',[idx.schema+'.'+idx.name]);
  if(actual?.definition&&hash(actual.definition)===idx.definitionSha256){built.push(candidate.sql+';');matches.indexes.push({relation:key,name:idx.name,sha256:idx.definitionSha256,source:candidate.source});matched=true;break;}
  await db.exec(`drop index if exists ${fq(idx.schema,idx.name)}`);
 }
 if(!matched)errors.push({kind:'index_expression',relation:key,name:idx.name,sha256:idx.definitionSha256,candidates:candidates.length});
}
for(const view of shape.relations.filter(r=>r.kind==='v')){
 let matched=false;
 for(const candidate of data.views.filter(x=>x.name===view.name).reverse()){
  if(await attempt(candidate.sql))continue;
  const actual=await one('select pg_get_viewdef($1::regclass,false) definition',[view.schema+'.'+view.name]);
  if(hash(actual.definition)===view.viewDefinitionSha256){built.push(candidate.sql+';');matches.views.push({name:view.name,sha256:view.viewDefinitionSha256,source:candidate.source});matched=true;break;}
  await db.exec(`drop view ${fq(view.schema,view.name)}`);
 }
 if(!matched)errors.push({kind:'view_definition',name:view.name,sha256:view.viewDefinitionSha256});
}
console.log(JSON.stringify({phase:'indexes/views',indexes:matches.indexes.length,views:matches.views.length,unresolved:errors.filter(e=>['index_expression','key_index_definition','view_definition'].includes(e.kind)).length}));
for(const policy of shape.policies){
 const key=policy.schema+'.'+policy.relation;if(excluded.has(key))continue;
 const known=data.knownPolicies.find(p=>p.name===policy.name&&p.table===policy.relation);
 const command={a:'insert',r:'select',w:'update',d:'delete','*':'all'}[policy.command];
 const catalog=known?[{sql:`create policy ${qi(policy.name)} on ${fq(policy.schema,policy.relation)} as ${policy.permissive?'permissive':'restrictive'} for ${command} to ${policy.roles.map(r=>r==='public'?'public':qi(r)).join(',')}${known.using?' using ('+known.using+')':''}${known.check?' with check ('+known.check+')':''}`,source:'installed bounded policy evidence'}]:[];
 let matched=false;
 for(const candidate of [...catalog,...data.policies.filter(p=>p.name===policy.name&&p.table===policy.relation).reverse()]){
  if(await attempt(candidate.sql))continue;
  const actual=await one('select polcmd::text command,polpermissive permissive,pg_get_expr(polqual,polrelid,false) using_expr,pg_get_expr(polwithcheck,polrelid,false) check_expr from pg_policy where polrelid=$1::regclass and polname=$2',[key,policy.name]);
  if(actual&&actual.command===policy.command&&actual.permissive===policy.permissive&&(actual.using_expr===null?null:hash(actual.using_expr))===policy.usingSha256&&(actual.check_expr===null?null:hash(actual.check_expr))===policy.checkSha256){
   const roleRows=await rows('select case when r=0 then \'public\' else pg_get_userbyid(r) end name from pg_policy p cross join lateral unnest(p.polroles) r where p.polrelid=$1::regclass and p.polname=$2',[key,policy.name]);
   if(JSON.stringify(roleRows.map(r=>r.name).sort())===JSON.stringify([...policy.roles].sort())){built.push(candidate.sql+';');matches.policies.push({relation:key,name:policy.name,source:candidate.source});matched=true;break;}
  }
  await db.exec(`drop policy if exists ${qi(policy.name)} on ${fq(policy.schema,policy.relation)}`);
 }
 if(!matched)errors.push({kind:'policy_expression',relation:key,name:policy.name});
}
console.log(JSON.stringify({phase:'policies',matched:matches.policies.length,unresolved:errors.filter(e=>e.kind==='policy_expression').length}));
// Restore the actual authority of each source function, rather than relying on
// its historical migration header or on default PUBLIC execution privileges.
matches.functionAuthority=[];matches.relationAuthority=[];matches.columnAcl=[];matches.triggers=[];
const privileges={a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN',X:'EXECUTE',U:'USAGE',C:'CREATE'};
const aclParts=acl=>acl.map(item=>{
 const match=item.match(/^(.*?)=([^/]*)\/(.*)$/);assert.ok(match,'Invalid catalog ACL item');
 const unquote=s=>s.startsWith('"')?s.slice(1,-1).replaceAll('""','"'):s;
 return {grantee:unquote(match[1]),rights:[...match[2].matchAll(/([A-Za-z])(\*)?/g)].map(m=>({privilege:privileges[m[1]],grantable:!!m[2]})),grantor:unquote(match[3])};
});
async function applyAcl(kind,identity,acl,column=null){
 if(acl===null)return;
 const columnSql=column?' ('+qi(column)+')':'';
 await install(`revoke all${columnSql} on ${kind} ${identity} from public`);
 for(const role of roles)if(role)await install(`revoke all${columnSql} on ${kind} ${identity} from ${qi(role)}`);
 for(const item of aclParts(acl))for(const grantable of [false,true]){
  const rights=item.rights.filter(r=>r.grantable===grantable).map(r=>{assert.ok(r.privilege);return r.privilege+columnSql;});
  if(!rights.length)continue;
  await install(`set role ${qi(item.grantor)};grant ${rights.join(',')} on ${kind} ${identity} to ${item.grantee?qi(item.grantee):'public'}${grantable?' with grant option':''};reset role`);
 }
}
const aclNormalized=async(acl,kind,owner)=>rows(`select pg_get_userbyid(grantor) grantor,case when grantee=0 then 'public' else pg_get_userbyid(grantee) end grantee,privilege_type,is_grantable from aclexplode(coalesce($1::aclitem[],acldefault($2::"char",$3::regrole))) order by 1,2,3,4`,[acl,kind,owner]);
for(const schema of data.schemas){
 await install(`alter schema ${qi(schema.name)} owner to ${qi(schema.owner)}`);
 await applyAcl('schema',qi(schema.name),schema.acl);
 const actual=await one('select nspacl acl,pg_get_userbyid(nspowner) owner from pg_namespace where nspname=$1',[schema.name]);
 assert.equal(actual.owner,schema.owner);
 assert.deepEqual(await aclNormalized(actual.acl,'n',actual.owner),await aclNormalized(schema.acl,'n',schema.owner),'Schema effective ACL '+schema.name);
}
for(const f of data.functions.filter(f=>matches.functions.includes(f.identity))){
 const identity=fq('public',f.name)+'('+f.arguments+')';
 const before=await one("select proconfig::text config_text from pg_proc where pronamespace='public'::regnamespace and proname=$1 and pg_get_function_identity_arguments(oid)=$2",[f.name,f.arguments]);
 if((before.config_text===null?null:hash(before.config_text))!==f.installed.configSha256){
  if(f.config.withheldKeys.length){errors.push({kind:'withheld_function_config',name:f.identity,keys:f.config.withheldKeys});continue;}
  await install(`alter function ${identity} reset all`);
  for(const config of f.config.config??[]){
   const split=config.indexOf('=');const name=config.slice(0,split),value=config.slice(split+1);
   const previous=(await one('select current_setting($1,true) value',[name])).value;
   await install(`select set_config(${ql(name)},${ql(value)},false);alter function ${identity} set ${qi(name)} from current;select set_config(${ql(name)},${ql(previous??'')},false)`);
  }
 }
 await install(`alter function ${identity} ${f.installed.securityDefiner?'security definer':'security invoker'} ${({v:'volatile',s:'stable',i:'immutable'})[f.installed.volatility]};alter function ${identity} owner to ${qi(f.installed.owner)}`);
 await applyAcl('function',identity,f.installed.acl);
 const actual=await one("select proacl acl,proconfig::text config_text,prosecdef,provolatile::text volatility,pg_get_userbyid(proowner) owner from pg_proc where pronamespace='public'::regnamespace and proname=$1 and pg_get_function_identity_arguments(oid)=$2",[f.name,f.arguments]);
 assert.equal(actual.owner,f.installed.owner);assert.equal(actual.prosecdef,f.installed.securityDefiner);assert.equal(actual.volatility,f.installed.volatility);
 assert.equal(actual.config_text===null?null:hash(actual.config_text),f.installed.configSha256,'Function actual config hash '+f.identity);
 assert.deepEqual(await aclNormalized(actual.acl,'f',actual.owner),await aclNormalized(f.installed.acl,'f',f.installed.owner),'Function effective ACL '+f.identity);
 matches.functionAuthority.push(f.identity);
}
for(const r of shape.relations.filter(r=>['r','v','S'].includes(r.kind)&&!excluded.has(r.schema+'.'+r.name))){
 const identity=fq(r.schema,r.name),kind=r.kind==='S'?'sequence':'table';
 await install(`alter ${kind} ${identity} owner to ${qi(r.owner)}`);
 if(r.kind==='r')await install(`alter table ${identity} ${r.rls?'enable':'disable'} row level security;alter table ${identity} ${r.forceRls?'force':'no force'} row level security`);
 await applyAcl(kind,identity,r.acl);
 const actual=await one('select relacl acl,relrowsecurity rls,relforcerowsecurity force_rls,pg_get_userbyid(relowner) owner,reloptions::text options from pg_class where oid=$1::regclass',[r.schema+'.'+r.name]);
 assert.equal(actual.owner,r.owner);assert.equal(actual.rls,r.rls);assert.equal(actual.force_rls,r.forceRls);
 assert.equal(actual.options===null?null:hash(actual.options),r.optionsSha256,'Relation options '+r.name);
 assert.deepEqual(await aclNormalized(actual.acl,r.kind==='S'?'S':'r',actual.owner),await aclNormalized(r.acl,r.kind==='S'?'S':'r',r.owner),'Relation effective ACL '+r.name);
 matches.relationAuthority.push(r.schema+'.'+r.name);
}
for(const c of shape.columns.filter(c=>c.acl&&!c.dropped&&!excluded.has(c.schema+'.'+c.relation))){
 await applyAcl('table',fq(c.schema,c.relation),c.acl,c.name);
 const actual=await one('select attacl acl from pg_attribute where attrelid=$1::regclass and attname=$2',[c.schema+'.'+c.relation,c.name]);
 assert.deepEqual(await aclNormalized(actual.acl,'c','postgres'),await aclNormalized(c.acl,'c','postgres'),'Column ACL '+c.relation+'.'+c.name);
 matches.columnAcl.push(c.relation+'.'+c.name);
}
for(const t of data.triggers.filter(t=>!t.internal)){
 const table=t.table.includes('.')?t.table:'public.'+t.table;if(excluded.has(table))continue;
 const error=await attempt(t.definition);
 if(error){errors.push({kind:'trigger_creation',table,name:t.name,code:error});continue;}
 built.push(t.definition+';');
 const enabled={O:'enable',D:'disable',R:'enable replica',A:'enable always'}[t.enabled];assert.ok(enabled);
 const qualified=table.split('.').map(qi).join('.');
 await install(`alter table ${qualified} ${enabled} trigger ${qi(t.name)}`);
 const actual=await one('select pg_get_triggerdef(oid,true) definition,tgenabled::text enabled from pg_trigger where tgrelid=$1::regclass and tgname=$2',[table,t.name]);
 assert.equal(actual.definition,t.definition,'Actual trigger definition '+table+'.'+t.name);assert.equal(actual.enabled,t.enabled);
 matches.triggers.push({table,name:t.name});
}
console.log(JSON.stringify({phase:'actual authority/callbacks',functions:matches.functionAuthority.length,relations:matches.relationAuthority.length,columnAcl:matches.columnAcl.length,triggers:matches.triggers.length}));
matches.columns=[];matches.functionDefinitions=[];
for(const c of shape.columns.filter(c=>!excluded.has(c.schema+'.'+c.relation))){
 const actual=await one(`select a.attnum number,a.attname name,a.attisdropped dropped,a.attnotnull not_null,
  format_type(a.atttypid,a.atttypmod) type_sql,a.atttypmod type_modifier,a.attndims dimensions,
  a.attgenerated::text generated,a.attidentity::text identity,a.attstorage::text storage,a.attcompression::text compression,
  co.collname collation,cn.nspname collation_schema
  from pg_attribute a left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace
  where a.attrelid=$1::regclass and a.attnum=$2`,[c.schema+'.'+c.relation,c.number]);
 assert.ok(actual,'Missing actual column position '+c.relation+'.'+c.number);
 for(const [installed,local] of [['number','number'],['name','name'],['dropped','dropped'],['notNull','not_null'],['typeSql','type_sql'],['typeModifier','type_modifier'],['dimensions','dimensions'],['generated','generated'],['identity','identity'],['storage','storage'],['compression','compression'],['collation','collation'],['collationSchema','collation_schema']]){
  if(c.dropped&&!['number','name','dropped'].includes(installed))continue;
  assert.deepEqual(actual[local],c[installed],'Column attribute '+c.relation+'.'+c.name+'.'+installed);
 }
 matches.columns.push(c.schema+'.'+c.relation+'.'+c.number);
}
for(const f of data.functions.filter(f=>matches.functions.includes(f.identity))){
 const actual=await one("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname=$1 and pg_get_function_identity_arguments(oid)=$2",[f.name,f.arguments]);
 if(hash(actual.definition)!==f.installed.definitionSha256)errors.push({kind:'function_definition_header',name:f.identity,expected:f.installed.definitionSha256,actual:hash(actual.definition)});
 else matches.functionDefinitions.push(f.identity);
}
console.log(JSON.stringify({phase:'complete column/header comparison',columns:matches.columns.length,functionDefinitions:matches.functionDefinitions.length,unresolved:errors.filter(e=>e.kind==='function_definition_header').length}));
const providerIndexNames=new Set(['confirmation_token_idx','email_change_token_current_idx','email_change_token_new_idx','idx_users_name','reauthentication_token_idx','recovery_token_idx','users_email_partial_key','users_instance_id_email_idx']);
for(const error of errors){
 const allowed=(error.kind==='external_type_relation'&&error.name==='public.knowledge_chunks')||
  (error.kind==='function_creation'&&error.name==='match_knowledge_chunks(vector, integer, double precision)'&&error.code==='42704')||
  (error.kind==='index_expression'&&error.relation==='auth.users'&&providerIndexNames.has(error.name));
 assert.ok(allowed,'New reconstruction gap requires review: '+JSON.stringify(error));
}
assert.equal(errors.length,10,'Only the frozen vector/provider exclusions are permitted');
assert.equal(matches.columns.length,shape.columns.filter(c=>!excluded.has(c.schema+'.'+c.relation)).length);
assert.equal(matches.functionDefinitions.length,data.functions.length-1);
assert.equal(matches.checks.length,shape.constraints.filter(c=>c.kind==='c'&&!excluded.has(c.relationSchema+'.'+c.relation)).length);
assert.equal(matches.defaults.length,shape.columns.filter(c=>c.hasDefault&&!c.dropped&&!excluded.has(c.schema+'.'+c.relation)).length);
assert.equal(matches.policies.length,shape.policies.filter(p=>!excluded.has(p.schema+'.'+p.relation)).length);
assert.equal(matches.triggers.length,data.triggers.filter(t=>!t.internal&&!excluded.has(t.table.includes('.')?t.table:'public.'+t.table)).length);
const report={formatVersion:1,activation:false,complete:false,scope:'Source-matched application schema with explicit vector and provider-index exclusions; no full installed-schema or runtime parity claim.',serverVersion,
 installedShapeSha256:data.shapeFileSha256,matches,unresolved:errors,omittedStages:['vector extension and knowledge_chunks domain','eight provider auth.users expression indexes','provider schemas and maintenance behavior','installed role attributes/memberships','runtime fixtures']};
const reportPath=process.env.WORK_ACTIVITY_SCHEMA_REPORT??'/tmp/work-activity-schema-reconstruction.json';writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({reportPath,matchedFunctions:matches.functions.length,matchedChecks:matches.checks.length,matchedDefaults:matches.defaults.length,unresolved:errors.length,complete:false}));
await db.close();
if(process.env.WORK_ACTIVITY_SCHEMA_PARTIAL_OUT){
 const serialized='-- SOURCE-MATCHED DEVELOPMENT FIXTURE ONLY; vector/provider exclusions in paired report.\n'+built.join('\n;\n')+'\n;\n';
 const imported=new PGlite({extensions:{pgcrypto,...(uuidExtension?{uuid_ossp:uuidExtension}:{})}});
 try{await imported.exec(serialized);}finally{await imported.close();}
 writeFileSync(process.env.WORK_ACTIVITY_SCHEMA_PARTIAL_OUT,serialized);
 const manifest={formatVersion:1,activation:false,scope:report.scope,installedServerVersion:Number(shape.serverVersionNum),localReconstructionServerVersion:serverVersion,
  artifactSha256:hash(serialized),installedShapeFileSha256:data.shapeFileSha256,evidenceFilesSha256:data.evidenceFilesSha256,
  sourceParentsSha256:data.sourceParentsSha256,matches:Object.fromEntries(Object.entries(matches).map(([k,v])=>[k,v.length])),
  unresolved:errors,omittedStages:report.omittedStages,roundTrip:'PASS in a second fresh PGlite database',
  reconstructionToolsSha256:Object.fromEntries(['build-work-activity-engine-schema-fixture.py','verify-work-activity-engine-schema-fixture.mjs'].map(name=>['scripts/'+name,hash(readFileSync(new URL('./'+name,import.meta.url),'utf8'))]))};
 writeFileSync(process.env.WORK_ACTIVITY_SCHEMA_PARTIAL_OUT.replace(/\.sql$/,'')+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({roundTrip:'PASS',bytes:Buffer.byteLength(serialized),sha256:hash(serialized)}));
}
