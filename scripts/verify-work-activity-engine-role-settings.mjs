// SQL GUC roundtrip tests only. No backend login/provider-hook claim.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE??'@electric-sql/pglite');
const db=new PGlite();
const metadata=JSON.parse(readFileSync(new URL('./fixtures/work-activity-engine-role-parity.json',import.meta.url),'utf8'));
const qi=s=>'"'+s.replaceAll('"','""')+'"';const ql=s=>"'"+s.replaceAll("'","''")+"'";
const one=async s=>(await db.query(s)).rows[0];let checks=0;
await db.exec('create role path_bug;create table public.role_fixture_type(id integer)');
const original=metadata.settings.find(s=>s.role==='postgres').safeValues.find(s=>s.startsWith('search_path=')).slice('search_path='.length);
await db.exec('alter role path_bug set search_path to '+ql(original));
const wrong=(await one("select setconfig[1] value from pg_db_role_setting where setrole='path_bug'::regrole")).value.slice('search_path='.length);
assert.notEqual(wrong,original);checks++;
await db.query("select set_config('search_path',$1,false)",[wrong]);
assert.equal((await one("select to_regtype('role_fixture_type') value")).value,null);checks++;
await db.exec('reset search_path');
for(const setting of metadata.settings){
 if(!setting.role||!setting.safeValues.length)continue;
 const role='fixture_'+setting.role;
 await db.exec('create role '+qi(role));
 for(const entry of setting.safeValues){
  const at=entry.indexOf('='),key=entry.slice(0,at),value=entry.slice(at+1);
  if(key==='search_path'){
   await db.query('select pg_catalog.set_config($1,$2,false)',[key,value]);
   await db.exec('alter role '+qi(role)+' set '+qi(key)+' from current;reset '+qi(key));
  }else{
   assert.ok(['statement_timeout','lock_timeout','idle_in_transaction_session_timeout'].includes(key));
   await db.exec('alter role '+qi(role)+' set '+qi(key)+' to '+ql(value));
  }
  const result=await one('select setconfig from pg_db_role_setting where setrole='+ql(role)+'::regrole');
  assert.ok(result.setconfig.includes(entry),entry);checks++;
 }
}
await db.query("select set_config('search_path',$1,false)",[original]);
assert.equal((await one("select to_regtype('role_fixture_type') value")).value,'role_fixture_type');checks++;
await db.close();console.log(JSON.stringify({result:'PASS',checks,scope:'Original comma-valued search_path counterexample and exact safe-setting SQL roundtrips; no login/provider equivalence claim'}));
