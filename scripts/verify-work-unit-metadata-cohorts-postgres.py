#!/usr/bin/env python3
"""HELD0848 genuine local PG17 roles/races/volume. Never contacts a provider.
Requires exact0841/44/45/46 installed by source-matched predecessor fixtures.
--check-plan is static only. Default executes all9 volume combinations,20 samples
per combination,20s statements/12s locks. Partial evidence survives failures.
"""
import hashlib,json,os,re,statistics,subprocess,sys,time
from pathlib import Path
from urllib.parse import urlparse,urlunparse
ROOT=Path(__file__).resolve().parent.parent
SOURCE=ROOT/'supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql'
source=SOURCE.read_text();sha=hashlib.sha256(source.encode()).hexdigest()
assert sha=='d064823cd81ae55220568d5d02cd2abb84251449bde86c9b3b6e75fc0521e143','Refused: unreviewed metadata candidate source'
assert re.search(r'rollback;\s*$',source)
PINS={'20261108410000_work_activity_engine_cutover.sql':'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648','20261108440000_work_unit_review.sql':'e32122a581bf995857983cc433323bc490381b6eb217c583bf95fd7376b3e53f','20261108450000_work_activity_totals.sql':'e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140','20261108460000_work_unit_contributors.sql':'ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5'}
for file,digest in PINS.items():assert hashlib.sha256((ROOT/'supabase/migrations'/file).read_bytes()).hexdigest()==digest,file
assert sys.argv[1:] in ([],['--check-plan'])
PLAN={'result':'PLAN VALIDATED','databaseTests':False,'sourceSha256':sha,'matrix':[[r,u] for r in (0,1000,10000) for u in (1,10,100)],'samplesPerTier':20,'seedBatchSize':100,'timeoutsSeconds':{'statement':20,'lock':12},'baseline':'Existing full source census retained separately; tier rows are additional verified unrelated sources, not a claim existing database has zero history','actualRoleTests':['nonsuperuser postgres and noninheriting authenticator','anon/service deny RPC and private rows','column/function/namespace drift refusal','author role, revoked actor and current/original scope after actual G waits'],'waits':['two same-CAS commands serialize: one applied, one stale','actual project hide then blocked read generic unavailable','actual actor revoke then blocked read rejected','moved A-to-B unit: actual retained original metadata job A hidden while read waits on G; current B remains visible','active cohort RPC versus actual start_break, then end_break/out; max2 attempts, no artificial idle hold'],'ledger':'single invocation per distinct shift is source-structural only; no runtime call count is measured','evidence':['exact source/harness/guard hashes','verified live/history/transition seed counts','20 latency samples median/p95/max','Targeted privileged history/live/transition plans plus authored live-helper expanded body before the active paid edge; each tier RPC EXPLAIN remains top-level only','pg_blocking_pids plus active holder','partial persisted phase/failure']}
if sys.argv[1:]:print(json.dumps(PLAN));sys.exit()
p=urlparse(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
if p.scheme not in ('postgres','postgresql') or p.hostname not in ('localhost','127.0.0.1') or p.port not in (None,5432) or p.path!='/forge_work_activity_role_test' or p.username!='supabase_admin' or p.query or p.fragment:raise SystemExit('Refused: exact disposable localhost database required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):return urlunparse((p.scheme,f'{user}:fixture-only@{p.hostname}:{p.port or 5432}',p.path,'','',''))
def lit(v):return 'null' if v is None else "'"+str(v).replace("'","''")+"'"
def ident(n):return '00000000-0000-4000-8000-'+str(650000+n).zfill(12)
checks=0
report={'sourceSha256':sha,'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'status':'running','stage':'admission','scope':'Disposable actual PG17 only; no provider operations','plan':PLAN,'seedBatches':[],'tiers':[],'waits':[],'wire':[],'coverageLimits':{'ledgerRuntimeInvocationCountMeasured':False,'denseSharedOrDistinctShiftLoadFor10And100Units':False,'originalOriginAfterG':'prepared retained metadata-job case, not executed until its observed wait passes','nestedPlansMeasured':False}}
def persist(stage=None):
 if stage:report['stage']=stage
 report['checks']=checks
 if os.environ.get('WORK_UNIT_METADATA_COHORTS_PG_OUT'):
  f=Path(os.environ['WORK_UNIT_METADATA_COHORTS_PG_OUT']);t=f.with_name(f.name+'.tmp');t.write_text(json.dumps(report,indent=2)+'\n');t.replace(f)
def fail(kind,error,traceback):
 report['status']='failed';report['failure']={'type':kind.__name__,'message':str(error)[-2500:]};persist();sys.__excepthook__(kind,error,traceback)
sys.excepthook=fail
persist()
def run(sql,user='postgres',error=None):
 r=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input="\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s';"+sql,text=True,capture_output=True,timeout=30,env=env)
 if error:assert r.returncode and re.search(r'\b'+error+r'\b',r.stderr),(error,r.stderr[-2200:]);return
 assert r.returncode==0,r.stderr[-2500:];return r.stdout.strip()
def obj(sql,user='postgres'):return json.loads(run(sql,user).splitlines()[-1])
def check(ok,label):
 global checks
 assert ok,label;checks+=1;persist();print('PASS',checks,label,flush=True)
def auth(actor):return 'set role authenticated;set request.jwt.claim.sub='+lit(actor)+';'
worker,reviewer,job,other,opening,unit,device,generation=[ident(x) for x in (1,2,10,11,20,30,40,41)]
def rpc(sql,actor=worker):return obj(auth(actor)+sql,'authenticator')
def batch(actor=worker):return rpc('select work_unit_cohorts_read('+lit(job)+",1,'{}');",actor)
def readunit(actor=worker):return rpc('select work_unit_metadata_read('+lit(unit)+',1);',actor)
def command(cid,action,data,actor=worker):
 payload={'action':action,'data':data};answer=rpc('select work_unit_metadata_command('+lit(cid)+',1,'+lit(json.dumps(payload))+'::jsonb);',actor);report['wire'].append({'request':payload,'reply':answer});return answer
check(run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t','Actual nonsuperuser owner session')
check(run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)",'authenticator')=='t','Actual noninheriting authenticator session')
check(run("select current_setting('server_version_num')::int/10000")=='17','Actual PostgreSQL17')
check(run('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()')=='t','Exact frozen predecessor guards')
ns=source[source.index('do $namespace$'):source.index('end $namespace$;')+len('end $namespace$;')]
for ddl in ("create function work_unit_metadata_read(text) returns int language sql as 'select 1'","create function work_unit_metadata_command(text) returns int language sql as 'select 1'","create function work_unit_metadata_receipt(text) returns int language sql as 'select 1'","create function work_unit_cohorts_read(text) returns int language sql as 'select 1'","create type _work_unit_metadata_unknown as enum('unknown')",'create table _work_unit_metadata_unknown(id int)'):
 run('begin;'+ddl+';'+ns,error='55000');check(True,'Metadata-only namespace preflight rejects '+ddl)
run(re.sub(r'rollback;\s*$','commit;',source))
check(run('select _work_unit_metadata_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()')=='t','Actual installed new and frozen guards agree')
for role in ('anon','authenticated','service_role','public'):
 for permission in ('SELECT','INSERT','UPDATE','REFERENCES'):
  check(run('begin;grant '+permission+'(actor_id) on _work_unit_metadata_revisions to '+role+';select not _work_unit_metadata_coverage();rollback;')=='t','Actual column ACL drift '+role+' '+permission+' refuses')
for ddl in ('grant execute on function work_unit_cohorts_read(uuid,integer,jsonb) to service_role','grant execute on function _work_unit_metadata_members(uuid[]) to authenticated','alter table _work_unit_metadata_current disable row level security',"create function _work_unit_metadata_unknown() returns int language sql as 'select 1'"):
 check(run('begin;'+ddl+';select not _work_unit_metadata_coverage();rollback;')=='t','Exact source mutation refuses '+ddl)
for role in ('anon','service_role'):
 run('set role '+role+';select work_unit_cohorts_read('+lit(job)+',1);','authenticator',error='42501');check(True,role+' cannot call new RPC')
for role in ('anon','authenticated','service_role'):
 run('set role '+role+';select * from _work_unit_metadata_revisions;','authenticator',error='42501');check(True,role+' cannot read private history')
report['baselineCensus']=obj("select jsonb_build_object('history',(select count(*) from work_activity_source_history),'live',(select count(*) from _work_unit_review_live_sources),'transitions',(select count(*) from personal_activity_transition_sources),'units',(select count(*) from custom_work_units))");persist('supported_setup')
run('insert into auth.users(id) values('+lit(worker)+'),('+lit(reviewer)+');insert into profiles(id,display_name,role,is_test) values('+lit(worker)+",'Cohort fixture author','owner',false),("+lit(reviewer)+",'Cohort fixture reviewer','owner',false);insert into projects(id,job_code,name) values("+lit(job)+",'COHORT-PG','Synthetic cohort'),("+lit(other)+",'COHORT-PG-UNRELATED','Synthetic unrelated');insert into project_openings(id,project_id,opening_code) values("+lit(opening)+','+lit(job)+",'COHORT-PG-UNIT');")
def createunit(uid,index):
 payload={'id':uid,'revision':0,'project_id':job,'opening_id':opening if uid==unit else None,'label':'Cohort unit '+str(index),'type_label':'Unclassified','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
 check(rpc('select to_jsonb(custom_work_command('+lit(ident(10000+index))+",'unit',"+lit(json.dumps(payload))+'::jsonb));')==uid,'Supported unit creation '+str(index))
createunit(unit,0)
unknown={'category':{'state':'unknown'},'subtype':{'state':'unknown'},'frameMaterial':{'state':'unknown'},'components':[],'fields':[]}
view=readunit();data={'unitId':unit,'basis':view['metadata']['metadataBasis'],'classification':unknown}
first=command(ident(101),'assign',data);check(first['receipt']['status']=='applied','Actual owner assigns immutable metadata')
check(command(ident(101),'assign',data)==first,'Actual immutable duplicate receipt')
check(rpc('select work_unit_metadata_receipt('+lit(ident(101))+',1);',reviewer)['availability']=='unavailable','Actual foreign receipt denied')
# A supported missing-dimension unit can be recreated under the same UUID;
# immutable command authority must retain its original server incarnation.
recreated=ident(31);recreate_payload={'id':recreated,'revision':0,'project_id':job,'opening_id':None,'label':'Receipt incarnation','type_label':'Unknown','facts':{}}
def create_recreated(cid):return rpc('select to_jsonb(custom_work_command('+lit(cid)+",'unit',"+lit(json.dumps(recreate_payload))+'::jsonb));')
check(create_recreated(ident(110))==recreated,'Actual supported incarnation test unit')
original=rpc('select work_unit_metadata_read('+lit(recreated)+',1);')['metadata'];old_data={'unitId':recreated,'basis':original['metadataBasis'],'classification':unknown}
old_receipt=command(ident(111),'assign',old_data);check(old_receipt['receipt']['status']=='applied','Actual original incarnation receipt')
run('delete from custom_work_units where id='+lit(recreated));check(create_recreated(ident(112))==recreated,'Actual supported same UUID recreation')
fresh=rpc('select work_unit_metadata_read('+lit(recreated)+',1);')['metadata']
check(fresh['metadataBasis']['binding']['incarnation']!=original['metadataBasis']['binding']['incarnation'] and fresh['classification']['state']=='noncurrent','Actual recreated UUID does not inherit classification')
check(rpc('select work_unit_metadata_receipt('+lit(ident(111))+',1);')['availability']=='unavailable','Actual old incarnation receipt hidden')
check(command(ident(111),'assign',old_data)['availability']=='unavailable','Actual old incarnation duplicate cannot replay')
check(command(ident(113),'assign',{**old_data,'basis':fresh['metadataBasis']})['receipt']['status']=='applied','Actual new incarnation explicit assignment')
run('delete from custom_work_units where id='+lit(recreated))
# Actual authenticator connections exercise all four formerly admitted entry
# paths after a committed select-true attester replacement. Old guards stay
# true, so neither role denial nor a frozen guard can mask this regression.
coverage_definition=run("select pg_get_functiondef('_work_unit_metadata_coverage()'::regprocedure)")
for drift,restore in [(None,None),('grant select(actor_id) on _work_unit_metadata_revisions to authenticated','revoke select(actor_id) on _work_unit_metadata_revisions from authenticated'),('alter table _work_unit_metadata_commands add column unexpected_fixture text','alter table _work_unit_metadata_commands drop column unexpected_fixture')]:
 check(readunit()['availability']=='available' and batch()['availability']=='available' and rpc('select work_unit_metadata_receipt('+lit(ident(101))+',1);')['availability']=='available','Actual admitted positive paths before attester mutation')
 try:
  run("create or replace function _work_unit_metadata_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as 'select true';"+(drift+';' if drift else ''))
  check(run('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()')=='t','Frozen guards still true during attester replacement')
  check(readunit()=={'protocolVersion':1,'availability':'unavailable','metadata':None},'Actual read refuses replaced attester')
  check(batch()=={'protocolVersion':1,'availability':'unavailable','cohort':None},'Actual batch refuses replaced attester')
  check(command(ident(109),'assign',data)=={'protocolVersion':1,'availability':'unavailable','receipt':None},'Actual command refuses replaced attester')
  check(rpc('select work_unit_metadata_receipt('+lit(ident(101))+',1);')=={'protocolVersion':1,'availability':'unavailable','receipt':None},'Actual existing receipt refuses replaced attester')
 finally:
  if restore:run(restore)
  run(coverage_definition)
 check(run('select _work_unit_metadata_coverage()')=='t','Exact attester restoration re-admits expected source')
run("update profiles set role='installer' where id="+lit(worker))
check(readunit()['metadata']['capabilities']['assign'],'Installer unit author remains admitted')
run(auth(worker)+'select work_unit_cohorts_read('+lit(job)+',1);','authenticator',error='42501')
run("update profiles set role='owner' where id="+lit(worker))
# Real actor clock setup mirrors the supported source-matched fixture. No direct
# toolbox insertion, fabricated private capture row, or helper exposure.
rpc('select work_publish_activity_version('+lit(ident(102))+",'cohort_pg_specific',0,'specific','Cohort','Cohort',false,'[]');")
definition=obj("select to_jsonb(v) from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='cohort_pg_specific'")
rpc('select work_publish_menu_version('+lit(ident(103))+",'cohort_pg_menu',0,'Cohort','Cohort',"+lit(json.dumps([{'definitionId':definition['definition_id'],'versionId':definition['id'],'position':0,'enabled':True}]))+'::jsonb);')
menu=run("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='cohort_pg_menu'")
rpc('select work_select_job_menu('+lit(ident(104))+','+lit(job)+','+lit(menu)+',0);');selection=obj('select to_jsonb(s) from work_job_menu_selections s where project_id='+lit(job))
run('begin;select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1;commit;')
check(rpc('select to_jsonb(sign_toolbox_talk('+lit(ident(105))+','+lit(worker)+",null::uuid,'Synthetic signature',null::text,null::text,'Cohort local fixture',clock_timestamp()));")['profile_id']==worker,'Actual toolbox signing entry')
shift=rpc('select to_jsonb(clock_in('+lit(job)+'::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'+lit(ident(106))+"::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1));")['id']
sequence=0;head=None
def activity(intent):
 global sequence,head
 snap=rpc('select work_activity_snapshot('+lit(device)+');');cid=ident(200+sequence);stamp=run("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
 payload={'deviceId':device,'clientGeneration':generation,'clientSequence':sequence,'predecessorCommandId':head,'expectedRevision':snap['state']['revision'],'basis':{'observationId':snap['observation']['id']},'shiftRef':snap['observation']['shiftRef'],'tappedAt':stamp,'clockCheckedAt':stamp,'clockSkewMs':0,'intent':intent}
 answer=rpc('select work_activity_command('+lit(cid)+',1,'+lit(json.dumps(payload))+'::jsonb);');assert answer['receipt']['status'] in ('noop','applied'),answer;sequence+=1;head=cid;return answer
activity({'kind':'establish_stream','previousGeneration':None,'previousHeadCommandId':None});activity({'kind':'finish_setup','projectId':job,'costCodeId':None})
b=rpc('select work_activity_unit_basis('+lit(unit)+');')['unit'];basis={k:b[k] for k in ('id','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch')};basis.update({'factId':b['fact']['id'],'factRevision':b['fact']['revision'],'originProjectEpoch':b['fact']['originProjectEpoch'],'originOpeningEpoch':b['fact']['originOpeningEpoch']})
activity({'kind':'switch','projectId':job,'selectionId':selection['id'],'selectionRevision':selection['revision'],'menuVersionId':menu,'definitionVersionId':definition['id'],'scope':'specific','unit':basis,'machineKind':None,'values':{}})
check(batch()['availability']=='available','Actual live source admits complete batch envelope without fabricated eligibility')
def start(sql,user='authenticator'):
 proc=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);proc.stdin.write("\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s';"+sql+'\n');proc.stdin.flush();return proc
def finish(proc,sql='',error=None):
 if sql:proc.stdin.write(sql+'\n');proc.stdin.flush()
 proc.stdin.close();proc.stdin=None;out,err=proc.communicate(timeout=25)
 if error:assert proc.returncode and re.search(r'\b'+error+r'\b',err),(out,err[-2200:]);return out
 assert proc.returncode==0,err[-2200:];return out
def stop(proc):
 if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=3)
def until(sql,seconds=5):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if run(sql)=='t':return True
  time.sleep(.015)
 return False
blocked="select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='cohort_holder' and b.application_name='cohort_waiter' and a.pid=any(pg_blocking_pids(b.pid)))"
for case,change in [('project_hide','update projects set deleted_at=clock_timestamp() where id='+lit(job)),('actor_revoke','update profiles set access_revoked_at=clock_timestamp() where id='+lit(worker))]:
 a=b=None
 try:
  a=start("set application_name='cohort_holder';begin;"+change+';','postgres');assert until("select exists(select 1 from pg_stat_activity where application_name='cohort_holder' and state='idle in transaction')")
  b=start("set application_name='cohort_waiter';"+auth(worker)+'select work_unit_cohorts_read('+lit(job)+',1);');assert until(blocked);finish(a,'commit;')
  if case=='project_hide':assert json.loads(finish(b).splitlines()[-1])=={'protocolVersion':1,'availability':'unavailable','cohort':None}
  else:finish(b,error='42501')
  report['waits'].append({'case':case,'observed':True,'holder':'actual source mutation','result':'generic unavailable' if case=='project_hide' else '42501'});check(True,'Actual post-G '+case+' refreshed')
 finally:stop(a);stop(b)
 run('update projects set deleted_at=null where id='+lit(job)+';update profiles set access_revoked_at=null where id='+lit(worker))
# Retained metadata origin A must remain visible after a supported A-to-B
# rebind. Missing dimensions keep this fixture independent of fact re-observation.
# It covers the original metadata-job gate; original fact/service/opening races
# remain separate variants and are not claimed here.
origin_a,origin_b,moved=ident(60),ident(61),ident(62)
run('insert into projects(id,job_code,name) values('+lit(origin_a)+",'COHORT-ORIGIN-A','Origin A'),("+lit(origin_b)+",'COHORT-CURRENT-B','Current B');")
create_moved={'id':moved,'revision':0,'project_id':origin_a,'opening_id':None,'label':'Moved original origin','type_label':'Unknown','facts':{}}
check(rpc('select to_jsonb(custom_work_command('+lit(ident(63))+",'unit',"+lit(json.dumps(create_moved))+'::jsonb));')==moved,'Supported original-A unit')
original=rpc('select work_unit_metadata_read('+lit(moved)+',1);')['metadata']
check(command(ident(64),'assign',{'unitId':moved,'basis':original['metadataBasis'],'classification':unknown})['receipt']['status']=='applied','Retained original-A metadata binding')
moved_row=obj('select to_jsonb(u) from custom_work_units u where id='+lit(moved))
rebind={**create_moved,'revision':moved_row['revision'],'project_id':origin_b,'reason':'Explicit synthetic original-origin move'}
check(rpc('select to_jsonb(custom_work_command('+lit(ident(65))+",'unit',"+lit(json.dumps(rebind))+'::jsonb));')==moved,'Supported A-to-B rebind')
positive=rpc('select work_unit_metadata_read('+lit(moved)+',1);')
check(positive['availability']=='available' and positive['metadata']['classification']['state']=='noncurrent','Moved current-B unit admitted before original revocation')
a=b=None;origin_wait={'case':'retained_metadata_origin_hide','originalProjectId':origin_a,'currentProjectId':origin_b,'observed':False,'stage':'prepared'};report['waits'].append(origin_wait);persist()
try:
 a=start("set application_name='cohort_holder';begin;update projects set deleted_at=clock_timestamp() where id="+lit(origin_a)+';','postgres');assert until("select exists(select 1 from pg_stat_activity where application_name='cohort_holder' and state='idle in transaction')")
 b=start("set application_name='cohort_waiter';"+auth(worker)+'select work_unit_metadata_read('+lit(moved)+',1);');assert until(blocked);origin_wait.update({'observed':True,'stage':'blocked_on_original_mutation'});persist()
 finish(a,'commit;');reply=json.loads(finish(b).splitlines()[-1]);assert reply=={'protocolVersion':1,'availability':'unavailable','metadata':None}
 check(run('select _ai_job_visible('+lit(origin_b)+','+lit(worker)+') and not _ai_job_visible('+lit(origin_a)+','+lit(worker)+')')=='t','Current B remains visible while original A is hidden')
 check(rpc('select work_unit_metadata_receipt('+lit(ident(64))+',1);')['availability']=='unavailable','Original-A historical receipt also remains hidden')
 origin_wait.update({'stage':'passed','result':'generic unavailable'});report['coverageLimits']['originalOriginAfterG']='observed retained metadata-job A revocation on moved current-B unit; fact/service/opening variants not covered';check(True,'Actual original metadata origin refreshed after G wait')
finally:
 stop(a);stop(b);run('update projects set deleted_at=null where id='+lit(origin_a))

# Same read-derived CAS on two genuine connections. The first real command
# holds its ordinary transaction; this is CAS proof, not active-read latency.
view=readunit();data={'unitId':unit,'basis':view['metadata']['metadataBasis'],'classification':unknown};a=b=None
try:
 def cq(cid):return 'select work_unit_metadata_command('+lit(cid)+',1,'+lit(json.dumps({'action':'assign','data':data}))+'::jsonb);'
 a=start("set application_name='cohort_holder';begin;"+auth(worker)+cq(ident(300)));assert until("select exists(select 1 from pg_stat_activity where application_name='cohort_holder' and state='idle in transaction')")
 b=start("set application_name='cohort_waiter';"+auth(worker)+cq(ident(301)));assert until(blocked)
 ra=json.loads(finish(a,'commit;').splitlines()[-1]);rb=json.loads(finish(b).splitlines()[-1]);check(ra['receipt']['status']=='applied' and rb['receipt']['status']=='rejected' and rb['receipt']['reason']=='stale_basis','Actual simultaneous command CAS produces one applied and one rejected')
 report['waits'].append({'case':'same_metadata_CAS','observed':True})
finally:stop(a);stop(b)
# Actual physical writer versus the two intentionally different CAS bases.
# A new fact invalidates floor CAS but not classification binding CAS.
for offset,action in enumerate(('assign','allocate')):
 before_view=readunit()['metadata'];unit_row=obj('select to_jsonb(u) from custom_work_units u where id='+lit(unit))
 change={'id':unit,'revision':unit_row['revision'],'project_id':job,'opening_id':opening,'label':unit_row['label'],'type_label':unit_row['type_label'],'facts':{},'dimension_observation':{'width':37+offset,'height':48,'unit':'in','source':'measured'},'expected_fact_revision':before_view['floorBasis']['factRevision']}
 waiting={'unitId':unit,'basis':before_view['metadataBasis' if action=='assign' else 'floorBasis']}
 waiting.update({'classification':unknown} if action=='assign' else {'state':'unknown','shares':[],'reason':'Synthetic source revision race'})
 a=b=None
 try:
  a=start("set application_name='cohort_holder';begin;"+auth(worker)+'select to_jsonb(custom_work_command('+lit(ident(320+offset))+",'unit',"+lit(json.dumps(change))+'::jsonb));')
  assert until("select exists(select 1 from pg_stat_activity where application_name='cohort_holder' and state='idle in transaction')")
  b=start("set application_name='cohort_waiter';"+auth(worker)+'select work_unit_metadata_command('+lit(ident(330+offset))+',1,'+lit(json.dumps({'action':action,'data':waiting}))+'::jsonb);');assert until(blocked)
  finish(a,'commit;');answer=json.loads(finish(b).splitlines()[-1]);expected='applied' if action=='assign' else 'rejected';check(answer['receipt']['status']==expected,'Actual dimension writer wait preserves '+action+' CAS separation')
  if action=='allocate':assert answer['receipt']['reason']=='stale_basis'
  report['waits'].append({'case':'physical_revision_vs_'+action,'observed':True,'outcome':expected})
 finally:stop(a);stop(b)
# Unit counts are exact fresh projects, so each tier gets1/10/100 without
# destructive deletion. Selected target job grows monotonically; at each
# unrelated scale read exact separate projects with1/10/100 current units.
jobs={1:job};units_by_job={1:[unit]}
for size in (10,100):
 target=ident(500+size);jobs[size]=target;units_by_job[size]=[];run('insert into projects(id,job_code,name) values('+lit(target)+','+lit('COHORT-PG-'+str(size))+",'Synthetic size cohort');")
 for n in range(size):
  uid=ident(20000+size*100+n);units_by_job[size].append(uid);payload={'id':uid,'revision':0,'project_id':target,'opening_id':None,'label':'Cohort '+str(n),'type_label':'Unknown','facts':{}}
  assert rpc('select to_jsonb(custom_work_command('+lit(ident(40000+size*100+n))+",'unit',"+lit(json.dumps(payload))+'::jsonb));')==uid
 check(int(run('select count(*) from custom_work_units where project_id='+lit(target)))==size,'Exact'+str(size)+' current units')
# Fixture-owner profiling is distinct from authenticated public-RPC proof.
# Each probe commits before the active paid edge; probes warm this fixture.
report['helperProfile']={'scope':'Nonsuperuser fixture-owner readonly probes; separate transactions, no single frozen report asOf or ledger-call count','warmsFixtureBeforePaidEdge':True,'timings':[],'plans':[],'status':'running'}
persist('helper_profile_before_active_paid_edge')
def profile_probe(label,sql,plan=False):
 record={'label':label,'sql':sql,'status':'running','callerWallMsIncludesPsqlStartup':True}
 report['helperProfile']['plans' if plan else 'timings'].append(record);persist()
 started=time.monotonic()
 prefix="begin;set local request.jwt.claim.sub="+lit(worker)+";do $profile_lock$ begin perform pg_advisory_xact_lock(7712,0);perform pg_advisory_xact_lock(7710,0);end $profile_lock$;"
 value=json.loads(run(prefix+sql+';commit;'))
 record.update({'status':'passed','callerWallMs':(time.monotonic()-started)*1000,'result':value});persist()
 return value
report['helperProfile']['census']=obj("select jsonb_build_object('history',(select count(*) from work_activity_source_history),'live',(select count(*) from _work_unit_review_live_sources),'transitions',(select count(*) from personal_activity_transition_sources),'units',(select count(*) from custom_work_units))")
persist()
for name in ('_work_unit_metadata_coverage','_work_unit_review_coverage','_work_totals_coverage','_work_unit_contributors_coverage'):
 assert profile_probe(name,'select to_jsonb('+name+'())') is True
profile_units=[unit,units_by_job[100][0]]
member_sql='select _work_unit_metadata_members('+lit('{'+','.join(profile_units)+'}')+'::uuid[])'
profile_members=profile_probe('shared_members_two_units',member_sql)
assert isinstance(profile_members,dict) and set(profile_members)==set(profile_units)
live_body_matches=re.findall(r'^create function public\._work_unit_metadata_live\(p_sourceids jsonb\).*?as \$\$(.*?)\$\$;',source,re.M|re.S)
assert len(live_body_matches)==1
live_body=live_body_matches[0]
assert run("select prosrc from pg_proc where oid='_work_unit_metadata_live(jsonb)'::regprocedure")==live_body.strip()
assert live_body.count('p_sourceids')==1
for uid in profile_units:
 identities=profile_members[uid];assert isinstance(identities,list)
 source_literal=lit(json.dumps(identities))+'::jsonb'
 scope=profile_probe('scope '+uid,'select _work_unit_metadata_scope('+lit(worker)+','+lit(uid)+','+source_literal+')')
 assert isinstance(scope,dict)
 review=profile_probe('review '+uid,'select _work_unit_metadata_review('+lit(worker)+','+lit(json.dumps(scope))+'::jsonb)')
 assert isinstance(review,dict)
 profile_probe('state '+uid,'select _work_unit_metadata_state('+lit(worker)+','+lit(json.dumps(scope))+'::jsonb,'+lit(json.dumps(review))+'::jsonb)')
 project=job if uid==unit else jobs[100]
 profile_probe('shift_ids '+uid,"select coalesce(to_jsonb(_work_unit_metadata_shift_ids("+lit(project)+','+lit(uid)+','+lit(json.dumps(scope))+"::jsonb)),'null'::jsonb)")
 statements={
  'history':"select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') from work_activity_source_history h where exists(select 1 from jsonb_array_elements("+source_literal+")x where x->>'kind'=h.source_kind and x->>'id'=h.source_id)",
  'old_live_same_database_control':"select coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id,'value',s.value) order by s.kind,s.source_id),'[]') from _work_unit_review_live_sources s where exists(select 1 from jsonb_array_elements("+source_literal+")x where x->>'kind'=s.kind and x->>'id'=s.source_id)",
  'selected_live':"select coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id,'value',s.value) order by s.kind,s.source_id),'[]') from _work_unit_metadata_live("+source_literal+")s",
  'selected_live_expanded_body':live_body.replace('p_sourceids',source_literal),
  'transitions':"select coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(e),'actor',t.actor_id,'recordedAt',t.received_at,'selectedAt',t.selected_effective_at,'timeReason',t.time_selection_reason,'commandId',t.command_id,'requestId',t.source_request_id) order by e.id),'[]') from personal_activity_transition_sources e join personal_activity_transitions t on t.id=e.transition_id where exists(select 1 from jsonb_array_elements("+source_literal+")x where x->>'id'=e.source_id::text and x->>'kind'=case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end)"
 }
 for label,statement in statements.items():
  record=profile_probe(label+' '+uid,'explain(analyze,buffers,verbose,format json) '+statement,plan=True)
  assert isinstance(record,list) and len(record)==1 and 'Plan' in record[0]
report['helperProfile']['status']='passed'
report['coverageLimits']['nestedPlansMeasured']=True
report['coverageLimits']['nestedPlansScope']='Only the saved history/live/transition selection plans and expanded authored live helper; no actual function-call counter or every nested helper plan'
persist('helper_profile_complete')

# Exercise the actual active-reader paid edge before expensive volume tiers,
# so a later honest statement timeout does not discard this independent gate.
# Observe a real batch executing, then actual payroll. No pg_sleep or idle
# holder; two attempts only. A fast unobserved edge remains an explicit failure.
observed=False;persist('active_batch_payroll_wait')
for attempt in range(2):
 a=b=None;attempt_record={'case':'active_batch_payroll','additionalUnrelatedRows':0,'currentUnits':100,'attempt':attempt+1,'observed':False,'holderWasActive':False,'controlledIdleHold':False,'stage':'reader_starting'};report['waits'].append(attempt_record);persist()
 try:
  a=start("set application_name='cohort_active_reader';"+auth(worker)+'select work_unit_cohorts_read('+lit(jobs[100])+',1);')
  active=until("select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='cohort_active_reader' and a.state='active' and l.locktype='advisory' and l.classid=7710 and l.granted)",2)
  attempt_record.update({'holderWasActive':active,'stage':'reader_observed' if active else 'reader_not_observed'});persist()
  if not active:finish(a);attempt_record['stage']='finished_without_observed_edge';persist();continue
  begin=time.monotonic();b=start("set application_name='cohort_payroll_waiter';"+auth(worker)+'select to_jsonb(start_break('+lit(shift)+"::uuid,'rest'::text));")
  observed=until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='cohort_active_reader' and a.state='active' and b.application_name='cohort_payroll_waiter' and a.pid=any(pg_blocking_pids(b.pid)))",2)
  attempt_record.update({'observed':observed,'stage':'waiting_for_reader_and_payroll_results','requestWallMsMeaning':'caller-observed upper bound including psql startup, reader output collection and payroll output; not isolated lock duration'});persist()
  answer=json.loads(finish(a).splitlines()[-1]);paid=json.loads(finish(b).splitlines()[-1]);assert answer['availability']=='available' and paid['break_started_at'] is not None
  attempt_record.update({'readerAsOf':answer['cohort']['asOf'],'requestWallMs':(time.monotonic()-begin)*1000,'stage':'reader_and_payroll_completed'});persist()
  assert rpc('select to_jsonb(end_break('+lit(shift)+'::uuid));')['break_started_at'] is None
  if observed:break
 finally:stop(a);stop(b)
closed=rpc('select to_jsonb(clock_out('+lit(shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));');check(closed['clock_out_at'] is not None,'Actual break/return/out remain successful')
assert observed,'No actual active-reader payroll edge observed in two attempts; held gate remains unresolved'

parent=run('select id from personal_activity_transitions where source_shift_id='+lit(shift)+' order by revision_after limit 1')
run('insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values('+lit(ident(80))+','+lit(opening)+",'flashing','submitted',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',0);")
previous=changes=0
for rows,change_target in ((0,0),(1000,100),(10000,1000)):
 persist('volume_seed')
 for lo in range(previous+1,rows+1,100):
  hi=min(rows,lo+99);series=' from generate_series('+str(lo)+','+str(hi)+')g'
  statements={
   'project_openings':"insert into project_openings(id,project_id,opening_code) select md5('metadata-pg-opening-'||g)::uuid,"+lit(other)+",'COHORT-PG-U-'||g"+series,
   'opening_phases':"insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('metadata-pg-phase-'||g)::uuid,md5('metadata-pg-opening-'||g)::uuid,'flashing','submitted',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',60"+series,
   'transition_sources':"insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select "+lit(parent)+','+lit(worker)+",'phase',md5('metadata-pg-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('opening_id',md5('metadata-pg-opening-'||g)::uuid,'project_id',"+lit(other)+"::uuid)"+series}
  for table,sql in statements.items():
   report['pendingSeed']={'table':table,'first':lo,'last':hi};persist();t=time.monotonic();count=int(run('with inserted as ('+sql+' returning1) select count(*) from inserted;'.replace('returning1','returning 1')));assert count==hi-lo+1;report['seedBatches'].append({'table':table,'first':lo,'last':hi,'rows':count,'wallMs':(time.monotonic()-t)*1000});report.pop('pendingSeed');persist()
 for lo in range(changes+1,change_target+1,100):
  hi=min(change_target,lo+99);run('do $$begin for n in '+str(lo)+'..'+str(hi)+' loop update opening_phases set minutes=n where id='+lit(ident(80))+';end loop;end$$;');report['seedBatches'].append({'table':'target_phase_changes','first':lo,'last':hi});persist()
 counts=obj("select jsonb_build_object('openings',(select count(*) from project_openings where project_id="+lit(other)+" and opening_code like 'COHORT-PG-U-%'),'livePhases',(select count(*) from opening_phases p join project_openings o on o.id=p.opening_id where o.project_id="+lit(other)+" and o.opening_code like 'COHORT-PG-U-%'),'transitions',(select count(*) from personal_activity_transition_sources where transition_id="+lit(parent)+" and source_kind='phase'),'targetChanges',(select count(*) from work_activity_source_history where source_kind='opening_phases' and source_id="+lit(ident(80))+" and before_value<>'{}' and after_value<>'{}' and before_value->'minutes' is distinct from after_value->'minutes'))")
 check(counts=={'openings':rows,'livePhases':rows,'transitions':rows,'targetChanges':change_target},'Verified actual volume census '+str(rows));report['verifiedSeedCounts']=counts;persist()
 # 0844 parent capture: project_openings INSERT -> one history row. Its
 # row-event capture: opening_phases INSERT -> one row, each changed minute
 # UPDATE -> one row. 0841 phase/service follow callbacks are no-ops. The
 # transition-source table has guard/immutable triggers only, no history hook.
 history=obj("select jsonb_build_object('project_openings',(select count(*) from work_activity_source_history h join project_openings o on h.source_id=o.id::text where h.source_kind='project_openings' and o.project_id="+lit(other)+" and o.opening_code like 'COHORT-PG-U-%'),'opening_phases',(select count(*) from work_activity_source_history h join opening_phases p on h.source_id=p.id::text join project_openings o on o.id=p.opening_id where h.source_kind='opening_phases' and o.project_id="+lit(other)+" and o.opening_code like 'COHORT-PG-U-%'),'target_phase',(select count(*) from work_activity_source_history where source_kind='opening_phases' and source_id="+lit(ident(80))+"),'transition_source_history',(select count(*) from work_activity_source_history h join personal_activity_transition_sources t on h.source_id=t.id::text where h.source_kind='personal_activity_transition_sources' and t.transition_id="+lit(parent)+" and t.source_kind='phase'))")
 expected_history={'project_openings':rows,'opening_phases':rows,'target_phase':change_target+1,'transition_source_history':0};check(history==expected_history,'Verified source-traced history counts '+str(rows));report['verifiedHistoryCounts']={'actual':history,'expected':expected_history,'mutationProjectId':job};persist()

 run('analyze work_activity_source_history;analyze personal_activity_transition_sources;analyze custom_work_units;')
 for size in (1,10,100):
  samples=[];observations=[];target=jobs[size]
  selected_counts=obj("select jsonb_build_object('currentUnits',(select count(*) from custom_work_units where project_id="+lit(target)+"),'physicalProjectDistinctShifts',(select count(distinct id) from time_shifts where project_id="+lit(target)+"),'currentDimensionFacts',(select count(*) from work_unit_fact_current f join custom_work_units u on u.id=f.unit_id where u.project_id="+lit(target)+"),'targetChanges',(select count(*) from work_activity_source_history h join opening_phases p on h.source_id=p.id::text join project_openings o on o.id=p.opening_id where h.source_kind='opening_phases' and h.source_id="+lit(ident(80))+" and o.project_id="+lit(target)+" and h.before_value<>'{}' and h.after_value<>'{}' and h.before_value->'minutes' is distinct from h.after_value->'minutes'))")
  assert selected_counts['currentUnits']==size and selected_counts['targetChanges']==(change_target if target==job else 0)
  if size in (10,100):assert selected_counts['physicalProjectDistinctShifts']==0 and selected_counts['currentDimensionFacts']==0
  tier_context={'projectId':target,'mutationProjectId':job,'mutationProjectTotalChanges':change_target,'selectedProjectCounts':selected_counts,'targetChanges':selected_counts['targetChanges'],'ledgerLoadClaim':False,'dependencyShiftUnionMeasured':False,'loadDescription':'scope/membership-only no-shift no-fact units' if size in (10,100) else 'one physical project shift; no dense shared/distinct-shift or runtime invocation-count proof'}
  report['currentMeasurement']={'additionalRows':rows,'units':size,**tier_context,'samplesMs':samples,'serverObservations':observations};persist('volume_measurement')
  for _ in range(20):
   measured=rpc("create temp table cohort_measure(ms double precision,v jsonb);do $$declare t timestamptz;r jsonb;begin t:=clock_timestamp();r:=work_unit_cohorts_read("+lit(target)+",1);insert into cohort_measure values(extract(epoch from clock_timestamp()-t)*1000,r);end$$;select jsonb_build_object('ms',ms,'value',v) from cohort_measure;")
   assert measured['value']['availability']=='available';assert len(measured['value']['cohort']['units'])==size;samples.append(measured['ms']);observations.append({'asOf':measured['value']['cohort']['asOf'],'unitCount':len(measured['value']['cohort']['units']),'replyBytes':len(json.dumps(measured['value']).encode())});persist()
  samples.sort();plan=json.loads(run(auth(worker)+'explain(analyze,buffers,format json) select work_unit_cohorts_read('+lit(target)+',1);','authenticator'))
  tier={'additionalUnrelatedRows':rows,'currentUnits':size,**tier_context,'samplesMs':samples,'serverObservations':observations,'medianMs':statistics.median(samples),'p95Ms':samples[18],'maxMs':samples[-1],'rpcExplain':plan,'rpcExplainScope':'top-level function call only; nested helper plans not collected'};report['tiers'].append(tier);report.pop('currentMeasurement');persist();print('VOLUME',json.dumps(tier),flush=True)
 previous=rows;changes=change_target
report['status']='passed';persist('complete');print(json.dumps({'result':'PASS','checks':checks,'sourceSha256':sha,'tiers':len(report['tiers']),'actualActivePayrollWait':observed}),flush=True)
