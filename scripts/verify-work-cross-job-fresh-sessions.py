#!/usr/bin/env python3
"""Held K6 PG17 fresh-login scenario plan. No database contact without --execute-fixture.

Requires successful unchanged inert kernel harness in the exact disposable local
fixture. Does not install SQL, enable v2, reseed a contract or fabricate receipts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
DATABASE = 'forge_work_activity_role_test'
CANDIDATE = 'supabase/migrations/20261108470000_work_cross_job_capture.sql'
SOURCE_SHA = 'c0eaccc11ca212853a3950bb64d47805990a2b4af824755a04d92b3fdf170c07'
CATALOG_SHA = '00db48aa715a066d2c3cd0ec73423a8af14e7338fa2c13e36ab2ff68b49f307e'
HARNESS_SHA = 'eb7f48d2c18d62da5d4b44659968c20de9a6ec8f7c2e1deb099a8576cb4a0ab3'
BASE_WORKFLOW_SHA = '36397182766579a90ae92f236cd1d1c7de232d4550e9db74af04cb7fbf3c3ca2' # review provenance; workflow extension may be additive
PINS = {
    CANDIDATE: SOURCE_SHA,
    'scripts/verify-work-cross-job-postgres.py': HARNESS_SHA,
    'scripts/work-cross-job-contract.json': '413cc4f8b7d208725d636645e7683bdf39933e7e5a7d850c5479a4a7afd533e7',
    'scripts/work-cross-job-catalog.sql': '6822b8642484030e1853e8a629749ec07515c02e5eafc1739c47cdfed9328435',
    'scripts/work-cross-job-profile.json': '1136e2abd04020a0446a94c1a3077217972eefad03048bd97cb03dacfd47bfe2',
    'scripts/work-cross-job-new-catalog.json': 'afa15ad342c8fdc9b2a7aa7e266ab1d2ee41c54eb9094fc7dc523f0d7da6e1b4',
    'scripts/fixtures/work-activity-engine-role-parity.json': '7df27ee90e2358a7b90eab3104f54b80c24537e736dde4555b101690e57513d2',
}
FIELDS = ('client_id','profile_id','shift_id','action','outcome','tapped_at','arrived_at','clock_checked_at','clock_skew_ms','used_tap_time','review_reason','source_created_at','receipt_protocol','setup_payload_digest','recorded_at')
TIMESTAMPS = ('tapped_at','arrived_at','clock_checked_at','source_created_at','recorded_at')
TABLE_FILTERS = {
    **{t:'profile_id' for t in ('time_shifts','time_clock_actions','work_activity_clock_receipts','work_cross_job_clock_requests','work_setup_sessions','personal_activity_state','personal_activity_transitions','work_activity_safety_events','work_cross_job_write_frames','work_cross_job_shifts','work_cross_job_allocations','work_cross_job_bindings','work_cross_job_resume','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions')},
    'personal_activity_commands':'subject_profile_id', 'work_activity_source_history':'actor_id',
    'work_activity_operations':'actor_id', 'work_activity_observations':'actor_id', 'opening_phases':'started_by',
}
# DB defaults, login-role defaults, and explicit connection options in both directions.
CASES = [(mode,a,b) for mode in ('database','login_role','connection') for a,b in (('UTC','America/Denver'),('America/Denver','UTC'))]
SCOPES = [(None, True), ('authenticator',False), ('authenticator',True), ('authenticated',False), ('authenticated',True)]
SETTINGS_SQL = """select coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'database',d.datname,'settings',s.setconfig) order by s.setdatabase,s.setrole),'[]'::jsonb) from pg_catalog.pg_db_role_setting s left join pg_catalog.pg_roles r on r.oid=s.setrole left join pg_catalog.pg_database d on d.oid=s.setdatabase where (s.setrole=0 and d.datname=current_database()) or (r.rolname in('authenticator','authenticated') and (s.setdatabase=0 or d.datname=current_database()))"""

def require(value, label):
    if not value:
        raise RuntimeError(label)

def ql(value):
    return "'" + str(value).replace("'", "''") + "'"

def qi(value):
    return '"' + value.replace('"', '""') + '"'

def uid(n):
    return '00000000-0000-4000-8000-' + str(610000+n).zfill(12)

def validate_source():
    for path, expected in PINS.items():
        require(hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==expected, 'Pinned source differs: '+path)
    source=(ROOT/CANDIDATE).read_text()
    require(re.search(r'rollback;\s*$',source,re.I), 'Candidate must remain terminal ROLLBACK')
    require(re.search(r'create function public\._work_cross_job_enabled\(\).*?\$\$select false\$\$',source,re.S), 'Held switch must remain literal false')
    profile=json.loads((ROOT/'scripts/work-cross-job-profile.json').read_text())
    require(profile['expectedOldCatalogSha256']=='18f1f9048e57087987020441e0aff395c5094ec8f677643078f551aa4d705950','Declared profile changed')
    metadata=json.loads((ROOT/'scripts/work-cross-job-new-catalog.json').read_text())['metadata']
    columns=[x['name'] for x in metadata['columns'] if x['table']=='work_activity_clock_receipts']
    require(columns==list(FIELDS),'Fingerprint field contract differs')
    for table,field in TABLE_FILTERS.items():
        require(any(x['table']==table and x['name']==field for x in metadata['columns']), 'Snapshot scope no longer valid: '+table)
    return metadata

def validate_target(value):
    try:
        target=urlparse(value);port=target.port
    except ValueError as error:
        raise RuntimeError('Refused invalid local fixture URL') from error
    require(target.scheme in ('postgres','postgresql') and target.hostname in ('localhost','127.0.0.1') and port in (None,5432)
            and target.path=='/'+DATABASE and target.username=='supabase_admin' and target.password=='fixture-only'
            and not target.query and not target.fragment, 'Refused: exact disposable localhost fixture required')
    return target

def validate_predecessor(receipt):
    require(receipt.get('status')=='passed' and receipt.get('stage')=='complete_inert_catalog_roles'
            and receipt.get('sourceSha256')==SOURCE_SHA and receipt.get('harnessSha256')==HARNESS_SHA
            and receipt.get('newCatalogSha256')==CATALOG_SHA and receipt.get('activation') is False,
            'Successful exact inert predecessor receipt required')

def prefix(role, database):
    if role is None:
        return 'ALTER DATABASE '+qi(DATABASE)
    return 'ALTER ROLE '+qi(role)+(' IN DATABASE '+qi(DATABASE) if database else '')

def settings_map(rows):
    return {(row['role'], row['database']):dict(item.split('=',1) for item in row['settings']) for row in rows}

def restore_sql(rows):
    saved=settings_map(rows);commands=[]
    for role,database in SCOPES:
        values=saved.get((role,DATABASE if database else None),{})
        for key in ('TimeZone','extra_float_digits'):
            commands.append(prefix(role,database)+' '+('SET '+qi(key)+' TO '+ql(values[key]) if key in values else 'RESET '+qi(key))+';')
    return 'BEGIN;'+''.join(commands)+'COMMIT;'

def configure_sql(mode, zone):
    require(mode in ('database','login_role','connection') and zone in ('UTC','America/Denver'),'Invalid controlled setting')
    other='America/Denver' if zone=='UTC' else 'UTC'
    commands=[]
    # Only two named GUCs are touched. Restore both presence and value later.
    for role,database in SCOPES:
        for key in ('TimeZone','extra_float_digits'):
            commands.append(prefix(role,database)+' RESET '+qi(key)+';')
    commands += [prefix(None,True)+' SET "TimeZone" TO '+ql(zone if mode=='database' else other)+';',prefix(None,True)+' SET extra_float_digits TO 1;']
    if mode=='login_role':
        commands.append(prefix('authenticator',False)+' SET "TimeZone" TO '+ql(zone)+';')
    # NOLOGIN authenticated defaults deliberately disagree; SET ROLE must not load them.
    commands += [prefix('authenticated',False)+' SET "TimeZone" TO '+ql(other)+';',prefix('authenticated',False)+' SET extra_float_digits TO -15;']
    return 'BEGIN;'+''.join(commands)+'COMMIT;'

class Runner:
    def __init__(self,target,execute=subprocess.run):
        self.target=target;self.execute=execute;self.calls=[]
        self.env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
        self.env['PGCONNECT_TIMEOUT']='3'
    def run(self,sql,user='postgres',zone=None,digits=None,error=None,message=None):
        require(user in ('postgres','authenticator','supabase_admin'),'Unknown fixture login')
        target=self.target
        uri=urlunparse((target.scheme,f'{user}:fixture-only@{target.hostname}:{target.port or 5432}',target.path,'','',''))
        env=dict(self.env)
        if zone is not None:
            require(zone in ('UTC','America/Denver'),'Invalid connection TimeZone')
            env['PGOPTIONS']='-c timezone='+zone
        if digits is not None:
            require(digits in (1,-15),'Invalid controlled float setting')
            env['PGOPTIONS']=env.get('PGOPTIONS','')+' -c extra_float_digits='+str(digits)
        prelude='\\set VERBOSITY verbose\n'
        # Runtime authenticator retains the genuine installed timeout defaults.
        if user!='authenticator':prelude+="set statement_timeout='20s';set lock_timeout='12s';set search_path=public,pg_temp;"
        result=self.execute(['psql',uri,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=prelude+sql,text=True,capture_output=True,timeout=35,env=env)
        self.calls.append({'login':user,'connectionTimeZone':zone,'connectionFloatDigits':digits,'returncode':result.returncode})
        if error:
            require(result.returncode!=0 and re.search(r'\b'+error+r'\b',result.stderr) and (not message or message in result.stderr), 'Unexpected refusal: '+result.stderr[-1800:])
        else:require(result.returncode==0,'Fixture SQL failed: '+result.stderr[-1800:])
        return result.stdout.strip()
    def json(self,sql,**kwargs):
        return json.loads(self.run(sql,**kwargs).splitlines()[-1])

class Scenario:
    def __init__(self,runner,output):
        self.r=runner;self.output=output;self.identities=set();self.report={'status':'running','checks':0,'labels':[],'sourceSha256':SOURCE_SHA,'catalogSha256':CATALOG_SHA,'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'activation':False,'freshSessionV1Proof':False,'v2SuccessProof':False,'genuineConcurrency':False,'providerOperations':False,'settingsRestored':False,'sessions':[],'scenarios':[],'holds':['Successful registered2 and nonregistered2 require separately authorized active source variant','All42 full-feature cases OPEN','Fresh-session proof pending execution; static/mock checks are not PG17 proof']}
    def persist(self):
        self.output.parent.mkdir(parents=True,exist_ok=True);temporary=self.output.with_name(self.output.name+'.tmp');temporary.write_text(json.dumps(self.report,indent=2)+'\n');temporary.replace(self.output)
    def check(self,value,label):
        require(value,label);self.report['checks']+=1;self.report['labels'].append(label);self.persist();print('PASS',self.report['checks'],label,flush=True)
    def guard(self):
        self.check(self.r.run("select _work_cross_job_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() and not _work_cross_job_enabled()")=='t','Exact source guards hold and global v2 flag remains false')
    def snapshot(self):
        actors=','.join(ql(uid(i))+'::uuid' for i in range(1,7));parts=[]
        for table,column in TABLE_FILTERS.items():
            parts += [ql(table),f"(select jsonb_build_object('count',(select count(*) from public.{qi(table)}),'fixtureRows',coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)) from public.{qi(table)} t where {qi(column)} in({actors}))"]
        parts += ["'authority'","(select to_jsonb(a) from public.work_activity_authority_generation a)","'contract'","(select to_jsonb(c) from public.work_cross_job_contract c)"]
        return self.r.json("set TimeZone='UTC';select jsonb_build_object("+','.join(parts)+');')
    def auth(self,actor,sql,expected_zone,connection_zone=None,digits=1,error=None,message=None):
        # Settings are asserted inside the same fresh session before any RPC.
        before="select jsonb_build_object('kind','login','pid',pg_backend_pid(),'sessionUser',session_user,'currentUser',current_user,'zone',current_setting('TimeZone'),'floatDigits',current_setting('extra_float_digits'),'backendStartEpoch',(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()));"
        check="DO $$BEGIN IF session_user<>'authenticator' OR current_user<>'authenticated' OR current_setting('TimeZone')<>"+ql(expected_zone)+" OR current_setting('extra_float_digits')<>"+ql(digits)+" THEN RAISE EXCEPTION 'Fresh runtime settings mismatch';END IF;END$$;"
        text=self.r.run(before+'SET ROLE authenticated;SET request.jwt.claim.sub='+ql(actor)+';'+check+"select jsonb_build_object('kind','runtime','sessionUser',session_user,'currentUser',current_user,'zone',current_setting('TimeZone'),'floatDigits',current_setting('extra_float_digits'));"+sql,user='authenticator',zone=connection_zone,digits=digits if digits!=1 else None,error=error,message=message)
        rows=[json.loads(line) for line in text.splitlines() if line.strip()];require(len(rows)>=2,'Fresh session identity evidence missing');login,runtime=rows[:2]
        identity=(login['pid'],login['backendStartEpoch']);require(identity not in self.identities,'Runtime connection was reused');self.identities.add(identity)
        require(login['sessionUser']==login['currentUser']=='authenticator' and runtime['currentUser']=='authenticated' and runtime['sessionUser']=='authenticator','Runtime login identity mismatch')
        require(login['zone']==runtime['zone']==expected_zone and login['floatDigits']==runtime['floatDigits']==str(digits),'SET ROLE unexpectedly changed serialization settings')
        self.report['sessions'].append({'login':login,'runtime':runtime,'expectedError':error});self.persist();return rows[2:]
    def clock_sql(self,actor,key,project,tap,checked,version=1):
        return "select jsonb_build_object('kind','paid','row',to_jsonb(h)) from public.clock_in("+ql(project)+"::uuid,null::uuid,null::text,37.123456789::double precision,-111.987654321::double precision,'Original note Ω'::text,null::text,"+ql(key)+'::uuid,'+ql(tap)+'::timestamptz,'+ql(checked)+'::timestamptz,0,'+str(version)+") h;select jsonb_build_object('kind','receipt','value',public.work_activity_clock_receipt("+ql(key)+'::uuid));'
    def compare_rows(self,first,replay):
        a=ql(json.dumps(first));b=ql(json.dumps(replay));return self.r.run('select jsonb_populate_record(null::public.time_shifts,'+a+'::jsonb) is not distinct from jsonb_populate_record(null::public.time_shifts,'+b+'::jsonb)')=='t'
    def corrupt(self,key,value):
        # Dedicated synthetic receipt only. Transaction restores every trigger's
        # exact enabled state before any genuine runtime retry sees the row.
        triggers=self.r.json("select coalesce(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled)),'[]'::jsonb) from pg_catalog.pg_trigger where tgrelid='public.work_activity_clock_receipts'::regclass and not tgisinternal and (tgtype&16)=16")
        require(triggers and all(t['enabled']=='O' for t in triggers),'Unexpected receipt trigger state')
        sql='BEGIN;'+''.join('ALTER TABLE public.work_activity_clock_receipts DISABLE TRIGGER '+qi(t['name'])+';' for t in triggers)
        sql+='UPDATE public.work_activity_clock_receipts SET arrived_at='+value+' WHERE client_id='+ql(key)+'::uuid;'
        sql+=''.join('ALTER TABLE public.work_activity_clock_receipts ENABLE TRIGGER '+qi(t['name'])+';' for t in triggers)+'COMMIT;'
        self.r.run(sql,user='supabase_admin')
    def field_checks(self,key):
        receipt=self.r.json("set TimeZone='UTC';select to_jsonb(r) from public.work_activity_clock_receipts r where client_id="+ql(key)+'::uuid')
        def fingerprint(patch):
            return self.r.run('select public._work_cross_job_clock_receipt_fingerprint(jsonb_populate_record(r,'+ql(json.dumps(patch))+'::jsonb)) from public.work_activity_clock_receipts r where client_id='+ql(key)+'::uuid')
        original=fingerprint({});patches={'client_id':uid(991),'profile_id':uid(992),'shift_id':uid(993),'action':'clock_out','outcome':'different','clock_skew_ms':42,'used_tap_time':not receipt['used_tap_time'],'review_reason':'different','receipt_protocol':'legacy','setup_payload_digest':'f'*64}
        patches.update({field:'2026-01-02T03:04:05.123456Z' for field in TIMESTAMPS})
        require(set(patches)==set(FIELDS),'Field coverage incomplete')
        for field,value in patches.items():self.check(fingerprint({field:value})!=original,'Actual helper binds retained '+field+' (read-only composite sensitivity)')
        self.check(fingerprint({'tapped_at':None})!=fingerprint({'tapped_at':'infinity'}),'NULL and infinity remain distinct in canonical helper')
        self.check(fingerprint({'recorded_at':'2026-01-02T03:04:05.123456Z'})!=fingerprint({'recorded_at':'2026-01-02T03:04:05.123457Z'}),'Actual helper preserves adjacent microseconds')
    def run(self):
        self.persist();saved=None
        try:
            self.check(self.r.run("select current_setting('server_version_num')::int/10000")=='17','Actual PostgreSQL17')
            self.check(self.r.run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t','Source-owner inspection uses nonsuperuser login')
            self.check(self.r.run("select session_user='supabase_admin' and (select rolsuper from pg_roles where rolname=session_user)",user='supabase_admin')=='t','Separate fixture administrator handles configuration and synthetic corruption controls')
            self.check(self.r.run("select not rolcanlogin from pg_roles where rolname='authenticated'")=='t','authenticated is NOLOGIN')
            self.check(self.r.run("select not rolsuper and not rolinherit from pg_roles where rolname='authenticator'")=='t','authenticator remains NOSUPERUSER NOINHERIT')
            self.guard();saved=self.r.json(SETTINGS_SQL,user='supabase_admin');self.report['originalSettings']=saved;self.persist()
            for number,(mode,from_zone,to_zone) in enumerate(CASES,1):
                actor,key,project=uid(number),uid(100+number),uid(200+number)
                self.check(self.r.run('select not exists(select 1 from auth.users where id='+ql(actor)+'::uuid)')=='t','Dedicated synthetic actor UUID is unused')
                self.r.run('BEGIN;insert into auth.users(id) values('+ql(actor)+');insert into profiles(id,display_name,role,is_test) values('+ql(actor)+",'Fresh-session fixture','owner',false);insert into projects(id,job_code,name) values("+ql(project)+','+ql('FRESH-'+str(number))+",'Fresh-session fixture');insert into toolbox_completions(profile_id,signed_at,typed_name) values("+ql(actor)+",clock_timestamp(),'Synthetic');COMMIT;")
                times=self.r.json("select jsonb_build_object('tap',public._work_activity_iso(date_trunc('second',clock_timestamp())-interval '1 minute'+interval '0.123456 seconds'),'checked',public._work_activity_iso(clock_timestamp()))")
                call=self.clock_sql(actor,key,project,times['tap'],times['checked'])
                self.r.run(configure_sql(mode,from_zone),user='supabase_admin')
                first=self.auth(actor,call,from_zone,from_zone if mode=='connection' else None)
                require(len(first)==2 and first[0]['row']['profile_id']==actor and first[0]['row']['status']=='open' and first[0]['row']['clock_out_at'] is None,'Paid stamp result missing')
                proof=self.r.json('select jsonb_build_object(\'version\',v.setup_version,\'registered\',exists(select 1 from public.work_cross_job_shifts x where x.shift_id=v.shift_id),\'hashMatches\',v.receipt_sha256=public._work_cross_job_clock_receipt_fingerprint(r)) from public.work_cross_job_clock_requests v join public.work_activity_clock_receipts r using(client_id) where v.client_id='+ql(key)+'::uuid')
                self.check(proof=={'version':1,'registered':False,'hashMatches':True},mode+' supported v1 original request stamps real immutable evidence')
                self.report['scenarios'].append({'mode':mode,'from':from_zone,'to':to_zone,'actor':actor,'originalClientId':key,'originalPaidRow':first[0]['row'],'originalReceiptWire':first[1]['value'],'requestProof':proof,'authorityCaptureEnabled':self.r.json('select to_jsonb(capture_enabled) from public.work_activity_authority_generation where singleton')})
                self.persist()
                before=self.snapshot();self.r.run(configure_sql(mode,to_zone),user='supabase_admin')
                retry=self.auth(actor,call,to_zone,to_zone if mode=='connection' else None)
                self.check(len(retry)==2 and self.compare_rows(first[0]['row'],retry[0]['row']) and first[1]==retry[1],mode+' '+from_zone+' to '+to_zone+' exact original paid row and receipt replay')
                self.check(self.snapshot()==before,mode+' retry changes no fixture paid/source/history/request rows or selected global counts')
                self.guard()
                # The globally disabled version2 admission is a real refusal,
                # not a claimed successful authority-capture-disabled fallback.
                v2=self.clock_sql(actor,uid(300+number),project,times['tap'],times['checked'],2)
                self.auth(actor,v2,to_zone,to_zone if mode=='connection' else None,error='23514',message='Unsupported paid setup protocol.')
                self.check(self.snapshot()==before,mode+' literal-false v2 entry refuses with zero measured writes')
                if number==1:
                    self.field_checks(key)
                    original_arrived=self.r.run('select public._work_activity_iso(arrived_at) from public.work_activity_clock_receipts where client_id='+ql(key)+'::uuid')
                    try:
                        self.corrupt(key,"arrived_at+interval '1 microsecond'");self.guard();corrupt_before=self.snapshot()
                        for zone in ('UTC','America/Denver'):
                            self.auth(actor,call,zone,zone,error='42501',message='Clock receipt unavailable.')
                            self.check(self.snapshot()==corrupt_before,zone+' real receipt microsecond corruption refuses without measured writes')
                    finally:self.corrupt(key,ql(original_arrived)+'::timestamptz')
                    self.check(self.snapshot()==before,'Exact synthetic receipt and original catalog restored after corruption')
                    # Existing legacy coordinate serializer limitation: explicit
                    # incompatible connection setting, never a historical rewrite.
                    self.auth(actor,call,to_zone,to_zone,digits=-15,error='23514',message='Clock command identity conflicts.')
                    self.check(self.snapshot()==before,'Changed extra_float_digits refuses original non-null-coordinate payload with zero measured writes')
                    normal=self.auth(actor,call,to_zone,to_zone)
                    self.check(self.compare_rows(first[0]['row'],normal[0]['row']) and first[1]==normal[1] and self.snapshot()==before,'Normal float setting still replays untouched original evidence')
            self.guard();self.report['status']='passed';self.report['freshSessionV1Proof']=True
            self.report['holds']=['Successful registered2 and nonregistered2 remain unexecuted with literal false admission','All42 full-feature cases OPEN','No concurrency, volume, latency, provider or device proof']
        except BaseException as error:
            self.report.update(status='failed',failure={'type':type(error).__name__,'message':str(error)[-2200:]});raise
        finally:
            try:
                if saved is not None:
                    self.r.run(restore_sql(saved),user='supabase_admin')
                    restored=self.r.json(SETTINGS_SQL,user='supabase_admin')
                    require(settings_map(restored)==settings_map(saved),'Role/database defaults did not restore exactly')
                    self.report['settingsRestored']=True
            except BaseException as error:
                self.report.update(status='failed',restorationFailure=str(error)[-2200:]);raise
            finally:self.report['connections']=self.r.calls;self.persist()
        return self.report

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check-plan',action='store_true');parser.add_argument('--execute-fixture',action='store_true');args=parser.parse_args(argv)
    require(not(args.check_plan and args.execute_fixture),'Choose plan or fixture execution')
    validate_source()
    if not args.execute_fixture:
        print(json.dumps({'status':'PLAN VALIDATED','databaseTests':False,'sourceSha256':SOURCE_SHA,'cases':CASES,'v2SuccessProof':False,'activation':False,'scope':'New separate fresh-login v1 proof plus genuine v2 refusal; actual runtime unexecuted'}));return 0
    target=validate_target(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
    predecessor=Path(os.environ['WORK_CROSS_JOB_POSTGRES_OUT']);validate_predecessor(json.loads(predecessor.read_text()))
    output=Path(os.environ['WORK_CROSS_JOB_FRESH_SESSIONS_OUT'])
    require(output.resolve()!=predecessor.resolve(),'New report must not overwrite inert predecessor receipt')
    require(output.name=='work-cross-job-fresh-sessions.json' and output.resolve().parent==predecessor.resolve().parent and not output.exists(),'New report must be an unused fresh-session artifact beside the inert receipt')
    Scenario(Runner(target),output).run();return 0

if __name__=='__main__':
    raise SystemExit(main())
