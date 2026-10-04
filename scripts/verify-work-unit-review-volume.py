#!/usr/bin/env python3
"""Bounded genuine PG17 volume gate AFTER the review concurrency fixture.
Never targets a provider: exact localhost database/login allowlist, synthetic IDs.
Uses actual authenticator login, server timings, and observed payroll blocking.
"""
import hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
from urllib.parse import urlparse,urlunparse
ROOT=Path(__file__).resolve().parent.parent
source=(ROOT/'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
sha=hashlib.sha256(source.encode()).hexdigest()
assert sys.argv[1:] in ([],['--check-plan'])
if sys.argv[1:]==['--check-plan']:
 print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'sourceSha256':sha,'predecessor':'verify-work-unit-review-concurrency.py','tiers':[[0,0],[1000,100],[10000,1000]],'samplesPerOperation':20,'operations':['read','submit command','receipt'],'plannedActualPayrollWaits':3,'statementTimeoutSeconds':12,'lockTimeoutSeconds':8}));sys.exit(0)
p=urlparse(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
try:port=p.port
except ValueError:raise SystemExit('Invalid local fixture URL')
if p.scheme not in ('postgres','postgresql') or p.hostname not in ('localhost','127.0.0.1') or port not in (None,5432) or p.path!='/forge_work_activity_role_test' or p.username!='supabase_admin' or p.query or p.fragment:
 raise SystemExit('Refused: exact disposable localhost role fixture required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):return urlunparse((p.scheme,f'{user}:fixture-only@{p.hostname}:{port or 5432}',p.path,'','',''))
def ql(x):return "'"+str(x).replace("'","''")+"'"
def ident(n):return '00000000-0000-4000-8000-'+str(180000+n).zfill(12)
def auth(uid):return 'set role authenticated;set request.jwt.claim.sub='+ql(uid)+';'
def run(sql,user='postgres'):
 r=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input="set statement_timeout='12s';set lock_timeout='8s';\n"+sql,text=True,capture_output=True,timeout=45,env=env)
 assert r.returncode==0,r.stderr[-2000:];return r.stdout.strip()
def obj(sql,user='postgres'):return json.loads(run(sql,user).splitlines()[-1])
def stats(xs):
 xs=sorted(xs);return {'samples':len(xs),'medianMs':xs[len(xs)//2],'p95Ms':xs[int(len(xs)*.95+.999999)-1],'maxMs':xs[-1]}
assert run("select current_database()='forge_work_activity_role_test' and current_setting('server_version_num')::int/10000=17 and session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t'
assert run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)",'authenticator')=='t'
for name in ['_work_activity_retain_source','_work_unit_review_scope','_work_unit_review_coverage']:
 body=re.search(r'create(?: or replace)? function public\.'+name+r'\([^;]+?as (\$[a-z_]*\$)(.*?)\1;',source,re.S).group(2)
 assert run("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where pronamespace='public'::regnamespace and proname="+ql(name))==hashlib.sha256(body.encode()).hexdigest(),name+' exact installed body'
assert run('select _work_unit_review_coverage()')=='t'
owner,reviewer,worker=ident(1),ident(2),ident(3);job,former=ident(10),ident(11);opening,other_opening,former_opening,unrelated_opening=[ident(n) for n in (20,21,22,23)];unit,other_unit,phase=ident(30),ident(31),ident(40)
run('insert into auth.users(id) values'+','.join('('+ql(x)+')' for x in (owner,reviewer,worker))+';insert into profiles(id,display_name,role,is_test) values'+','.join('('+ql(x)+",'Volume synthetic',"+ql(role)+',false)' for x,role in [(owner,'owner'),(reviewer,'owner'),(worker,'installer')])+';')
run('insert into projects(id,job_code,name) values('+ql(job)+",'REVIEW-VOLUME','Synthetic volume'),("+ql(former)+",'REVIEW-VOLUME-OLD','Synthetic volume former');insert into project_openings(id,project_id,opening_code) values"+','.join('('+ql(i)+','+ql(j)+','+ql(str(n))+')' for n,(i,j) in enumerate([(opening,job),(other_opening,job),(former_opening,former),(unrelated_opening,former)]))+';')
for n,uid,oid in [(100,unit,opening),(101,other_unit,other_opening)]:
 data={'id':uid,'revision':0,'project_id':job,'opening_id':oid,'label':'Volume synthetic','type_label':'Window','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
 run(auth(owner)+'select custom_work_command('+ql(ident(n))+",'unit',"+ql(json.dumps(data))+'::jsonb);','authenticator')
def read(uid=unit):return obj(auth(reviewer)+'select work_unit_review_read('+ql(uid)+');','authenticator')
def command(cid,action,uid=unit):
 payload={'action':action,'basis':read(uid)['review']['basis'],'data':{'note':None}}
 return obj(auth(reviewer)+'select work_unit_review_command('+ql(cid)+',1,'+ql(json.dumps(payload))+'::jsonb);','authenticator')
command(ident(102),'submit',other_unit);command(ident(103),'pass',other_unit)
run('insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values('+ql(phase)+','+ql(former_opening)+",'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',0);update opening_phases set opening_id="+ql(opening)+' where id='+ql(phase)+';')
isolated=read(other_unit)['review'];assert isolated['qc']['qcAccepted']
report={'sourceSha256':sha,'scope':'Actual PG17 postgres/authenticator logins in exact disposable localhost fixture; no provider writes','timeouts':{'statementSeconds':12,'lockSeconds':8,'productionSettingsVerified':False},'tiers':[]}
# One RPC in its own transaction; time only server execution, not psql startup.
def measured(expression):
 sql=auth(reviewer)+"create temp table volume_result(ms double precision,value jsonb);do $$declare start_at timestamptz;answer jsonb;begin start_at:=clock_timestamp();answer:="+expression+";insert into volume_result values(extract(epoch from clock_timestamp()-start_at)*1000,answer);end$$;select jsonb_build_object('ms',ms,'value',value) from volume_result;"
 return obj(sql,'authenticator')
def start(sql,user):
 proc=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 proc.stdin.write("set statement_timeout='12s';set lock_timeout='8s';\n"+sql+'\n');proc.stdin.flush();return proc

def finish(proc,sql=''):
 if sql:proc.stdin.write(sql+'\n');proc.stdin.flush()
 proc.stdin.close();proc.stdin=None;out,err=proc.communicate(timeout=15);assert proc.returncode==0,err[-1500:];return out

def payroll_wait(tier):
 cid=ident(800+tier);shift=obj(auth(worker)+'select to_jsonb(clock_in('+ql(job)+"::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,"+ql(cid)+"::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1));",'authenticator')['id']
 a=b=None;started=time.monotonic()
 try:
  a=start("set application_name='volume_review_holder';"+auth(reviewer)+'begin;select work_unit_review_read('+ql(unit)+');','authenticator')
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   if a.poll() is not None:raise AssertionError(a.stderr.read())
   if run("select exists(select 1 from pg_stat_activity where application_name='volume_review_holder' and state='idle in transaction')")=='t':break
   time.sleep(.03)
  else:raise AssertionError('Volume holder barrier missing')
  locks=obj("select coalesce(jsonb_agg(distinct l.classid::bigint),'[]') from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='volume_review_holder' and l.locktype='advisory' and l.granted")
  assert 7712 in locks and 7710 in locks,locks
  b=start("set application_name='volume_payroll_waiter';"+auth(worker)+'select to_jsonb(start_break('+ql(shift)+"::uuid,'rest'::text));",'authenticator')
  deadline=time.monotonic()+5;blocked_at=None
  while time.monotonic()<deadline:
   if b.poll() is not None:raise AssertionError('No actual wait: '+b.stderr.read())
   if run("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='volume_review_holder' and b.application_name='volume_payroll_waiter' and a.pid<>b.pid and a.pid=any(pg_blocking_pids(b.pid)))")=='t':blocked_at=time.monotonic();break
   time.sleep(.03)
  assert blocked_at is not None,'Actual payroll blocking edge absent'
  finish(a,'commit;');result=json.loads(finish(b).splitlines()[-1]);assert result['break_started_at'] is not None
  resume=obj(auth(worker)+'select to_jsonb(end_break('+ql(shift)+'::uuid));','authenticator');assert resume['break_started_at'] is None
  closed=obj(auth(worker)+'select to_jsonb(clock_out('+ql(shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));','authenticator');assert closed['clock_out_at'] is not None
  return {'actualObservedBlockingEdge':True,'heldAdvisoryClasses':locks,'controlledHolderTransactionMs':(time.monotonic()-started)*1000,'breakResumeOutSucceeded':True,'note':'Controlled hold includes barrier/poll/release overhead; RPC latency is measured separately'}
 finally:
  for proc in (a,b):
   if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=3)
previous_rows=previous_mutations=0
for tier,(rows,mutations) in enumerate([(0,0),(1000,100),(10000,1000)]):
 stamp=time.monotonic()
 run("with sources as(select g,md5('pg-volume-source-'||g)::uuid sid,md5('pg-volume-birth-'||g)::uuid birth,md5('pg-volume-delete-'||g)::uuid death,jsonb_build_object('id',md5('pg-volume-source-'||g)::uuid,'opening_id',"+ql(unrelated_opening)+"::uuid,'kind','flashing','status','submitted','started_by',null,'started_at','2026-01-01T10:00:00Z','submitted_at','2026-01-01T11:00:00Z','minutes',60) material from generate_series("+str(previous_rows//2+1)+','+str(rows//2)+") g) insert into work_activity_source_history(id,source_kind,source_id,predecessor_id,transaction_id,tx_order,before_value,after_value) select birth,'opening_phases',sid::text,null,pg_current_xact_id(),g*2,'{}',material from sources union all select death,'opening_phases',sid::text,birth,pg_current_xact_id(),g*2+1,material,'{}' from sources;")
 # Separate real source statements, grouped only for fixture seeding; no review writes.
 run('do $$begin for n in '+str(previous_mutations+1)+'..'+str(mutations)+' loop update opening_phases set minutes=n where id='+ql(phase)+';end loop;end$$;')
 previous_rows,previous_mutations=rows,mutations;seed_ms=(time.monotonic()-stamp)*1000
 assert read()['review']['qc']['lifecycle']=='proven'
 actual=read(other_unit)['review'];assert actual['basis']['scopeToken']==isolated['basis']['scopeToken'] and actual['qc']['qcAccepted']
 timings={'read':[],'command':[],'receipt':[]}
 for n in range(20):
  result=measured('work_unit_review_read('+ql(unit)+')');assert result['value']['availability']=='available';timings['read'].append(result['ms'])
  cid=ident(1000+tier*100+n);payload={'action':'submit','basis':read()['review']['basis'],'data':{'note':None}}
  result=measured('work_unit_review_command('+ql(cid)+',1,'+ql(json.dumps(payload))+'::jsonb)');assert result['value']['outcome']=='applied';timings['command'].append(result['ms'])
  result=measured('work_unit_review_command_receipt('+ql(cid)+')');assert result['value']['availability']=='available';timings['receipt'].append(result['ms'])
 command(ident(1500+tier),'pass');assert read()['review']['qc']['qcAccepted']
 run('update projects set deleted_at=clock_timestamp() where id='+ql(former)+';');assert read()['availability']=='unavailable';run('update projects set deleted_at=null where id='+ql(former)+';')
 explain=json.loads(run('explain (analyze,buffers,format json) select _work_unit_review_scope('+ql(reviewer)+','+ql(unit)+');'))
 closure_sql=re.search(r'with versions as materialized \([\s\S]*?into sourceids from selected;',source).group(0).replace('into sourceids ','').replace('u.id',ql(unit)+'::uuid').replace('u.opening_id',ql(opening)+'::uuid')
 closure_explain=json.loads(run('explain (analyze,buffers,format json) '+closure_sql))
 entry={'unrelatedRows':rows,'targetMutations':mutations,'seedMs':seed_ms,**{k:stats(v) for k,v in timings.items()},'explain':explain,'closureExplain':closure_explain,'unrelatedIsolation':True,'hiddenFormerBindingRefused':True,'payrollWait':payroll_wait(tier)}
 report['tiers'].append(entry);print(json.dumps({'volumeTier':{**entry,'closureExplain':'Retained in JSON artifact'}}),flush=True)
 if os.environ.get('WORK_UNIT_REVIEW_VOLUME_OUT'):Path(os.environ['WORK_UNIT_REVIEW_VOLUME_OUT']).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'result':'PASS','sourceSha256':sha,'tiers':3,'timings':180,'actualPayrollWaits':3,'scope':report['scope']}))
