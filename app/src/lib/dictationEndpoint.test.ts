import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {dictationExtension,readDictationBody,DICTATION_MAX_BYTES,DICTATION_MAX_SECONDS} from "../../../supabase/functions/_shared/dictation";

// Exercise the deployed handler body; replace only its auth/database/provider
// boundaries so a test can never record crew data or charge a live account.
function harness(options: {signedIn?:boolean;revoked?:boolean;retired?:boolean;quota?:boolean;budget?:boolean;providerStatus?:number}={}) {
  let handler: (r:Request)=>Promise<Response>;
  let calls=0, releases=0, settles=0; const languages:(string|null)[]=[];
  const source=readFileSync(new URL('../../../supabase/functions/transcribe-description/index.ts',import.meta.url),'utf8');
  const parsed=ts.createSourceFile('handler.ts',source,ts.ScriptTarget.Latest,true);
  let withoutImports=source;
  for(const node of [...parsed.statements].reverse())if(ts.isImportDeclaration(node))withoutImports=withoutImports.slice(0,node.pos)+withoutImports.slice(node.end);
  const code=ts.transpileModule(withoutImports,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{id:'crew',access_revoked_at:options.revoked?'now':null,retired_at:options.retired?'now':null}})};
  const client={from:()=>query,rpc:async()=>({data:options.quota!==false,error:null})};
  const context={Request,Response,Blob,File,FormData,AbortSignal,Error,Number,Math,Date,
    Deno:{serve:(fn:typeof handler)=>{handler=fn;}},withSentry:(_:unknown,fn:typeof handler)=>fn,
    verifyCaller:async()=>options.signedIn===false?{status:'unauthorized'}:{status:'ok',user:{id:'crew'}},
    callerSupabaseClient:()=>client, createClient:()=>client,
    corsHeaders:()=>({}),jsonResponse:(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),
    requireOpenAI:()=> 'test',SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test',
    reserveAiSpend:async()=>({allowed:options.budget!==false,reservationId:'reservation'}),
    releaseAiSpend:async()=>{releases++;},settleAiSpend:async()=>{settles++;},notifyOwnersOfSpend:async()=>{},reportCaughtError:async()=>{},
    DICTATION_MAX_BYTES,DICTATION_MAX_SECONDS,dictationExtension,readDictationBody,AUDIO_MICROS_PER_SECOND:{'whisper-1':100},
    fetch:async(_url:string,init:RequestInit)=>{calls++;languages.push((init.body as FormData).get('language') as string|null);return new Response(JSON.stringify({text:'Cuatro puertas.',duration:4}),{status:options.providerStatus??200});},
  };
  vm.runInNewContext(code,context);
  return {run:(r:Request)=>handler(r),counts:()=>({calls,releases,settles}),languages};
}
function request(type='audio/mp4',language='es') {
  const form=new FormData();form.append('audio',new Blob(['test audio'],{type}),'description.mp4');form.append('language',language);
  return new Request('https://example.invalid',{method:'POST',body:form});
}
describe('description transcription boundary',()=>{
 it('rejects a logged-out caller before any provider call',async()=>{const h=harness({signedIn:false});expect((await h.run(request())).status).toBe(401);expect(h.counts().calls).toBe(0);});
 for(const state of ['revoked','retired'] as const)it(`rejects a ${state} login`,async()=>{const h=harness({[state]:true});expect((await h.run(request())).status).toBe(403);expect(h.counts().calls).toBe(0);});
 it('validates format and language before spending',async()=>{const h=harness();expect((await h.run(request('text/html'))).status).toBe(415);expect((await h.run(request('audio/mp4','invalid'))).status).toBe(400);expect(h.counts().calls).toBe(0);});
 for(const gate of ['quota','budget'] as const)it(`honors the ${gate} limit`,async()=>{const h=harness({[gate]:false});expect((await h.run(request())).status).toBe(429);expect(h.counts().calls).toBe(0);});
 it('returns plain words and settles the transcription charge',async()=>{const h=harness();const r=await h.run(request());expect(r.status).toBe(200);expect(await r.json()).toEqual({text:'Cuatro puertas.'});expect(h.counts()).toEqual({calls:1,releases:0,settles:1});expect(h.languages).toEqual(['es']);});
 // K2.6: Ask's microphone sends "auto" so English, Spanish or a mix is heard as spoken; the provider gets no forced language.
 it('lets Ask send "auto" and then forces no language on the provider',async()=>{const h=harness();expect((await h.run(request('audio/mp4','auto'))).status).toBe(200);expect(h.languages).toEqual([null]);});
 it('releases the reservation on provider failure',async()=>{const h=harness({providerStatus:500});expect((await h.run(request())).status).toBe(502);expect(h.counts()).toEqual({calls:1,releases:1,settles:0});});
});
