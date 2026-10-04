#!/usr/bin/env python3
"""PG17 real-login catalog acceptance after verify-work-activity-engine-role-parity.py.

The predecessor must have assembled 0841 in its exact disposable role database.
This runner never connects to the operational database or bootstraps roles.
"""
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT/'supabase/migrations/20261108420000_work_activity_catalog.sql'
CUTOVER = ROOT/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql'
assert hashlib.sha256(CATALOG.read_bytes()).hexdigest() == 'a97e733bd06c4ea8632ed330b02ffb14d90cad748395dcbc7a3cfafbf178d002'
assert hashlib.sha256(CUTOVER.read_bytes()).hexdigest() == 'e2c57266fa2f63e345b8ce232d737c7810c7e9509334b9abae56d7c8b77b5d15'
assert sys.argv[1:] in ([], ['--check-plan'])
if sys.argv[1:] == ['--check-plan']:
    print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'predecessor':'verify-work-activity-engine-role-parity.py on fresh PG17 role fixture'}))
    sys.exit(0)

url = os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL','')
try:
    parsed = urlparse(url);port = parsed.port
except ValueError:
    raise SystemExit('Refused invalid local fixture URL')
if (parsed.scheme not in ('postgres','postgresql') or parsed.hostname not in ('localhost','127.0.0.1')
    or port not in (None,5432) or parsed.path != '/forge_work_activity_role_test'
    or parsed.username != 'supabase_admin' or parsed.query or parsed.fragment):
    raise SystemExit('Refused: exact localhost role-fixture URL and supabase_admin bootstrap login required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):
    return url if user=='supabase_admin' else urlunparse((parsed.scheme,f'{user}:fixture-only@{parsed.hostname}:{port or 5432}',parsed.path,'','',''))
def ql(s):return "'"+str(s).replace("'","''")+"'"
def call(sql,user='postgres',error=None,timeout=30):
    result=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
      input="\\set VERBOSITY sqlstate\nset statement_timeout='12s';set lock_timeout='8s';\n"+sql,
      text=True,capture_output=True,timeout=timeout,env=env)
    if error:
        assert result.returncode and re.search(r'\b'+error+r'\b',result.stderr),(error,result.stderr[-500:])
        return None
    assert result.returncode==0,result.stderr[-900:]
    return result.stdout.strip()
def obj(sql,user='postgres'):
    lines=call(sql,user).splitlines();assert len(lines)==1,lines
    return json.loads(lines[0])
def auth(uid):return 'set role authenticated;set request.jwt.claim.sub='+ql(uid)+';'
def read(uid,job,unit=None,readonly=True):
    sql=auth(uid)+('begin isolation level read committed read only;' if readonly else '')
    sql+='select work_activity_catalog('+ql(job)+','+(ql(unit) if unit else 'null')+');'
    if readonly:sql+='commit;'
    return obj(sql,'authenticator')
def unavailable(v):
    assert sorted(v)==sorted(('protocolVersion','asOf','availability','projectId','unit','selection','totals'))
    assert v['availability']=='unavailable' and v['projectId'] is None and v['unit'] is None and v['selection'] is None
    assert v['totals']=={'availability':'unavailable','reasonCode':'not_ready'}

assert call('select current_database()')=='forge_work_activity_role_test'
assert call("select (to_regprocedure('public.work_activity_command(uuid,integer,jsonb)') is not null and to_regclass('public.work_activity_authority_generation') is not null)::int")=='1', 'Complete predecessor assembly is required'
assert call("select (session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user))::int",'postgres')=='1'
assert call("select (session_user='authenticator' and not (select rolsuper from pg_roles where rolname=session_user))::int",'authenticator')=='1'
assert call("select to_regprocedure('public.work_activity_catalog(uuid,uuid)') is null")=='t','Fresh catalog-free predecessor required'
call(CATALOG.read_text(),'postgres')
checks=5
base='00000000-0000-4000-8000-000000005'
def ident(n):return base+f'{n:03d}'
owner,crew,supervisor,qa,partner,revoked=[ident(n) for n in range(1,7)]
job,sandbox,deleted=[ident(n) for n in (10,11,12)]
values=','.join('('+ql(x)+')' for x in (owner,crew,supervisor,qa,partner,revoked))
call('insert into auth.users(id) values '+values+';','postgres')
profiles=[(owner,'owner','false','false'),(crew,'installer','false','false'),(supervisor,'supervisor','false','false'),(qa,'installer','true','false'),(partner,'supervisor','false','true'),(revoked,'owner','false','false')]
call('insert into profiles(id,display_name,role,is_test,is_partner) values '+','.join('('+ql(p)+','+ql('Catalog fixture')+','+ql(role)+','+test+','+partner_flag+')' for p,role,test,partner_flag in profiles)+';','postgres')
call('update profiles set access_revoked_at=clock_timestamp() where id='+ql(revoked)+';','postgres')
call("insert into projects(id,job_code,name,is_test) values ("+ql(job)+",'CAT-REAL','Catalog real fixture',false),("+ql(sandbox)+",'CAT-QA','Catalog QA fixture',true),("+ql(deleted)+",'CAT-DELETED','Deleted fixture',false);",'postgres')
call('insert into sandbox_projects(project_id) values('+ql(sandbox)+');update projects set deleted_at=clock_timestamp() where id='+ql(deleted)+';','postgres')
names=call("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'work_%' or relname like 'personal_activity_%') order by relname").splitlines()
assert len(names)>=15
def counts():return [call('select count(*) from public."'+name+'"') for name in names]
before=counts()
for uid in (owner,crew,supervisor):
    v=read(uid,job);assert v['availability']=='available' and v['projectId']==job and v['selection'] is None;checks+=1
unavailable(read(crew,sandbox));unavailable(read(crew,deleted));unavailable(read(qa,job));checks+=3
assert read(qa,sandbox)['availability']=='available';checks+=1
assert counts()==before;checks+=1
for uid in (partner,revoked):call(auth(uid)+'select work_activity_catalog('+ql(job)+',null);','authenticator','42501');checks+=1
call('set role anon;select work_activity_catalog('+ql(job)+',null);','authenticator','42501');checks+=1
for isolation in ('repeatable read','serializable'):
    call(auth(crew)+'begin isolation level '+isolation+';select work_activity_catalog('+ql(job)+',null);','authenticator','25001');checks+=1

# Genuine independent backends: holder commits a changed source while the
# authenticated reader waits on G. An observed pg_blocking_pids edge is required.
processes=[]
def start(sql,user):
    p=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    processes.append(p);p.stdin.write("\\set VERBOSITY sqlstate\nset statement_timeout='12s';set lock_timeout='8s';\n"+sql+'\n');p.stdin.flush();return p
def finish(p,more=''):
    if more:p.stdin.write(more+'\n');p.stdin.flush()
    p.stdin.close();p.stdin=None
    out,err=p.communicate(timeout=15)
    return p.returncode,out.strip(),err
def cleanup():
    for p in processes:
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)
atexit.register(cleanup)
def observe(holder,reader):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        assert all(p.poll() is None for p in (holder,reader)),'Race process exited before wait'
        n=call("select count(*) from pg_stat_activity h join pg_stat_activity r on r.datname=h.datname where h.application_name='catalog_holder' and r.application_name='catalog_reader' and h.pid=any(pg_blocking_pids(r.pid))",'postgres',timeout=4)
        if n=='1':return
        time.sleep(.03)
    raise AssertionError('No observed G/config blocking PID edge')
holder=start("set application_name='catalog_holder';begin;select _work_activity_gate();update profiles set access_revoked_at=clock_timestamp() where id="+ql(crew)+';','postgres')
deadline=time.monotonic()+5
while time.monotonic()<deadline:
    assert holder.poll() is None
    if call("select count(*) from pg_stat_activity where application_name='catalog_holder' and state='idle in transaction'")=='1':break
    time.sleep(.03)
else:raise AssertionError('Holder did not reach G barrier')
reader=start("set application_name='catalog_reader';"+auth(crew)+'select work_activity_catalog('+ql(job)+',null);','authenticator')
observe(holder,reader)
code,out,err=finish(holder,'commit;');assert code==0,err[-500:]
code,out,err=finish(reader);assert code and re.search(r'\b42501\b',err) and not out,(code,out,err[-500:]);checks+=1
print(json.dumps({'result':'PASS','checks':checks,'privateTables':len(names),'observedBlockingEdges':1,'scope':'PG17 local real authenticator and postgres login, full predecessor cutover, read-only and post-G revocation; no production or provider JWT verification'}))
