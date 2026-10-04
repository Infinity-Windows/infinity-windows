#!/usr/bin/env python3
"""Source-role acceptance in a fresh local PG17 database; no production URI.
Bootstrap SUPERUSER builds source-matched schema only. App DDL executes through
an actual NOSUPERUSER postgres login; user calls use an actual authenticator
login, then the installed SET ROLE path. Provider preload effects are separately
identified exclusions, not silently represented by plain PostgreSQL.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
DATABASE = 'forge_work_activity_role_test'
BOOTSTRAP = 'supabase_admin'
ROLE_FILE = ROOT/'scripts/fixtures/work-activity-engine-role-parity.json'
EXPECTED_ROLE_SHA = '7df27ee90e2358a7b90eab3104f54b80c24537e736dde4555b101690e57513d2'
EXPECTED_SCHEMA_SHA = 'ee41a980b19f76baa8637101b62703ecdf798a32eccbb0e9f074fbfd71c62471'
EXPECTED_CUTOVER_SHA = 'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648'
assert hashlib.sha256(ROLE_FILE.read_bytes()).hexdigest() == EXPECTED_ROLE_SHA
metadata = json.loads(ROLE_FILE.read_text())
assert sys.argv[1:] in ([], ['--check-plan'])

def qi(value):
    return '"'+value.replace('"','""')+'"'

def ql(value):
    return "'"+value.replace("'","''")+"'"

ROLE_ATTRIBUTES = {
 'superuser':'SUPERUSER','inherit':'INHERIT','createRole':'CREATEROLE',
 'createDatabase':'CREATEDB','canLogin':'LOGIN','replication':'REPLICATION','bypassRls':'BYPASSRLS'
}
roles = {r['name']:r for r in metadata['roles']}
assert not roles['postgres']['superuser'] and roles['postgres']['canLogin']
assert not roles['authenticator']['superuser'] and not roles['authenticator']['inherit']
# These three withheld keys are disclosed as exclusions. No arbitrary unknown
# setting may disappear from a future metadata update.
withheld = {(s['role'],k) for s in metadata['settings'] for k in s['withheldKeys']}
assert withheld == {('supabase_admin','log_statement'),('supabase_auth_admin','log_statement'),
 ('authenticator','session_preload_libraries'),(None,'app.settings.jwt_exp')}

def attributes(role):
    return ' '.join(('' if role[key] else 'NO')+token for key,token in ROLE_ATTRIBUTES.items())+f" CONNECTION LIMIT {role['connectionLimit']}"

# Installing exact application objects is bootstrap work. Runtime source roles
# are created first, but never made SUPERUSER for convenience during app DDL.
creation=[]
for role in metadata['roles']:
    if role['name'].startswith('pg_') or role['name']==BOOTSTRAP:
        continue # Existing PG17 built-ins must compare exactly below.
    creation.append(f"CREATE ROLE {qi(role['name'])} {attributes(role)};")
# Database ACL-only roles do not belong to either runtime actor's grant closure.
for name in ('supabase_etl_admin','supabase_storage_admin','dashboard_user'):
    if name not in roles:
        creation.append(f"CREATE ROLE {qi(name)} NOLOGIN;")
creation.append(f'ALTER DATABASE {qi(DATABASE)} OWNER TO postgres;')
# No copied real credentials. Only fresh local synthetic login secrets.
for name in ('postgres','authenticator'):
    creation.append(f"ALTER ROLE {qi(name)} PASSWORD 'fixture-only';")

memberships=[]
# PostgreSQL attributes superuser membership GRANT to the cluster bootstrap
# role, even after SET ROLE. Initialize with the actual bootstrap name
# supabase_admin; postgres remains a separate non-superuser source owner.
# Replace only this metadata closure and restore actual grantor/options.
for member in roles:
    memberships.append("DO $$DECLARE m record;BEGIN FOR m IN SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles u ON u.oid=a.member WHERE u.rolname="+ql(member)+" LOOP EXECUTE format('REVOKE %I FROM %I CASCADE',m.rolname,"+ql(member)+");END LOOP;END$$;")
memberships.append('SET ROLE supabase_admin;')
for m in metadata['memberships']:
    assert m['grantor']=='supabase_admin'
    memberships.append(f"GRANT {qi(m['role'])} TO {qi(m['member'])} WITH ADMIN {str(m['adminOption']).lower()}, INHERIT {str(m['inheritOption']).lower()}, SET {str(m['setOption']).lower()};")
memberships.append('RESET ROLE;')
settings=[]
for s in metadata['settings']:
    for entry in s['safeValues']:
        key,value=entry.split('=',1)
        assert re.fullmatch('[a-z_]+',key)
        prefix='ALTER ROLE '+qi(s['role']) if s['role'] else 'ALTER DATABASE '+qi(DATABASE)
        if s['role'] and s['scope']=='current_database': prefix+=' IN DATABASE '+qi(DATABASE)
        # List-valued GUCs cannot be replayed as one ALTER SET literal: that
        # quotes the whole search_path as a single schema name. Preserve the
        # actual GUC value through its native setter, then capture FROM CURRENT.
        if key=='search_path':
            settings.append('SELECT pg_catalog.set_config('+ql(key)+','+ql(value)+',false);'+prefix+' SET '+qi(key)+' FROM CURRENT;RESET '+qi(key)+';')
        else:
            assert key in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout'),key
            settings.append(prefix+' SET '+qi(key)+' TO '+ql(value)+';')
# Match effective DB privileges. Preserve provider ACL-only names, without
# inventing additional memberships into the actors being tested.
database_acl=[f'REVOKE ALL ON DATABASE {qi(DATABASE)} FROM PUBLIC;']
for acl in metadata['database']['acl']:
    match=re.fullmatch(r'([^=]*)=([^/]*)/postgres',acl)
    assert match,acl
    grantee,privileges=match.groups()
    assert '*' not in privileges
    names={'C':'CREATE','T':'TEMPORARY','c':'CONNECT'}
    database_acl.append(f"GRANT {','.join(names[p] for p in privileges)} ON DATABASE {qi(DATABASE)} TO {qi(grantee) if grantee else 'PUBLIC'};")

schema=(ROOT/'scripts/fixtures/work-activity-engine-online-schema.sql').read_text()
source=(ROOT/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql').read_text()
assert hashlib.sha256(schema.encode()).hexdigest()==EXPECTED_SCHEMA_SHA
assert hashlib.sha256(source.encode()).hexdigest()==EXPECTED_CUTOVER_SHA
# Only duplicate role-creation declarations are removed from the immutable
# schema fixture. Every declaration is parsed and accounted for explicitly.
removed=[]
def remove_existing_role(match):
    name=match.group(1)
    assert name in roles or name in ('dashboard_user','supabase_storage_admin'),name
    removed.append(name)
    return ''
schema=re.sub(r'^create role "([a-z_]+)" nologin;$',remove_existing_role,schema,flags=re.M)
assert len(removed)==8
source_guard=source[source.index('-- INSTALLED_SOURCE_GUARD:'):source.index('-- INSTALLED_GRAPH_GUARD:')]
cutover=source[source.index('-- DEVELOPMENT_PRIVATE_PREFIX:'):]
assert re.search(r'rollback;\s*$',cutover)
cutover=re.sub(r'rollback;\s*$','commit;',cutover)
plan={'roles':len(roles),'membershipEdges':len(metadata['memberships']),'rolePaths':len(metadata['rolePaths']),
      'sourceOwner':'postgres NOSUPERUSER actual login','caller':'authenticator NOINHERIT actual login',
      'withheldSettings':sorted([list(x) for x in withheld],key=str),
      'excluded':'Provider preload/logging/JWT-expiry settings, provider internals/vector; JWT validation and API transport are not simulated'}
if sys.argv[1:]==['--check-plan']:
    print(json.dumps({'result':'PLAN VALIDATED','executedDatabaseTests':False,**plan}));sys.exit(0)

URL=os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL','')
try:
    parsed=urlparse(URL); port=parsed.port
except ValueError:
    raise SystemExit('Refused invalid local fixture URL')
if parsed.scheme not in ('postgres','postgresql') or parsed.hostname not in ('localhost','127.0.0.1') or port not in (None,5432) or parsed.path!='/'+DATABASE or parsed.username!=BOOTSTRAP or parsed.query or parsed.fragment:
    raise SystemExit('Refused: exact fresh localhost forge_work_activity_role_test and supabase_admin bootstrap login required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
checks=0

def run(sql,user=BOOTSTRAP,error=None,timeout=120):
    global checks
    uri=URL if user==BOOTSTRAP else urlunparse((parsed.scheme,f'{user}:fixture-only@{parsed.hostname}:{port or 5432}',parsed.path,'','',''))
    prelude="\\set VERBOSITY sqlstate\n"
    if user!='authenticator':
        prelude+="set statement_timeout='90s';set lock_timeout='8s';\n"
    result=subprocess.run(['psql',uri,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
      input=prelude+sql,
      capture_output=True,text=True,timeout=timeout,env=env)
    if error:
        assert result.returncode!=0 and re.search(r'\b'+error+r'\b',result.stderr),(error,result.stderr[-1200:])
        checks+=1;return result.stdout.strip()
    assert result.returncode==0,result.stderr[-1600:]
    return result.stdout.strip()

def check(condition,label):
    global checks
    assert condition,label
    checks+=1

check(run('select current_database()')==DATABASE,'Exact fixture database')
check(run("select (session_user='supabase_admin' and current_user=session_user and (select rolsuper from pg_roles where rolname=session_user))::int")=='1','Separate bootstrap login')
check(run("select current_setting('server_version_num')::int/10000")=='17','Installed major version')
check(run("select (exists(select 1 from pg_namespace where nspname not in ('public','information_schema') and left(nspname,3)<>'pg_') or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') or exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'))::int")=='0','Fresh schema only')
run('\n'.join(creation))
run(schema)
run('\n'.join(memberships+settings+database_acl))
# The schema fixture owns auth.uid/jwt/role claim readers as bootstrap; they
# contain no definer authority or application policy. No application helper is
# replaced and all 221 originals must satisfy the original exact source guard.
check(run("select (session_user='postgres' and current_user='postgres' and not (select rolsuper from pg_roles where rolname=current_user))::int",'postgres')=='1','Actual source owner is not bootstrap or superuser')
for role in metadata['roles']:
    row=json.loads(run("select json_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'createRole',rolcreaterole,'createDatabase',rolcreatedb,'canLogin',rolcanlogin,'replication',rolreplication,'bypassRls',rolbypassrls,'connectionLimit',rolconnlimit) from pg_roles where rolname="+ql(role['name'])))
    check(row==role,'Exact attributes '+role['name'])
actual=json.loads(run("select coalesce(json_agg(json_build_object('role',r.rolname,'member',u.rolname,'grantor',g.rolname,'adminOption',a.admin_option,'inheritOption',a.inherit_option,'setOption',a.set_option) order by r.rolname,u.rolname,g.rolname),'[]') from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles u on u.oid=a.member join pg_roles g on g.oid=a.grantor where u.rolname=any(array["+','.join(ql(r) for r in roles)+"])"))
if actual!=metadata['memberships']:
    print(json.dumps({'membershipMismatch':{'missing':[m for m in metadata['memberships'] if m not in actual],
          'extra':[m for m in actual if m not in metadata['memberships']]}}))
check(actual==metadata['memberships'],'Exact direct grant paths/options/grantors')
for path in metadata['rolePaths']:
    actual=json.loads(run("select json_build_object('member',pg_has_role("+ql(path['actor'])+','+ql(path['target'])+",'MEMBER'),'usage',pg_has_role("+ql(path['actor'])+','+ql(path['target'])+",'USAGE'),'set',pg_has_role("+ql(path['actor'])+','+ql(path['target'])+",'SET'))"))
    check(actual=={k:path[k] for k in ('member','usage','set')},'Exact transitive role path')
for cap in metadata['capabilities']:
    r=ql(cap['role'])
    actual=json.loads(run("select json_build_object('role',"+r+",'databaseConnect',has_database_privilege("+r+",current_database(),'CONNECT'),'databaseCreate',has_database_privilege("+r+",current_database(),'CREATE'),'databaseTemp',has_database_privilege("+r+",current_database(),'TEMPORARY'),'publicUsage',has_schema_privilege("+r+",'public','USAGE'),'publicCreate',has_schema_privilege("+r+",'public','CREATE'),'authUsage',has_schema_privilege("+r+",'auth','USAGE'),'authCreate',has_schema_privilege("+r+",'auth','CREATE'))"))
    check(actual==cap,'Exact DB/schema capability '+cap['role'])
for configured in metadata['settings']:
    role_predicate='setrole=0' if configured['role'] is None else 'setrole=(select oid from pg_roles where rolname='+ql(configured['role'])+')'
    db_predicate='setdatabase=0' if configured['scope']=='all_databases' else 'setdatabase=(select oid from pg_database where datname=current_database())'
    stored=json.loads(run("select coalesce((select to_json(setconfig) from pg_db_role_setting where "+role_predicate+' and '+db_predicate+"),'[]'::json)"))
    for entry in configured['safeValues']:
        check(entry in stored,'Exact safe stored setting '+str(configured['role'])+':'+entry.split('=',1)[0])
check(run("select (to_regtype('project_openings') is not null)::int",'postgres')=='1','Actual source-owner login resolves the installed public row type')
run(source_guard+'\nbegin;\n'+cutover,'postgres')
checks+=1
check(run("select (not capture_enabled)::int from work_activity_authority_generation where singleton",'postgres')=='1','App DDL keeps capture disabled')
check(json.loads(run("select json_build_object('statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'))",'authenticator'))=={'statementTimeout':'8s','lockTimeout':'8s'},'Actual authenticator login preserves installed timeout defaults')
check(run("set role authenticated;select json_build_array(session_user,current_user,current_setting('role'))",'authenticator')=='["authenticator", "authenticated", "authenticated"]','Real authenticator connection preserves caller identity')
run("set role authenticated;select _work_activity_operation_enter('fixture')",'authenticator','42501')
run("set role authenticated;set request.jwt.claim.role='service_role';update time_shifts set note=note where false",'authenticator','42501')
run("set role anon;update time_shifts set note=note where false",'authenticator','42501')
run("set role authenticated;create function public.fixture_untrusted() returns integer language sql as $$select 1$$",'authenticator','42501')
run("set role service_role;update time_shifts set note=note where false",'authenticator')
checks+=1
check(run("select count(*) from work_activity_operations",'postgres')=='0','Supported service-role maintenance completes without retaining a context')
# Create synthetic subjects using the actual non-super source owner. These IDs
# exist only in the fresh exact-name local database and have no employee data.
uid='00000000-0000-4000-8000-000000004001';project='00000000-0000-4000-8000-000000004002'
run(f"insert into auth.users(id) values('{uid}');insert into profiles(id,display_name,role,is_test) values('{uid}','Role parity fixture','installer',false);insert into projects(id,job_code,name) values('{project}','ROLE-SYNTHETIC','Role fixture');",'postgres')
# Fixture-only control functions make the otherwise subtle SET ROLE premise
# visible under the same authenticator login. Never installed in a migration.
run("create schema role_fixture;grant usage on schema role_fixture to authenticated;create function role_fixture.definer_role_change() returns text language plpgsql security definer set search_path=public,pg_temp as $$begin perform set_config('role','service_role',false);return current_setting('role');end$$;create function role_fixture.invoker_role_change() returns text language plpgsql as $$begin perform set_config('role','service_role',false);return current_setting('role');end$$;grant execute on all functions in schema role_fixture to authenticated;",'postgres')
run('set role authenticated;select role_fixture.definer_role_change()','authenticator','42501')
check(run('set role authenticated;select role_fixture.invoker_role_change()','authenticator')=='service_role','Invoker escalation control demonstrates why source closure matters')
# Private factory cannot be executed by authenticated, even with a valid actor.
auth=f"set role authenticated;set request.jwt.claim.sub='{uid}';"
run(auth+"select _work_activity_operation_enter('fixture')",'authenticator','42501')
run("begin;select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1;commit",'postgres')
clock=f"select to_jsonb(clock_in('{project}'::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'00000000-0000-4000-8000-000000004003'::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1))"
run(auth+clock.replace(',0,1))',',0))'),'authenticator','P0001')
run(auth+"set app.work_setup='true';set request.jwt.claim.setup_version='1';"+clock.replace(',0,1))',',0))'),'authenticator','P0001')
run(auth+"select _work_activity_claim_clock_setup(null,null,null,null,null,null,null,null,null,null,null)",'authenticator','42501')
run(auth+"select _work_activity_clock_setup_digest(null,null,null,null,null,null,null,null,null,null,null)",'authenticator','42501')
paid=json.loads(run(auth+clock,'authenticator'))
check(paid['profile_id']==uid and paid['clock_out_at'] is None,'Unsigned twelve-argument clock succeeds with paid-date absent through genuine authenticator and non-super definer')
snapshot=json.loads(run(auth+"select work_activity_snapshot('00000000-0000-4000-8000-000000004004')",'authenticator'))
check(snapshot['state']['status']=='setup','Actual setup state under source role attributes')
shift=paid['id']
run(auth+f"select start_break('{shift}'::uuid,'rest'::text)",'authenticator')
ended=json.loads(run(auth+f"select to_jsonb(end_break('{shift}'::uuid))",'authenticator'))
check(ended['profile_id']==uid and ended['break_started_at'] is None and ended['clock_out_at'] is None,'Actual legacy payroll break returns its own resumed shift under source roles')
closed=json.loads(run(auth+f"select to_jsonb(clock_out('{shift}'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text))",'authenticator'))
check(closed['clock_out_at'] is not None,'Actual payroll out completes under source roles')
check(run("select count(*) from work_activity_operations",'postgres')=='0','No operation contexts persist after real-role calls')
# Readiness is a separate no-write migration, installed through the real source
# owner only after the complete engine. It cannot stand in for activation.
capability_source=(ROOT/'supabase/migrations/20261108430000_work_activity_clock_capability.sql').read_text()
capability_hash=hashlib.sha256(capability_source.encode()).hexdigest()
assert capability_hash=='1e77a1c2ab09df91f16fe160ca640de4e9c825be6cec4fe7b46a1f941c255e61'
run(capability_source,'postgres');checks+=1
counts="select json_build_array((select count(*) from personal_activity_state),(select count(*) from work_activity_observations),(select count(*) from work_activity_clock_receipts),(select count(*) from personal_activity_transitions),(select count(*) from work_activity_operations),(select count(*) from time_shifts))"
before_counts=run(counts,'postgres')
capability=json.loads(run(auth+'begin read only;select work_activity_clock_capability();commit;','authenticator'))
check(capability['mode']=='active' and capability['canAuthorSetup'] and capability['setupReason'] is None,'Actual read-only readiness permits explicit setup before signing')
check(run(counts,'postgres')==before_counts,'Readiness leaves all capture/payroll/history counts unchanged')
run(auth+'select _work_activity_clock_contract_marker()','authenticator','42501')
run('set role anon;select work_activity_clock_capability()','authenticator','42501')
run(auth+'begin isolation level repeatable read;select work_activity_clock_capability()','authenticator','25001')
run(auth+'begin isolation level serializable;select work_activity_clock_capability()','authenticator','25001')

# Two genuine independent-backend races. The waiting reader uses the actual
# authenticator login and its installed 8s timeout. PID/blocker observation is
# required before release; sleeping or assuming a race is not evidence.
import time
race_processes=[]
def start_race(sql,user):
    uri=urlunparse((parsed.scheme,f'{user}:fixture-only@{parsed.hostname}:{port or 5432}',parsed.path,'','',''))
    proc=subprocess.Popen(['psql',uri,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    race_processes.append(proc)
    proc.stdin.write('\\set VERBOSITY sqlstate\n'+sql+'\n');proc.stdin.flush()
    return proc

def finish_race(proc,sql=''):
    if sql:proc.stdin.write(sql+'\n');proc.stdin.flush()
    proc.stdin.close();proc.stdin=None
    return proc.communicate(timeout=10)

wait_edges=0
try:
    for index,change in enumerate([
        "update work_activity_authority_generation set capture_enabled=false,revision=revision+1 where singleton",
        f"update profiles set access_revoked_at=clock_timestamp() where id='{uid}'"
    ]):
        app_a=f'capability_holder_{index}';app_b=f'capability_reader_{index}'
        holder=start_race(f"set application_name='{app_a}';set statement_timeout='8s';set lock_timeout='8s';begin;select _work_activity_gate();{change};",'postgres')
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if holder.poll() is not None:raise AssertionError('Holder exited before barrier: '+holder.stderr.read())
            ready=run("set statement_timeout='2s';select exists(select 1 from pg_stat_activity where datname=current_database() and application_name="+ql(app_a)+" and state='idle in transaction')::int",'postgres',timeout=4)
            if ready=='1':break
            time.sleep(.03)
        else:raise AssertionError('Holder did not reach its transaction barrier')
        reader=start_race(f"set application_name='{app_b}';"+auth+'select work_activity_clock_capability();','authenticator')
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if reader.poll() is not None:raise AssertionError('Reader exited without waiting: '+reader.stderr.read())
            blocked=run("set statement_timeout='2s';select exists(select 1 from pg_stat_activity a join pg_stat_activity b on b.datname=a.datname where a.datname=current_database() and a.application_name="+ql(app_a)+" and b.application_name="+ql(app_b)+" and a.pid<>b.pid and a.pid=any(pg_blocking_pids(b.pid)))::int",'postgres',timeout=4)
            if blocked=='1':wait_edges+=1;break
            time.sleep(.03)
        else:raise AssertionError('No actual independent G blocking edge observed')
        released_at=float(run('select extract(epoch from clock_timestamp())','postgres'))
        holder_out,holder_error=finish_race(holder,'commit;')
        assert holder.returncode==0,holder_error
        reader_out,reader_error=finish_race(reader)
        if index==0:
            assert reader.returncode==0,reader_error
            fresh=json.loads(reader_out)
            check(fresh['mode']=='closing_only' and fresh['setupReason']=='starts_disabled' and not fresh['canAuthorSetup'],'Post-G reader sees committed capture disable')
            from datetime import datetime
            check(datetime.fromisoformat(fresh['asOf'].replace('Z','+00:00')).timestamp()>=released_at,'asOf is captured after the actual gate wait')
            check(all(fresh[k] for k in ('canDispatchExistingSetup','canReadOwnReceipts','canDispatchPayrollSafety')),'Closing preserves original clock/safety compatibility')
        else:
            check(reader.returncode!=0 and re.search(r'\b42501\b',reader_error),'Post-G account revocation refuses before any readiness projection')
            check(not reader_out.strip(),'Revoked reader returns no private readiness envelope')
    check(wait_edges==2,'Two exact independent-backend blocking edges observed')
    check(run(counts,'postgres')==before_counts,'Both waiting reads leave payroll/capture/history unchanged')
    # Three actual payroll-entry waits, including the reverse capture direction.
    # Every original stamp is frozen before either connection enters G; no client
    # chooses a replacement timestamp after the wait.
    for index,case in enumerate(['disable','enable','revoke']):
        subject=f'00000000-0000-4000-8000-{5000+index:012d}'
        command=f'00000000-0000-4000-8000-{5100+index:012d}'
        run(f"insert into auth.users(id) values('{subject}');insert into profiles(id,display_name,role,is_test) values('{subject}','Synthetic waiting setup','installer',false);begin;select _work_activity_gate();update work_activity_authority_generation set capture_enabled={'false' if case=='enable' else 'true'},revision=revision+1;commit",'postgres')
        stamp=json.loads(run("select json_build_object('tap',clock_timestamp()-interval '1 minute','checked',clock_timestamp())",'postgres'))
        change=(f"update profiles set access_revoked_at=clock_timestamp() where id='{subject}'" if case=='revoke' else f"update work_activity_authority_generation set capture_enabled={'true' if case=='enable' else 'false'},revision=revision+1 where singleton")
        app_a=f'setup_holder_{index}';app_b=f'setup_writer_{index}'
        holder=start_race(f"set application_name='{app_a}';set statement_timeout='8s';set lock_timeout='8s';begin;select _work_activity_gate();{change};",'postgres')
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if holder.poll() is not None:raise AssertionError('Setup holder exited before barrier: '+holder.stderr.read())
            if run("set statement_timeout='2s';select exists(select 1 from pg_stat_activity where datname=current_database() and application_name="+ql(app_a)+" and state='idle in transaction')::int",'postgres',timeout=4)=='1':break
            time.sleep(.03)
        else:raise AssertionError('Setup holder did not reach G barrier')
        waiting_clock=f"select to_jsonb(clock_in(null::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'{command}'::uuid,{ql(stamp['tap'])}::timestamptz,{ql(stamp['checked'])}::timestamptz,0,1))"
        reader=start_race(f"set application_name='{app_b}';set role authenticated;set request.jwt.claim.sub='{subject}';"+waiting_clock+';','authenticator')
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if reader.poll() is not None:raise AssertionError('Setup writer exited without waiting: '+reader.stderr.read())
            if run("set statement_timeout='2s';select exists(select 1 from pg_stat_activity a join pg_stat_activity b on b.datname=a.datname where a.datname=current_database() and a.application_name="+ql(app_a)+" and b.application_name="+ql(app_b)+" and a.pid<>b.pid and a.pid=any(pg_blocking_pids(b.pid)))::int",'postgres',timeout=4)=='1':wait_edges+=1;break
            time.sleep(.03)
        else:raise AssertionError('No actual setup writer G wait observed')
        _,holder_error=finish_race(holder,'commit;');assert holder.returncode==0,holder_error
        reader_out,reader_error=finish_race(reader)
        if case=='enable':
            assert reader.returncode==0,reader_error
            fresh_shift=json.loads(reader_out)
            from datetime import datetime
            check(datetime.fromisoformat(fresh_shift['clock_in_at'])==datetime.fromisoformat(stamp['tap']),'Post-G enabled setup preserves the frozen original paid tap with no job selected')
            check(run(f"select count(*) from work_setup_sessions where profile_id='{subject}' and shift_id='{fresh_shift['id']}' and started_at={ql(stamp['tap'])}::timestamptz",'postgres')=='1','Post-G enabled setup opens exactly one original-tap setup source')
            check(run(f"select count(*) from work_activity_clock_receipts where client_id='{command}' and receipt_protocol='setup_v1' and used_tap_time and review_reason is null",'postgres')=='1','Post-G enabled setup retains one genuine keyed receipt')
        else:
            expected='42501' if case=='revoke' else 'P0001'
            check(reader.returncode!=0 and re.search(r'\b'+expected+r'\b',reader_error),'Waiting setup uses fresh '+case+' admission')
            check(not reader_out.strip(),'Refused setup exposes no shift result')
            check(run(f"select (not exists(select 1 from time_shifts where profile_id='{subject}') and not exists(select 1 from work_setup_sessions where profile_id='{subject}') and not exists(select 1 from work_activity_clock_receipts where client_id='{command}') and not exists(select 1 from time_clock_actions where client_id='{command}'))::int",'postgres')=='1','Refused waiting setup leaves no payroll/setup/original or retained receipt')
    check(wait_edges==5,'All five readiness and actual payroll admission waits observed')
    check(run('select count(*) from company_settings','postgres')=='0','No scenario relies on or changes paid-date company policy')
    check(run('select count(*) from work_activity_operations','postgres')=='0','No setup admission frame survives a completed or refused call')

finally:
    for proc in race_processes:
        if proc.poll() is None:
            proc.terminate()
            try:proc.wait(timeout=2)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=2)

print(json.dumps({'result':'PASS','checks':checks,'cutoverSha256':EXPECTED_CUTOVER_SHA,'roleMetadataSha256':EXPECTED_ROLE_SHA,'capabilitySha256':capability_hash,'readinessBlockingEdges':2,'setupAdmissionBlockingEdges':wait_edges-2,**plan}))
