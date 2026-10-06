// Real workshop Auth + RLS/RPC checks. No service-role client or mocked replies.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const require=createRequire(new URL("../../app/package.json",import.meta.url));
const { createClient }=require("@supabase/supabase-js");
const manifest=JSON.parse(readFileSync(new URL("../../workshop/manifest.json",import.meta.url),"utf8"));
assert.equal(manifest.supabase_project_ref,"magcghmnbjiukidyalxd");
assert.equal(manifest.supabase_url,"https://magcghmnbjiukidyalxd.supabase.co");
const privateDir=join(homedir(),".config/forge-workshop");
const key=readFileSync(join(privateDir,"public-key"),"utf8").trim();
assert.ok(key.startsWith("sb_publishable_"));
const accounts=JSON.parse(readFileSync(join(privateDir,"accounts.json"),"utf8"));
const results=[];
for(const account of accounts){
  const client=createClient(manifest.supabase_url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await client.auth.signInWithPassword({email:account.email,password:account.password});
  assert.equal(authError,null,"Workshop sign-in failed");
  assert.equal(auth.user.id,account.id);
  const {data:profile,error:profileError}=await client.from("profiles").select("role").eq("id",auth.user.id).single();
  assert.equal(profileError,null);assert.equal(profile.role,account.role);
  const marker=await client.from("workshop_environment").select("project_ref");
  assert.ok(marker.error,"Ordinary browser users must not read the private setup marker");
  const now=new Date();const from=new Date(now);from.setUTCHours(0,0,0,0);const until=new Date(from);until.setUTCDate(until.getUTCDate()+1);
  const snapshot=await client.rpc("work_data_snapshot",{p_project_id:"fb000000-0000-4000-8000-000000000001",p_from:from.toISOString(),p_until:until.toISOString()});
  if(account.role==="owner") assert.equal(snapshot.error,null,"Owner Work Data must exist on the workshop backend");
  if(account.role==="installer") assert.ok(snapshot.error,"Installer must not fetch private Work Data");
  results.push({role:account.role,profileMatches:true,privateMarkerDenied:true,workDataResult:snapshot.error?{code:snapshot.error.code}:"available"});
  await client.auth.signOut({scope:"local"});
}
writeFileSync(join(privateDir,"permission-checks.json"),JSON.stringify({checkedAt:new Date().toISOString(),projectRef:manifest.supabase_project_ref,results},null,2)+"\n",{mode:0o600});
console.log(JSON.stringify(results));
