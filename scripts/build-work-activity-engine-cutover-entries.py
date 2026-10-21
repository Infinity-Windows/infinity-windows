#!/usr/bin/env python3
"""Reproduce reviewed activity entry fragments from frozen schema-only evidence.

This offline tool never connects to PostgreSQL, executes SQL, installs packages,
or edits a migration. Its output still requires independent source/runtime review.
Lexical call closure is an auditable candidate graph, not a parser-based proof.
"""
from pathlib import Path
import argparse, hashlib, json, re
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--schema-evidence',type=Path,required=True)
parser.add_argument('--output-directory',type=Path,required=True)
parser.add_argument('--ddl-rehearsal',action='store_true',help='Also freeze a harness-only DDL rehearsal from the guarded current migration; never executes SQL.')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
out=args.schema_evidence.resolve()
emit=args.output_directory.resolve()
emit.mkdir(parents=True,exist_ok=True)
e=json.loads((out/'ENGINE-CUTOVER-CLOSURE-EVIDENCE.json').read_text());authority_evidence=json.loads((out/'ENGINE-INSTALLED-AUTHORITY.json').read_text());cfg=json.loads((out/'ENGINE-INSTALLED-CONFIG.json').read_text());supp=json.loads((out/'ENGINE-INSTALLED-SUPPLEMENT.json').read_text())
actual={(f['name'],f['identity']):f for f in authority_evidence['functions']};configs={(f['name'],f['identity']):f for f in cfg['functions']};installed={(f['name'],f['identity']):f for f in supp['functions']}
functions=[]
for f in e['sourceExpectedFunctions']:
 x=f['expectedSource'];oid=(f['name'],f['installedIdentity'])
 if not x:continue
 if oid in actual:
  a=actual[oid];body=a['body'];definition=a['definition'];delimiter=re.search(r'\bas (\$[^$]*\$)',definition,re.I).group(1);header=definition[:definition.index(delimiter)]
 else:
  source=(root/'supabase/migrations'/x['source']).read_text();header=x['sourceHeader'];at=source.index(header);tail=source[at+len(header):];match=re.match(r'\s*(\$[a-z0-9_]*\$)',tail,re.I);delimiter=match.group(1);body=tail[match.end():].split(delimiter)[0]
  if hashlib.sha256(body.encode()).hexdigest()!=x['prosrcSha256']:raise ValueError('body drift '+f['identityTypes'])
 # Verify exact installed prosrc independently. Source ACL is not inferred.
 ins=installed[oid];expected=ins.get('bodySha256',ins.get('prosrcSha256'))
 if expected and hashlib.sha256(body.encode()).hexdigest()!=expected:raise ValueError('installed body mismatch '+f['identityTypes'])
 functions.append({**f,'body':body,'header':header,'config':configs[oid]})
allnames={f['name'] for f in functions};relations={x.split('.')[-1] for x in e['relations'] if x!='auth.users'}
relations|={'profiles','projects','project_openings','custom_work_units','sandbox_projects','company_settings','toolbox_completions','work_job_management_grants','work_job_menu_selections','work_activity_definitions','work_capture_menus','service_visits','service_visit_units'}
for f in functions:
 f['calls']=set(re.findall(r'\b([a-z_][a-z0-9_]*)\s*\(',f['body'],re.I))&allnames
# Mutation callback closure must include the table firing the callback, not
# merely lexical callers of its function name. Repeat FK ancestry afterwards.
fnbyoid={f['oid']:f['name'] for f in supp['functions']}
extra={'workflow_lock_writes','attach_sandbox_guards','_work_unit_fact_bump_epoch','_work_record_unit_fact'}
extra|={f['name'] for f in functions if f['name'].startswith('work_') and re.search(r'\b(insert\s+into|update|delete\s+from)\b',f['body'],re.I)}
extra|={f['name'] for f in functions if re.search(r'pg_(?:try_)?advisory_xact_lock\s*\(\s*639024\s*,\s*1\s*\)',f['body'],re.I)}
while True:
 before=set(relations)
 write=re.compile(r'\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|lock\s+table)\s+(?:public\.)?"?('+ '|'.join(sorted(relations))+r')\b',re.I)
 for f in functions:f['directRelations']=sorted(set(write.findall(f['body'])))
 closure={f['name'] for f in functions if f['directRelations']}|extra
 while True:
  n=closure|{f['name'] for f in functions if f['calls']&closure}
  if n==closure:break
  closure=n
 for t in supp['triggers']:
  table=t['table'].removeprefix('public.')
  if not t['internal'] and fnbyoid.get(t['functionOid']) in closure and '.' not in table:relations.add(table)
 for fk in authority_evidence['foreignKeys']:
  child=fk['child'].removeprefix('public.');parent=fk['parent'].removeprefix('public.')
  if child in relations and (fk['deleteAction'] in 'cnd' or fk['updateAction'] in 'cnd') and '.' not in parent:relations.add(parent)
 if before==relations:break
selected=[f for f in functions if f['name'] in closure]
# Token positions, excluding quoted bodies, literals and comments. This is not
# a SQL semantics parser; its narrow rewrites assert actual source shapes.
def tokens(s):
 p=0;n=len(s);result=[]
 while p<n:
  if s[p].isspace():p+=1;continue
  if s.startswith('--',p):
   q=s.find('\n',p);p=n if q<0 else q+1;continue
  if s.startswith('/*',p):
   d=1;p+=2
   while d and p<n:
    if s.startswith('/*',p):d+=1;p+=2
    elif s.startswith('*/',p):d-=1;p+=2
    else:p+=1
   if d:raise ValueError('unclosed comment')
   continue
  start=p
  if s[p] in "'\"":
   quote=s[p];p+=1
   while p<n:
    if s[p]==quote:
     p+=1
     if p<n and s[p]==quote:p+=1;continue
     break
    if s[p]=='\\':p+=2
    else:p+=1
   result.append(('quoted',start,p));continue
  if s[p]=='$':
   m=re.match(r'\$[a-zA-Z0-9_]*\$',s[p:])
   if m:
    q=s.find(m[0],p+len(m[0]));
    if q<0:raise ValueError('unclosed dollar')
    p=q+len(m[0]);result.append(('quoted',start,p));continue
  m=re.match(r'[a-zA-Z_][a-zA-Z0-9_$]*',s[p:])
  if m:p+=len(m[0]);result.append((m[0].lower(),start,p))
  else:p+=1;result.append((s[start:p],start,p))
 return result

def finish_returns(body,return_type):
 ts=tokens(body);edits=[]
 for i,(word,start,end) in enumerate(ts):
  if word!='return':continue
  if ts[i+1][0] in ('next','query'):continue
  j=i+1
  while ts[j][0]!=';':j+=1
  a,b=ts[j][1:]
  expression=body[end:a].strip()
  if not expression:replacement='perform public._work_activity_operation_exit(__work_activity_root_id); return;'
  else:
   if re.match(r'(setof|table)\b',return_type,re.I):raise ValueError('unexpected scalar return '+return_type)
   replacement=f'return public._work_activity_finish(__work_activity_root_id,({expression})::{return_type});'
  edits.append((start,b,replacement))
 for a,b,value in reversed(edits):body=body[:a]+value+body[b:]
 return body

overrides={'custom_work_follow_legacy','custom_work_follow_phase','service_follow_work','unit_sessions_follow_shift','unit_sessions_on_clock_in','custom_work_follow_shift','service_follow_shift','unit_sessions_follow_summon_helpers'}
legacy_payroll={'clock_in','clock_out','start_break','end_break'}
rows=[];guard=[];converted=[]
for f in selected:
 identity=f['identityTypes'];orig=f['body'];name=f['name'];trig=bool(re.search(r'returns\s+(?:pg_catalog\.)?trigger',f['header'],re.I));lang=installed[(name,f['installedIdentity'])]['language']
 newbody=orig;convert=not f['installedSecurityDefiner'] and name in legacy_payroll
 config=f['config'];ins=installed[(name,f['installedIdentity'])]
 guard.append({'identity':identity,'name':name,'arguments':f['installedIdentity'],'bodySha256':hashlib.sha256(orig.encode()).hexdigest(),'securityDefiner':f['installedSecurityDefiner'],'volatility':f['installedVolatility'],'acl':f['installedAcl'],'configSha256':config['configSha256'],'owner':ins['owner']})
 if name in overrides:continue
 if '__work_activity_' in orig:raise ValueError('new variable collision '+identity)
 rootop=(f['installedSecurityDefiner'] or convert) and not trig
 if lang=='sql':
  newbody='\nselect pg_catalog.pg_advisory_xact_lock(7712,0);\n'+orig
 elif lang=='plpgsql':
  if name=='complete_summon_help':
   # Deliberate safety correction to the otherwise preserved 20260818 body:
   # cancelling must not later become completion minutes via an old client.
   old='where summon_id = p_summon_id and profile_id = v_uid and completed_at is null'
   if newbody.count(old)!=1:raise ValueError('summon cancellation guard source drift '+identity)
   newbody=newbody.replace(old,old+' and canceled_at is null')
  # The paid-time selectors and original arithmetic share one post-G arrival.
  # No rounding or break total expression is changed by this replacement.
  if name in legacy_payroll or name in ('_close_dangling_shift','_end_open_session','_close_stale_sessions','clock_in_for'):
   newbody=re.sub(r'\bnow\s*\(\s*\)', '__work_activity_arrival',newbody,flags=re.I)
   newbody=re.sub(r'public\._clock_pick_time\(([^;]*?)\);',r'public._clock_pick_time_at(\1,__work_activity_arrival);',newbody)
  if name in legacy_payroll and 'p_tapped_at' in f['header'] and name!='clock_in':
   action={'clock_out':'clock_out','start_break':'break_start','end_break':'break_end'}[name]
   pattern=r'(v_pick := public\._clock_pick_time_at\([^;]+;)'
   match=re.search(pattern,newbody)
   if not match:raise ValueError('missing keyed clock picker '+identity)
   review=f"\n  if v_pick.pay_at is null then\n    v_shift:=public._work_activity_clock_review(p_shift_id,p_client_id,'{action}',p_tapped_at,p_clock_checked_at,p_clock_skew_ms);\n"
   review+="    return jsonb_build_object('outcome','requires_review','shift',to_jsonb(v_shift));\n" if name=='end_break' else "    return v_shift;\n"
   newbody=newbody[:match.end()]+review+'  end if;\n'+newbody[match.end():]
  if convert and name in ('clock_out','start_break','end_break'):
   action={'clock_out':'clock_out','start_break':'break_start','end_break':'break_end'}[name]
   begin=re.search(r'\bbegin\b',newbody,re.I).end()
   review=f"\n if exists(select 1 from public.time_shifts where id=p_shift_id and profile_id=auth.uid() and clock_out_at is null and status='open' and greatest(clock_in_at,last_punch_at,break_started_at)>__work_activity_arrival) then\n   return public._work_activity_clock_review(p_shift_id,null,'{action}',null,null,null);\n end if;\n"
   newbody=newbody[:begin]+review+newbody[begin:]
  if name=='_close_dangling_shift':
   at=re.search(r'\bbegin\b',newbody,re.I).end()
   newbody=newbody[:at]+"\n if exists(select 1 from public.time_shifts where profile_id=p_profile and status='open' and clock_out_at is null and greatest(clock_in_at,last_punch_at,break_started_at)>__work_activity_arrival) then raise exception 'Existing clock times need foreman review before a new shift can start.';end if;\n"+newbody[at:]
  if name=='clock_in' and 'p_tapped_at' in f['header']:
   # The explicit twelve-argument adapter alone may admit unsigned paid setup.
   # Ordinary eleven-argument calls consume no claim and retain old policy.
   old="  if not public._toolbox_gate_open(v_uid) then"
   if newbody.count(old)!=1:raise ValueError('keyed clock toolbox gate source drift '+identity)
   declaration='  v_had_open boolean;'
   if newbody.count(declaration)!=1:raise ValueError('keyed clock declaration drift '+identity)
   newbody=newbody.replace(declaration,declaration+'\n  v_setup_admitted boolean;')
   call='public._work_activity_claim_clock_setup(p_project_id,p_cost_code_id,p_photo,p_lat,p_lng,p_note,p_mode,p_client_id,p_tapped_at,p_clock_checked_at,p_clock_skew_ms)'
   newbody=newbody.replace(old,'  v_setup_admitted:='+call+';\n  if not public._toolbox_gate_open(v_uid) and not v_setup_admitted then')
  if name=='clock_in':
   call=re.search(r'perform (?:public\.)?_close_dangling_shift\(',newbody,re.I)
   if not call:raise ValueError('missing dangling guard '+identity)
   review="if exists(select 1 from public.time_shifts where profile_id=auth.uid() and status<>'voided' and greatest(clock_in_at,clock_out_at,last_punch_at,break_started_at)>__work_activity_arrival) then raise exception 'Existing clock times need foreman review before a new shift can start.';end if;\n  "
   newbody=newbody[:call.start()]+review+newbody[call.start():]
  if name=='clock_in' and convert:
   m=re.search(r'(insert\s+into\s+(?:public\.)?time_shifts\s*\()([^)]*)(\)\s*values\s*\()',newbody,re.I)
   if not m:raise ValueError('missing insert '+identity)
   if 'clock_in_at' in m[2]:raise ValueError('unexpected existing clock column '+identity)
   # Find the VALUES close, respecting nested SQL expressions and strings.
   ts=tokens(newbody[m.end():]);depth=1;end=None
   for t,a,b in ts:
    if t=='(':depth+=1
    elif t==')':
     depth-=1
     if depth==0:end=m.end()+a;break
   if end is None:raise ValueError('unclosed clock VALUES')
   newbody=newbody[:end]+', __work_activity_arrival, __work_activity_arrival'+newbody[end:]
   newbody=newbody[:m.start(2)]+m[2]+', clock_in_at, last_punch_at'+newbody[m.end(2):]
  if rootop:
   result=re.search(r'\breturns\s+([\s\S]*?)\s+language\b',f['header'],re.I)
   if not result:raise ValueError('return type '+identity)
   rettype=result[1].strip();newbody=finish_returns(newbody,rettype)
  if not newbody.rstrip().endswith(';'):newbody=newbody.rstrip()+';\n'
  # Exact existing storage callback is outside the public/provider boundary.
  # Its public invocations still take G before the original workflow lock.
  gate="if tg_table_schema='public' then perform pg_catalog.pg_advisory_xact_lock(7712,0);end if;" if name=='workflow_lock_writes' else 'perform pg_catalog.pg_advisory_xact_lock(7712,0);'
  if rootop:
   request={'custom_work_command':'p_id','service_command':'p_id','record_crew_work':'p_id','ai_field_command':'p_request'}.get(name,'p_client_id' if name in legacy_payroll and re.search(r'\bp_client_id\b',f['header']) else 'null')
   auth="" if not convert else "if auth.uid() is null or public.is_partner_user() then raise exception using errcode='42501',message='An identified internal clock actor is required.';end if;\n"
   # Invoker approved-hour guard would otherwise observe the definer role.
   if convert and name=='end_break':auth+="if current_setting('role') in ('authenticated','anon') and exists(select 1 from public.time_shifts where id=p_shift_id and profile_id=auth.uid() and status='approved') then raise exception 'Use the timecard editor to change approved time.';end if;\n"
   helper_auth=''
   if name in legacy_payroll and 'p_client_id' in f['header']:
    clock_action={'clock_in':'clock_in','clock_out':'clock_out','start_break':'break_start','end_break':'break_end'}[name]
    clock_shift='null' if name=='clock_in' else 'p_shift_id'
    helper_auth=f"perform public._work_activity_clock_replay_guard(p_client_id,'{clock_action}',{clock_shift});\n"
   if name in ('_close_dangling_shift','_end_open_session','_close_stale_sessions'):
    allowed=" and (public._work_activity_operation()).route<>'clock_in_for'" if name=='_close_dangling_shift' else ''
    helper_auth=f"if auth.uid() is not null and p_profile is distinct from auth.uid(){allowed} then raise exception using errcode='42501',message='This legacy timing helper is available only for your own activity.';end if;\n"
   newbody=f"\ndeclare __work_activity_root_id uuid;__work_activity_arrival timestamptz;\nbegin\n {gate}\n {auth} __work_activity_root_id:=public._work_activity_operation_enter('{name}','{{}}'::jsonb,{request});\n __work_activity_arrival:=(public._work_activity_operation()).arrival_at;\n {helper_auth}{newbody}\n perform public._work_activity_operation_exit(__work_activity_root_id);\nend;\n"
  else:newbody=f'\nbegin\n {gate}\n{newbody}\nend;\n'
 else:raise ValueError('unsupported language '+identity)
 if convert:converted.append(identity)
 rows.append({'identity':identity,'name':name,'arguments':f['installedIdentity'],'body':newbody,'convertInvokerPayroll':convert,'expectedBodySha256':hashlib.sha256(orig.encode()).hexdigest(),'newBodySha256':hashlib.sha256(newbody.encode()).hexdigest()})
# The retained profile census is deliberately restated below; guard its exact
# original body/authority too, although it is a stable read and not a writer.
for f in functions:
 if f['name']=='person_record_counts':
  ins=installed[(f['name'],f['installedIdentity'])]
  guard.append({'identity':f['identityTypes'],'name':f['name'],'arguments':f['installedIdentity'],'bodySha256':hashlib.sha256(f['body'].encode()).hexdigest(),'securityDefiner':f['installedSecurityDefiner'],'volatility':f['installedVolatility'],'acl':f['installedAcl'],'configSha256':f['config']['configSha256'],'owner':ins['owner']})
# Source metadata expectation is separate from original headers. At execution,
# use PostgreSQL's own exact installed header/defaults/OID/ACL; no source-default
# reconstruction and no function rename/private OID redirect is involved.
guard_sql="""-- INSTALLED_SOURCE_GUARD: runs before changing any existing definition.
do $activity_guard$
declare e jsonb;p record;
begin
 for e in select value from jsonb_array_elements($expected$EXPECTED$expected$::jsonb) loop
  select x.*,pg_get_userbyid(x.proowner) owner into p from pg_proc x where x.pronamespace='public'::regnamespace and x.proname=e->>'name' and pg_get_function_identity_arguments(x.oid)=e->>'arguments';
  if p.oid is null or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') is distinct from e->>'bodySha256'
    or p.prosecdef is distinct from (e->>'securityDefiner')::boolean or p.provolatile::text is distinct from e->>'volatility'
    or coalesce(to_jsonb(p.proacl),'null'::jsonb) is distinct from e->'acl' or p.owner is distinct from e->>'owner'
    or (case when p.proconfig is not null then encode(sha256(convert_to(p.proconfig::text,'UTF8')),'hex') end) is distinct from e->>'configSha256' then
    raise exception using errcode='23514',message='Installed activity entry drift requires review: '||(e->>'identity');
  end if;
 end loop;
end;
$activity_guard$;
""".replace('EXPECTED',json.dumps(guard,separators=(',',':')))
entry_values=[]
for i,r in enumerate(rows):
 delimiter=f'$activity_body_{i}$'
 if delimiter in r['body']:raise ValueError('entry body delimiter collision')
 identity=r['identity'].replace("'","''")
 entry_values.append(f"('{identity}'::text,{delimiter}{r['body']}{delimiter}::text,{str(r['convertInvokerPayroll']).lower()},'{r['expectedBodySha256']}'::text,'{r['newBodySha256']}'::text,'{r['name']}'::text,'{r['arguments'].replace(chr(39),chr(39)*2)}'::text)")
assembly="""-- INSTALLED_ENTRY_ASSEMBLY: exact reviewed bodies with G-first entry seams.
do $activity_entries$
declare item jsonb;definition text;delimiter text;start_at integer;original_acl aclitem[];original_owner oid;function_oid oid;
begin
 for item in select jsonb_build_object('identity',v.identity,'body',v.body,'convertInvokerPayroll',v.convert_invoker,
   'expectedBodySha256',v.old_sha,'newBodySha256',v.new_sha,'name',v.routine_name,'arguments',v.arguments) from (values
-- ENTRY_VALUES_BEGIN
RECORD_VALUES
-- ENTRY_VALUES_END
 ) v(identity,body,convert_invoker,old_sha,new_sha,routine_name,arguments) loop
  select p.oid into function_oid from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=item->>'name' and pg_get_function_identity_arguments(p.oid)=item->>'arguments';
  if function_oid is null then raise exception using errcode='23514',message='Installed activity entry identity is unavailable.';end if;
  select pg_get_functiondef(function_oid),proacl,proowner into definition,original_acl,original_owner from pg_proc where oid=function_oid;
  delimiter:=(regexp_match(definition,E'AS (\\\\$[^$]*\\\\$)'))[1];
  if delimiter is null or position(delimiter in item->>'body')>0 then raise exception 'Cannot preserve installed function delimiter.';end if;
  start_at:=position('AS '||delimiter in definition)+3+length(delimiter);
  definition:=left(definition,start_at-1)||(item->>'body')||delimiter||E';\\n';
  if (item->>'convertInvokerPayroll')::boolean then
    definition:=replace(definition,'LANGUAGE plpgsql',E'LANGUAGE plpgsql\\n SECURITY DEFINER');
  end if;
  execute definition;
  if (item->>'convertInvokerPayroll')::boolean then execute format('alter function %s set search_path=public,pg_temp',function_oid::regprocedure);end if;
  if (select proacl is distinct from original_acl or proowner is distinct from original_owner from pg_proc where oid=function_oid)
    or not exists(select 1 from pg_proc p where p.oid=function_oid and p.pronamespace='public'::regnamespace and p.proname=item->>'name' and pg_get_function_identity_arguments(p.oid)=item->>'arguments')
    or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=function_oid) is distinct from item->>'newBodySha256' then
    raise exception using errcode='23514',message='Activity entry replacement did not preserve its identity and ACL.';
  end if;
 end loop;
end;
$activity_entries$;
""".replace('RECORD_VALUES',',\n'.join(entry_values))
(emit/'activity-source-guard.sql').write_text(guard_sql)
(emit/'activity-entry-assembly.sql').write_text(assembly)
(emit/'entry-transform.json').write_text(json.dumps({'candidateOnly':True,'entryCount':len(rows),'guardCount':len(guard),'convertedLegacyPayroll':converted,'entries':[{k:v for k,v in r.items() if k!='body'} for r in rows]},indent=2)+'\n')
print(json.dumps({'guarded':len(guard),'replaced':len(rows),'legacyPayrollInvokers':converted,'assemblyBytes':len(assembly.encode())},indent=2))

parents={}
for f in selected:
 source=f['expectedSource']['source'];path=root/'supabase/migrations'/source
 parents[source]=hashlib.sha256(path.read_bytes()).hexdigest()
evidence_names=['ENGINE-CUTOVER-CLOSURE-EVIDENCE.json','ENGINE-INSTALLED-AUTHORITY.json','ENGINE-INSTALLED-CONFIG.json','ENGINE-INSTALLED-SUPPLEMENT.json']
manifest={
 'formatVersion':1,'activation':False,'candidateOnly':True,
 'scope':'Exact preserved entry replacement source; installed full graph/role/race closure remains required.',
 'publicRelationGateCandidates':sorted(relations),'entryCount':len(rows),'selectedSourceGuardCount':len(guard),
 'schemaEvidenceSha256':{n:hashlib.sha256((out/n).read_bytes()).hexdigest() for n in evidence_names},
 'sourceParentsSha256':dict(sorted(parents.items())),
 'entries':[{
  'identity':f['identityTypes'],'source':f['expectedSource']['source'],'sourceLine':f['expectedSource']['line'],
  'bodyOrigin':'installed_exact_definition' if (f['name'],f['installedIdentity']) in actual else 'latest_local_source_matches_installed_hash',
  'originalBodySha256':hashlib.sha256(f['body'].encode()).hexdigest(),
  'securityDefiner':f['installedSecurityDefiner'],'acl':f['installedAcl'],
  'callsInClosure':sorted(f['calls']&closure),'directRelationCandidates':f['directRelations'],
  'replacement':'manual_lifecycle_callback' if f['name'] in overrides else 'preserved_header_generated_entry',
  **({'deliberateSafetyCorrections':['completion excludes cancelled helper rows']} if f['name']=='complete_summon_help' else {}),
  **({'deliberateProtocolChanges':['keyed11 admits unsigned paid setup only through exact one-time private new12 root claim; ordinary11 policy unchanged']} if f['name']=='clock_in' and 'p_tapped_at' in f['header'] else {})
 } for f in selected],
 'limitations':['Lexical candidate graph requires installed FK/trigger/API review.',
  'Provider auth.users and drained administrator multi-statement maintenance are outside online G-first boundary.',
  'Legacy versionless writers have no invented expected-revision CAS.',
  'Generated fragments do not enable capture or attest execution.']}
(emit/'work-activity-engine-cutover-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

# Reproduce the complete installed authority graph without touching a database.
by={(x['name'],x['identity']):x for x in supp['functions']};funcs=[]
for f in e['sourceExpectedFunctions']:
 ins=by[(f['name'],f['installedIdentity'])]
 funcs.append({'identity':f['name']+'('+f['installedIdentity']+')','name':f['name'],'arguments':f['installedIdentity'],'bodySha256':ins['bodySha256'],'binarySha256':ins['binarySha256'],'securityDefiner':ins['securityDefiner'],'volatility':ins['volatility'],'acl':ins['acl'],'configSha256':ins['configSha256'],'owner':ins['owner'],'language':ins['language'],'kind':ins['kind']})
triggers=[{k:t[k] for k in ['table','name','definition','enabled']} for t in supp['triggers'] if t['table'] in relations and not t['internal']]
fks=[{k:f[k] for k in ['name','child','parent','childColumns','parentColumns','deleteAction','updateAction','deferrable','initiallyDeferred','validated']} for f in authority_evidence['foreignKeys']]
checks="""-- INSTALLED_GRAPH_GUARD: freeze the entire public executable surface, not
-- only intercepted writers. This prevents an added/changed invoker from
-- introducing a role-switching path before private maintenance admission.
-- Extension binary path hashes attest catalog identity, not provider binaries.
set local search_path=public,pg_temp;
do $activity_graph_guard$
declare e jsonb;routine_record record;actual jsonb;expected_routines jsonb:=$routines$ROUTINES$routines$::jsonb;
begin
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')<>730 then
   raise exception using errcode='23514',message='Installed public routine inventory changed.';end if;
 if (select count(distinct jsonb_build_array(v->>'name',v->>'arguments')) from jsonb_array_elements(expected_routines) v)<>jsonb_array_length(expected_routines) then
  raise exception using errcode='23514',message='Duplicate catalog routine identity in cutover manifest.';end if;
 select coalesce(jsonb_agg(v->>'identity'),'[]') into actual from jsonb_array_elements(expected_routines) v
 where not exists(select 1 from pg_proc x where x.pronamespace='public'::regnamespace and x.proname=v->>'name' and pg_get_function_identity_arguments(x.oid)=v->>'arguments');
 if jsonb_array_length(actual)<>0 then raise exception using errcode='23514',message='Installed routine identity preflight failed.',detail=actual::text;end if;
 for e in select value from jsonb_array_elements(expected_routines) loop
  select x.*,pg_get_userbyid(x.proowner) owner,l.lanname language into routine_record from pg_proc x join pg_language l on l.oid=x.prolang where x.pronamespace='public'::regnamespace and x.proname=e->>'name' and pg_get_function_identity_arguments(x.oid)=e->>'arguments';
  if routine_record.oid is null or encode(sha256(convert_to(routine_record.prosrc,'UTF8')),'hex') is distinct from e->>'bodySha256'
   or (case when routine_record.probin is not null then encode(sha256(convert_to(routine_record.probin,'UTF8')),'hex') end) is distinct from e->>'binarySha256'
   or routine_record.prosecdef is distinct from (e->>'securityDefiner')::boolean or routine_record.provolatile::text is distinct from e->>'volatility'
   or coalesce(to_jsonb(routine_record.proacl),'null'::jsonb) is distinct from e->'acl' or routine_record.owner is distinct from e->>'owner'
   or routine_record.language is distinct from e->>'language' or routine_record.prokind::text is distinct from e->>'kind'
   or (case when routine_record.proconfig is not null then encode(sha256(convert_to(routine_record.proconfig::text,'UTF8')),'hex') end) is distinct from e->>'configSha256' then
   raise exception using errcode='23514',message='Installed public authority drift requires review: '||(e->>'identity');end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('table',c.oid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled::text) order by c.oid::regclass::text collate "C",t.tgname collate "C"),'[]') into actual
 from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.oid::regclass::text in(select jsonb_array_elements_text($relations$RELATIONS$relations$::jsonb));
 if actual is distinct from $triggers$TRIGGERS$triggers$::jsonb then raise exception using errcode='23514',message='Installed source trigger graph changed.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('name',c.conname,'child',c.conrelid::regclass::text,'parent',c.confrelid::regclass::text,
  'childColumns',(select jsonb_agg(a.attname order by x.i) from unnest(c.conkey) with ordinality x(n,i) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=x.n),
  'parentColumns',(select jsonb_agg(a.attname order by x.i) from unnest(c.confkey) with ordinality x(n,i) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=x.n),
  'deleteAction',c.confdeltype::text,'updateAction',c.confupdtype::text,'deferrable',c.condeferrable,'initiallyDeferred',c.condeferred,'validated',c.convalidated)
  order by c.conrelid::regclass::text collate "C",c.conname collate "C"),'[]') into actual
 from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where c.contype='f' and n.nspname='public';
 if actual is distinct from $foreignkeys$FOREIGNKEYS$foreignkeys$::jsonb then raise exception using errcode='23514',message='Installed source foreign-key graph changed.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',to_jsonb(c.relacl)) order by c.oid::regclass::text collate "C"),'[]') into actual
 from pg_class c where c.oid::regclass::text in(select jsonb_array_elements_text($relationnames$RELATIONNAMES$relationnames$::jsonb));
 if actual is distinct from $relationauthority$RELATIONAUTHORITY$relationauthority$::jsonb then raise exception using errcode='23514',message='Installed source relation authority changed.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('table',p.polrelid::regclass::text,'name',p.polname,'command',p.polcmd::text,'permissive',p.polpermissive,
  'roles',(select jsonb_agg(r::text order by r) from unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polrelid::regclass::text collate "C",p.polname collate "C"),'[]') into actual
 from pg_policy p where p.polrelid::regclass::text in(select jsonb_array_elements_text($policynames$RELATIONNAMES$policynames$::jsonb));
 if actual is distinct from $policies$POLICIES$policies$::jsonb then raise exception using errcode='23514',message='Installed source row policies changed.';end if;
 if has_schema_privilege('authenticated','public','CREATE') or has_schema_privilege('anon','public','CREATE') or has_schema_privilege('service_role','public','CREATE') then
  raise exception using errcode='23514',message='Public schema creation authority changed.';end if;
end;
$activity_graph_guard$;

"""
relationauth=[{k:v for k,v in r.items() if k!='oid'} for r in supp['relations']]
for k,v in [('RELATIONAUTHORITY',sorted(relationauth,key=lambda r:r['name'])),('RELATIONNAMES',sorted(r['name'] for r in relationauth)),('POLICIES',sorted(supp['policies'],key=lambda p:(p['table'],p['name']))),('ROUTINES',funcs),('RELATIONS',sorted(relations)),('TRIGGERS',sorted(triggers,key=lambda t:(t['table'],t['name']))),('FOREIGNKEYS',sorted(fks,key=lambda f:(f['child'],f['name'])))]:checks=checks.replace(k,json.dumps(v,separators=(',',':')))

(emit/'activity-installed-graph-guard.sql').write_text(checks)

# Exact explicit runtime triggers; no provider-owned schema changes.
sources=['time_shifts','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_setup_sessions']
authorities=['profiles','projects','project_openings','custom_work_units','sandbox_projects','company_settings','toolbox_completions','work_job_management_grants','work_job_menu_selections','work_activity_definitions','work_capture_menus','service_visits','service_visit_units']
lines=['-- INSTALLED_TRIGGER_ASSEMBLY: explicit public runtime graph; auth.users is untouched.',
 'create trigger work_activity_retain_clock_receipt after insert on public.time_clock_actions for each row execute function public._work_activity_keep_clock_receipt();',
 'create trigger work_activity_clock_receipt_no_truncate before truncate on public.work_activity_clock_receipts for each statement execute function public._work_activity_no_truncate();']
for table in sorted(set(relations)|set(sources)):
 fn='_work_activity_statement_begin' if table in sources else '_work_activity_parent_gate'
 lines.append(f'create trigger "000_work_activity_gate" before insert or update or delete on public.{table} for each statement execute function public.{fn}();')
 lines.append(f'create trigger "000_work_activity_no_truncate" before truncate on public.{table} for each statement execute function public._work_activity_no_truncate();')
 if table in sources:
  lines.append(f'create trigger "000_work_activity_row" before insert or update or delete on public.{table} for each row execute function public._work_activity_row_before();')
  lines.append(f'create trigger zz_work_activity_row after insert or update or delete on public.{table} for each row execute function public._work_activity_row_event();')
  lines.append(f'create trigger zzz_work_activity_statement after insert or update or delete on public.{table} for each statement execute function public._work_activity_statement_end();')
 if table in authorities:lines.append(f'create trigger z_work_activity_authority after insert or update or delete on public.{table} for each row execute function public._work_activity_authority_changed();')
lines.extend(['create trigger zzz_work_activity_shift after insert or update or delete on public.time_shifts for each row execute function public._work_activity_shift_lifecycle();','create trigger "000_work_activity_profile_history" before delete on public.profiles for each row execute function public._work_activity_profile_delete_guard();'])

(emit/'activity-trigger-assembly.sql').write_text('\n'.join(lines)+'\n')

if args.ddl_rehearsal:
 out=emit
 source=root/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql';text=source.read_text();sha=hashlib.sha256(text.encode()).hexdigest()
 refusal="do $$ begin raise exception 'Activity cutover assembly is incomplete; installation is refused.'; end $$;"
 assert text.count(refusal)==1
 assert len(re.findall(r'^begin;$',text,re.M))==1 and text.rstrip().endswith('rollback;')
 fragment=text.replace(refusal,'-- Deliberately omitted ONLY in this forced-rollback DDL rehearsal.',1)
 fragment=re.sub(r'^begin;\n','',fragment,count=1,flags=re.M);fragment=fragment[:fragment.rindex('rollback;')]
 assert not re.search(r'^(?:begin|commit|rollback);$',fragment,re.M)
 entry=json.loads((emit/'entry-transform.json').read_text())['entries']
 private=[]
 for file in ['20261107020000_work_capture_foundation.sql','20261108000000_work_configuration.sql','20261108300000_work_unit_observations.sql','20261108400000_work_activity_engine_substrate.sql',source.name]:
  private+=re.findall(r'^create table public\.([a-z_]+)',(root/'supabase/migrations'/file).read_text(),re.M)
 assert len(private)==29
 prefix=text.split('-- DEVELOPMENT_PRIVATE_PREFIX:')[1].split('-- INSTALLED_ENTRY_ASSEMBLY:')[0]
 functions=[]
 for m in re.finditer(r'^create (?:or replace )?function public\.([a-z_][a-z0-9_]*)\([\s\S]*?\bas\s+(\$[a-z0-9_]*\$)',prefix,re.M|re.I):
  end=prefix.index(m[2],m.end());body=prefix[m.end():end];functions.append({'name':m[1],'sha256':hashlib.sha256(body.encode()).hexdigest()})
 assert len(functions)>50
 new_count=len(re.findall(r'^create function public\.',prefix,re.M))
 triggers=[]
 for line in text.split('-- INSTALLED_TRIGGER_ASSEMBLY:')[1].splitlines():
  if not line.startswith('create trigger '):continue
  m=re.fullmatch(r'create trigger "?([a-z_0-9]+)"? (before|after) (.+) on public\.([a-z_]+) for each (statement|row) execute function public\.([a-z_]+)\(\);',line)
  assert m,line
  bits=(1 if m[5]=='row' else 0)+(2 if m[2]=='before' else 0)+sum({'insert':4,'delete':8,'update':16,'truncate':32}[e] for e in m[3].split(' or '))
  triggers.append({'name':m[1],'table':m[4],'function':m[6],'type':bits})
 expected={'sourceSha256':sha,'entryCount':len(entry),'newFunctionCount':new_count,'prefixBodies':len(functions),'explicitTriggers':len(triggers),'privateTables':len(private)}
 header=f'''-- FORCED-ROLLBACK FULL-DDL REHEARSAL ONLY. Never a deployment migration.
 -- Exact guarded repository source SHA256: {sha}
 -- Stage exact08400000 first in the SAME db_dry_run transaction.
 -- Only the explicit assembly refusal and outer BEGIN/ROLLBACK are omitted;
 -- the established harness owns and forces rollback. No operational row writes.
 select pg_temp.dry_run_as_system();
 set local statement_timeout='60s';
 set local lock_timeout='3s';
 set local check_function_bodies=on;
 '''
 checks='''
 -- Metadata-only acceptance. No public timing RPC or operational data is called.
 do $activity_ddl_rehearsal$
 declare e jsonb;r record;relation_name text;role_name text;relation_oid oid;private_names text[]:=ARRAY[PRIVATE];
 begin
  perform pg_temp.dry_run_check('cutover/publicRoutineCensus',(select count(*) from pg_proc where pronamespace='public'::regnamespace)=EXPECTEDCOUNT,'730 staged routines plus exact newly authored function count');
  for e in select value from jsonb_array_elements($entryproof$ENTRIES$entryproof$::jsonb) loop
   select p.oid,p.prosrc into r from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=e->>'name' and pg_get_function_identity_arguments(p.oid)=e->>'arguments';
   perform pg_temp.dry_run_check('cutover/entry/'||(e->>'identity'),r.oid is not null and encode(sha256(convert_to(r.prosrc,'UTF8')),'hex')=e->>'newBodySha256','Exact generated body; assembly separately asserts original OID/owner/ACL preservation');
  end loop;
  for e in select value from jsonb_array_elements($bodyproof$BODIES$bodyproof$::jsonb) loop
   perform pg_temp.dry_run_check('cutover/body/'||(e->>'name'),exists(select 1 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=e->>'name' and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e->>'sha256'),'Exact authored helper/read/callback body present; execution not implied');
  end loop;
  for e in select value from jsonb_array_elements($triggerproof$TRIGGERS$triggerproof$::jsonb) loop
   perform pg_temp.dry_run_check('cutover/trigger/'||(e->>'table')||'/'||(e->>'name'),exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid=to_regclass('public.'||(e->>'table')) and t.tgname=e->>'name' and not t.tgisinternal and t.tgenabled='O'
     and t.tgtype=(e->>'type')::integer and t.tgqual is null and t.tgnargs=0 and p.pronamespace='public'::regnamespace and p.proname=e->>'function'),'Exact event/level/when/enabled callback binding');
  end loop;
  foreach relation_name in array private_names loop
   relation_oid:=to_regclass('public.'||relation_name);
   perform pg_temp.dry_run_check('cutover/privateRls/'||relation_name,relation_oid is not null and (select relrowsecurity from pg_class where oid=relation_oid),'Private protocol relation RLS enabled');
   foreach role_name in array array['anon','authenticated'] loop
    perform pg_temp.dry_run_check('cutover/privateAcl/'||relation_name||'/'||role_name,
     not has_table_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     and not has_any_column_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,REFERENCES'),'No direct table or column grants');
   end loop;
  end loop;
  perform pg_temp.dry_run_check('cutover/captureDisabled',(select count(*)=1 and bool_and(not capture_enabled) from public.work_activity_authority_generation),'Default false; not changed by rehearsal');
  perform pg_temp.dry_run_check('cutover/ephemeralEmpty',not exists(select 1 from public.work_activity_operations) and not exists(select 1 from public.work_activity_operation_people)
   and not exists(select 1 from public.work_activity_operation_events) and not exists(select 1 from public.work_activity_statement_frames)
   and not exists(select 1 from public.work_activity_transaction_context) and not exists(select 1 from public.work_activity_expected_mutations),'No operational commands or source fixtures were invoked');
  perform pg_temp.dry_run_check('cutover/clockReceiptNoCascade',not exists(select 1 from pg_constraint where conrelid='public.work_activity_clock_receipts'::regclass and contype='f'),'Original UUID evidence has no source/profile FK');
  perform pg_temp.dry_run_check('cutover/clockReceiptCensus',position('work_activity_clock_receipts.profile_id' in (select prosrc from pg_proc where oid='public.person_record_counts(uuid)'::regprocedure))>0,'Retained clock profile identity counted without reading employee data');
 end;
 $activity_ddl_rehearsal$;
 '''
 checks=checks.replace('PRIVATE',','.join("'"+n+"'" for n in private)).replace('EXPECTEDCOUNT',str(730+new_count)).replace('ENTRIES',json.dumps(entry,separators=(',',':'))).replace('BODIES',json.dumps(functions,separators=(',',':'))).replace('TRIGGERS',json.dumps(triggers,separators=(',',':')))
 probe=header+fragment+checks
 out.mkdir(exist_ok=True)
 (out/'ENGINE-CUTOVER-DDL-REHEARSAL-SOURCE.sql').write_text(text)
 (out/'ENGINE-CUTOVER-DDL-REHEARSAL-PROBE.sql').write_text(probe)
 expected['probeSha256']=hashlib.sha256(probe.encode()).hexdigest();expected['sourceBytes']=len(text.encode());expected['probeBytes']=len(probe.encode());expected['assertions']=1+len(entry)+len(functions)+len(triggers)+3*len(private)+4
 expected['scope']='Forced rollback DDL/metadata only; no operational source rows, no activation, no full runtime claim.'
 (out/'ENGINE-CUTOVER-DDL-REHEARSAL-MANIFEST.json').write_text(json.dumps(expected,indent=2)+'\n')
 print(json.dumps(expected,indent=2))
