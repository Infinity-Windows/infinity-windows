#!/usr/bin/env python3
"""SOURCE-ONLY by default. Explicit disposable PG17 protocol2 fixture executor.

Starts after unchanged0846, owns exact47/66 predecessor processes, then applies
one authored private-gate body delta. Never installs a provider or learns an
expected proof from the live catalog. No database contact in default/check-plan.
"""
import argparse
import copy
from datetime import datetime
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
PROFILE = 'scripts/work-cross-job-v2-profile.json'
PROFILE_SHA = 'c32aa60337e3f55ba334c2e91f7692281458a2e0e896685ec6cb9d86b480096f'
CANDIDATE = 'supabase/migrations/20261108470000_work_cross_job_capture.sql'
INERT = 'scripts/work-cross-job-v2-authored-inert-catalog.json'
ACTIVE = 'scripts/work-cross-job-v2-authored-active-catalog.json'
DATABASE = 'forge_work_activity_role_test'
REPORT_NAME = 'work-cross-job-v2.json'
GATE_TRUE = 'create or replace function public._work_cross_job_enabled() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$;'
GATE_FALSE = GATE_TRUE.replace('select true', 'select false')
INSTANCE_SQL = "select jsonb_build_object('systemIdentifier',(select system_identifier::text from pg_control_system()),'postmasterStart',extract(epoch from pg_postmaster_start_time())::text,'databaseOid',(select oid::text from pg_database where datname=current_database()),'database',current_database(),'serverVersionNum',current_setting('server_version_num'))"
GUARDS_SQL = "select jsonb_build_object('cross',_work_cross_job_coverage(),'review',_work_unit_review_coverage(),'totals',_work_totals_coverage(),'contributors',_work_unit_contributors_coverage(),'enabled',_work_cross_job_enabled())"
FIELDS = ('client_id','profile_id','shift_id','action','outcome','tapped_at','arrived_at','clock_checked_at','clock_skew_ms','used_tap_time','review_reason','source_created_at','receipt_protocol','setup_payload_digest','recorded_at')
BUSINESS_TABLES = {
    **{name:'profile_id' for name in ('time_shifts','time_clock_actions','work_activity_clock_receipts','work_cross_job_clock_requests','work_setup_sessions','personal_activity_state','personal_activity_transitions','work_activity_safety_events','work_cross_job_write_frames','work_cross_job_shifts','work_cross_job_allocations','work_cross_job_bindings','work_cross_job_resume','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions')},
    'personal_activity_commands':'subject_profile_id','work_activity_source_history':'actor_id','work_activity_operations':'actor_id',
}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def q(value):
    return 'null' if value is None else "'" + str(value).replace("'", "''") + "'"


def uid(n):
    return '00000000-0000-4000-8000-' + str(720000+n).zfill(12)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def exact(value, keys, label):
    require(isinstance(value, dict) and set(value)==set(keys), 'Exact '+label+' keys required')



def normalize_settings(rows):
    """Compare complete pg_db_role_setting maps without array/order artifacts."""
    require(isinstance(rows,list),'Invalid database/role settings rows')
    result={}
    for row in rows:
        exact(row,('setdatabase','setrole','setconfig'),'database/role setting row')
        require(all(type(row[k]) is int and row[k]>=0 for k in ('setdatabase','setrole')),'Invalid setting role/database identity')
        identity=(row['setdatabase'],row['setrole'])
        require(identity not in result,'Duplicate database/role settings row')
        config=row['setconfig'];require(config is None or isinstance(config,list),'Invalid settings array')
        values={}
        for entry in config or []:
            require(isinstance(entry,str) and '=' in entry,'Invalid setting entry')
            key,value=entry.split('=',1)
            require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*',key),'Invalid setting key')
            key=key.lower();require(key not in values,'Duplicate setting key')
            values[key]=value
        result[identity]=None if config is None else tuple(sorted(values.items()))
    return tuple(sorted(result.items()))


def validate_settings_restored(saved,rows):
    require(normalize_settings(rows)==saved,'Predecessor database/role settings changed')
    return True


def error_evidence(error):
    return {'type':type(error).__name__,'message':str(error)[-2200:]}


def instant(value):
    require(isinstance(value,str),'Paid timestamp must be a string')
    parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    require(parsed.tzinfo is not None,'Paid timestamp needs timezone')
    return parsed


def validate_paid_response(action,response,original,times):
    """Actual keyed SQL contracts: row / {outcome,shift} / row."""
    require(action in ('start_break','end_break','clock_out'),'Unknown paid response action')
    if action=='end_break':
        exact(response,('outcome','shift'),'keyed end_break envelope')
        require(response['outcome']=='ended','Expected actual ended break outcome')
        row=response['shift']
    else:row=response
    exact(row,original.keys(),'time_shifts row')
    require(all(row[k]==original[k] for k in ('id','profile_id','project_id','cost_code_id')) and instant(row['clock_in_at'])==instant(original['clock_in_at']),'Paid response changed original physical shift/job/cost/start')
    tap=times[{'start_break':'break','end_break':'return','clock_out':'out'}[action]]
    require(instant(row['last_punch_at'])==instant(tap),'Paid response did not retain exact punch tap')
    require(row['review_reason']==original['review_reason'],'Normal paid lifecycle acquired review reason')
    if action=='start_break':
        require(row['status']=='open' and row['clock_out_at'] is None and row['break_type']=='rest' and instant(row['break_started_at'])==instant(tap) and row['break_seconds']==original['break_seconds'],'Invalid actual started break row')
    else:
        require(row['break_started_at'] is None and row['break_type'] is None,'Paid response retained a running break')
        seconds=int((instant(times['return'])-instant(times['break'])).total_seconds())
        require(row['break_seconds']==original['break_seconds']+seconds,'Paid response break duration differs from original taps')
        if action=='end_break':require(row['status']=='open' and row['clock_out_at'] is None,'Break return changed open paid status')
        else:require(row['status']=='submitted' and instant(row['clock_out_at'])==instant(tap) and row['injured'] is False and row['time_confirmed'] is True,'Invalid actual clock_out row')
    return row


def require_snapshot_state(rows,actor):
    # The supported prior clock operation must already have refreshed this row.
    # Do not omit private state from business equality to accommodate a refresh.
    require(sum(row['profile_id']==actor for row in rows['personal_activity_state'])==1,'Refusal snapshot requires the prior paid operation private state')

def authored_delta(inert, active, delta):
    expected=copy.deepcopy(inert)
    matches=[f for f in expected['functions'] if f['name']==delta['function'] and f['arguments']==delta['arguments']]
    require(len(matches)==1 and matches[0][delta['field']]==delta['before'], 'Authored inert private gate differs')
    matches[0][delta['field']]=delta['after']
    require(expected==active, 'Only the one authored gate body delta is allowed')


def validate_source():
    require(sha(ROOT/PROFILE)==PROFILE_SHA, 'V2 fixture authored profile drift')
    profile=json.loads((ROOT/PROFILE).read_text())
    for path, digest in profile['sourcePins'].items():
        require(sha(ROOT/path)==digest, 'Pinned source differs: '+path)
    source=(ROOT/CANDIDATE).read_text()
    require(re.search(r'rollback;\s*$',source,re.I), 'Source must remain terminal ROLLBACK')
    require('as $$select false$$;' in source and GATE_TRUE not in source, 'Source literal-false gate changed')
    inert=json.loads((ROOT/INERT).read_text());active=json.loads((ROOT/ACTIVE).read_text())
    authored_delta(inert,active,profile['allowedCatalogDelta'])
    original=json.loads((ROOT/'scripts/work-cross-job-new-catalog.json').read_text())
    require(original['metadata']==inert and hashlib.sha256(original['canonicalCatalogText'].encode()).hexdigest()==profile['inertCatalogDigest'], 'Authored inert catalog is not the reviewed canonical input')
    require([x['name'] for x in inert['columns'] if x['table']=='work_activity_clock_receipts']==list(FIELDS),'Exact fifteen-field retained receipt contract changed')
    for table,column in BUSINESS_TABLES.items():
        require(any(x['table']==table and x['name']==column for x in inert['columns']), 'Invalid fixture snapshot scope: '+table)
    return profile,inert,active


def validate_target(value):
    try:
        target=urlparse(value);port=target.port
    except ValueError as error:
        raise RuntimeError('Invalid fixture URL') from error
    require(target.scheme in ('postgres','postgresql') and target.hostname in ('localhost','127.0.0.1') and port==5432
            and target.path=='/'+DATABASE and target.username=='supabase_admin' and target.password=='fixture-only'
            and not target.params and not target.query and not target.fragment, 'Exact explicit localhost:5432 fixture credentials/database required')
    return target


def same_instance(a,b):
    exact(a,('systemIdentifier','postmasterStart','databaseOid','database','serverVersionNum'),'instance')
    require(a==b and a['database']==DATABASE and int(a['serverVersionNum'])//10000==17,'Database instance changed or is not PostgreSQL17')
    require(all(isinstance(a[k],str) and a[k] for k in a),'Incomplete database instance identity')


def validate_predecessor(kind, receipt, profile):
    source=profile['sourcePins'][CANDIDATE]
    require(receipt.get('status')=='passed' and receipt.get('checks')==(47 if kind=='inert' else 66) and receipt.get('activation') is False,'Exact successful predecessor count/status required')
    require(receipt.get('sourceSha256')==source,'Predecessor source mismatch')
    if kind=='inert':
        require(receipt.get('stage')=='complete_inert_catalog_roles' and receipt.get('newCatalogSha256')==profile['inertCatalogDigest']
                and receipt.get('harnessSha256')==profile['sourcePins']['scripts/verify-work-cross-job-postgres.py'],'Wrong inert predecessor')
    else:
        require(receipt.get('freshSessionV1Proof') is True and receipt.get('v2SuccessProof') is False and receipt.get('settingsRestored') is True
                and receipt.get('scriptSha256')==profile['sourcePins']['scripts/verify-work-cross-job-fresh-sessions.py']
                and receipt.get('catalogSha256')==profile['inertCatalogDigest'] and len(receipt.get('sessions',[]))==22,'Wrong fresh66 predecessor or settings restoration')


class Report:
    def __init__(self,output):
        output=Path(output)
        require(output.is_absolute() and output.name==REPORT_NAME,'New absolute v2 output filename required')
        require(ROOT not in output.resolve().parents and not output.parent.exists(),'Unused output directory outside the checkout required')
        output.parent.mkdir(parents=True,exist_ok=False)
        self.path=output;self.value={'status':'running','stage':'initial_before_source_target_or_predecessors','checks':0,'labels':[],
            'sourceValidated':False,'databaseContacted':False,'fixtureOnlyOverride':False,'productionActivation':False,'providerOperations':False,
            'v2SuccessProof':False,'genuineConcurrency':False,'v2VolumeProof':False,'paidWaitBudgetProof':False,'catalogRestored':False,
            'scope':'First finite disposable active-v2 fixture; all42/full20 remain OPEN','calls':[],'sessions':[],'cases':[],
            'timeoutsSeconds':{'inspectionStatement':20,'inspectionLock':12,'runtimeInstalledStatement':8,'runtimeInstalledLock':8,'psqlProcess':35,'eachPredecessorProcess':1200},
            'coverageLimits':['No provider/device/runtime-client proof','No two-session version2 or volume/paid-wait proof','Four other source families and all42/full20 remain OPEN',
            'Read-version refusals may insert private observations; business row equality is measured separately',
            'Version1 report guards intentionally close after first registered2 shift','No public version2 paid clock receipt reader'],
            'scriptSha256':sha(__file__)}
        self.persist()
    def persist(self,stage=None):
        if stage:self.value['stage']=stage
        tmp=self.path.with_suffix('.tmp');tmp.write_text(json.dumps(self.value,indent=2)+'\n');tmp.replace(self.path)
    def check(self,condition,label):
        require(condition,label);self.value['checks']+=1;self.value['labels'].append(label);self.persist();print('PASS',self.value['checks'],label,flush=True)


class Runner:
    def __init__(self,target,report,execute=subprocess.run):
        self.target=target;self.report=report;self.execute=execute
        self.env={k:v for k,v in os.environ.items() if not k.startswith('PG')};self.env['PGCONNECT_TIMEOUT']='3'
    def run(self,sql,user='postgres',zone='UTC',digits=1,error=None,message=None):
        require(user in ('postgres','supabase_admin','authenticator') and zone in ('UTC','America/Denver') and digits in (1,-15),'Invalid bounded fixture session')
        t=self.target;uri=urlunparse((t.scheme,f'{user}:fixture-only@{t.hostname}:5432',t.path,'','',''))
        env=dict(self.env,PGOPTIONS='-c timezone='+zone+' -c extra_float_digits='+str(digits))
        prelude='\\set VERBOSITY verbose\n'
        if user!='authenticator':prelude+="set statement_timeout='20s';set lock_timeout='12s';set search_path=public,pg_temp;"
        started=time.monotonic();call={'login':user,'zone':zone,'floatDigits':digits,'sqlSha256':hashlib.sha256(sql.encode()).hexdigest(),'status':'waiting'}
        self.report.value['calls'].append(call);self.report.value['databaseContacted']=True;self.report.persist('psql_wait')
        try:
            result=self.execute(['psql',uri,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=prelude+sql,text=True,capture_output=True,timeout=35,env=env)
            call.update(status='returned',returncode=result.returncode)
            if error:require(result.returncode!=0 and re.search(r'\b'+re.escape(error)+r'\b',result.stderr) and (not message or message in result.stderr),'Unexpected SQL refusal: '+result.stderr[-1600:])
            else:require(result.returncode==0,'Fixture SQL failed: '+result.stderr[-1600:])
            return result.stdout.strip()
        finally:
            call['wallMillisecondsIncludingPsql']=round((time.monotonic()-started)*1000,3);self.report.persist()
    def json(self,sql,**kwargs):
        return json.loads(self.run(sql,**kwargs).splitlines()[-1])


def predecessor_process(script,args,env,log,report,popen=subprocess.Popen):
    require(not log.exists(),'Never overwrite predecessor process evidence')
    deadline=time.monotonic()+1200
    with log.open('x') as stream:
        report.persist('starting_'+script.name)
        process=popen([sys.executable,str(script),*args],cwd=ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT,text=True)
        try:
            while True:
                report.value['predecessorWait']={'script':script.name,'remainingSeconds':max(0,round(deadline-time.monotonic(),1))};report.persist('waiting_'+script.name)
                try:
                    code=process.wait(timeout=min(5,max(.001,deadline-time.monotonic())))
                    require(code==0,'Pinned predecessor failed: '+script.name);return
                except subprocess.TimeoutExpired:
                    require(time.monotonic()<deadline,'Pinned predecessor exceeded finite process budget')
        finally:
            if process.poll() is None:
                process.kill();report.persist('waiting_predecessor_cleanup');process.wait(timeout=5)
            report.persist()


class Fixture:
    def __init__(self,r,report,profile,inert,active):
        self.r=r;self.report=report;self.profile=profile;self.inert=inert;self.active=active;self.identities=set()
        self.catalog=(ROOT/'scripts/work-cross-job-catalog.sql').read_text().strip().removesuffix(';')
        self.actors=[uid(x) for x in (1,2,3,4,5)];self.owner=uid(3);self.job_a=uid(10);self.job_b=uid(11);self.cost=uid(12)
        self.next_id=1000;self.active_enrolled=False;self.enrollment_attempted=False
    def new_id(self):
        self.next_id+=1;return uid(self.next_id)
    def check(self,value,label):self.report.check(value,label)
    def catalog_equal(self,expected,label):
        # Expected is always a pinned authored object, never the live result.
        result=self.r.run('select ('+self.catalog+') is not distinct from '+q(encoded(expected))+'::jsonb')
        self.check(result=='t',label)
    def authored_digest(self,expected):
        return self.r.run("select encode(sha256(convert_to("+q(encoded(expected))+"::jsonb::text,'UTF8')),'hex')")
    def instance(self):return self.r.json(INSTANCE_SQL,user='supabase_admin')
    def guards(self,registered,enabled=True):
        got=self.r.json(GUARDS_SQL)
        self.check(got=={'cross':True,'review':not registered,'totals':not registered,'contributors':not registered,'enabled':enabled},'Exact cross-job coverage and authored report-fence state')
    def predecessors(self):
        identity=self.instance();same_instance(identity,identity);self.report.value['instance']=identity;self.report.persist()
        self.check(self.r.run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t','Actual nonsuperuser source owner')
        self.check(self.r.run("select to_regclass('public.work_cross_job_contract') is null and to_regprocedure('public._work_cross_job_enabled()') is null")=='t','Starts after0846, refuses already installed0847')
        old=json.loads((ROOT/'scripts/work-cross-job-old-catalog.json').read_text())['metadata'];self.catalog_equal(old,'Whole authored old catalog before predecessor install')
        out=self.report.path.parent/'predecessors';out.mkdir(exist_ok=False)
        env=dict(self.r.env,WORK_ACTIVITY_ROLE_TEST_DB_URL=urlunparse(self.r.target),WORK_CROSS_JOB_POSTGRES_OUT=str(out/'work-cross-job-postgres.json'),WORK_CROSS_JOB_FRESH_SESSIONS_OUT=str(out/'work-cross-job-fresh-sessions.json'))
        settings_sql="select coalesce(jsonb_agg(jsonb_build_object('setdatabase',setdatabase::bigint,'setrole',setrole::bigint,'setconfig',setconfig) order by setdatabase,setrole),'[]'::jsonb) from pg_db_role_setting"
        for kind,name,args in [('inert','verify-work-cross-job-postgres.py',[]),('fresh','verify-work-cross-job-fresh-sessions.py',['--execute-fixture'])]:
            before=self.instance();same_instance(identity,before);settings=normalize_settings(self.r.json(settings_sql,user='supabase_admin'))
            self.report.value['predecessorInstanceBefore']=before;self.report.persist()
            predecessor_process(ROOT/'scripts'/name,args,env,out/(kind+'.log'),self.report)
            after=self.instance();same_instance(identity,after)
            receipt=out/('work-cross-job-postgres.json' if kind=='inert' else 'work-cross-job-fresh-sessions.json');data=json.loads(receipt.read_text());validate_predecessor(kind,data,self.profile)
            self.check(validate_settings_restored(settings,self.r.json(settings_sql,user='supabase_admin')),'Predecessor restores all original database/role settings: '+kind)
            self.report.value.setdefault('predecessors',[]).append({'kind':kind,'receipt':str(receipt),'sha256':sha(receipt),'instanceBefore':before,'instanceAfter':after,'checks':data['checks']});self.report.persist()
            self.catalog_equal(self.inert,'Whole authored inert catalog after '+kind)
        self.guards(False,False)
    def enroll(self):
        self.check(self.r.run("select not exists(select 1 from pg_event_trigger where evtenabled<>'D')",user='supabase_admin')=='t','Plain disposable fixture requires no enabled event triggers; refuse provider DDL policies without bypass')
        self.catalog_equal(self.inert,'Authored inert catalog immediately before fixture construction')
        digest=self.authored_digest(self.active);require(re.fullmatch('[a-f0-9]{64}',digest),'Invalid authored PG canonical digest')
        self.check(self.authored_digest(self.inert)==self.profile['inertCatalogDigest'],'Authored inert jsonb::text matches reviewed canonical root')
        self.report.value['authoredActiveCatalogDigest']=digest;self.report.value['fixtureOnlyOverride']=True;self.report.value['allowedCatalogDelta']=self.profile['allowedCatalogDelta'];self.report.persist('enrolling_authored_fixture')
        # One transaction: exact catalog pre/post assertion, temporarily disable
        # ONLY the immutable proof-row trigger, restore before any runtime call.
        sql="BEGIN;DO $$BEGIN IF ("+self.catalog+") IS DISTINCT FROM "+q(encoded(self.inert))+"::jsonb THEN RAISE EXCEPTION 'Inert catalog drift';END IF;END$$;"+GATE_TRUE
        sql+="DO $$BEGIN IF ("+self.catalog+") IS DISTINCT FROM "+q(encoded(self.active))+"::jsonb THEN RAISE EXCEPTION 'Unauthorized fixture catalog delta';END IF;END$$;"
        sql+="ALTER TABLE public.work_cross_job_contract DISABLE TRIGGER work_cross_job_contract_immutable;"
        # This expression derives expected proof solely from AUTHORED active JSON.
        sql+="UPDATE public.work_cross_job_contract SET expected_catalog_sha256=encode(sha256(convert_to("+q(encoded(self.active))+"::jsonb::text,'UTF8')),'hex') WHERE proof_key='cross_job_kernel_2' AND expected_catalog_sha256="+q(self.profile['inertCatalogDigest'])+';'
        sql+="ALTER TABLE public.work_cross_job_contract ENABLE TRIGGER work_cross_job_contract_immutable;DO $$BEGIN IF NOT public._work_cross_job_coverage() THEN RAISE EXCEPTION 'Authored enrollment failed';END IF;END$$;SELECT public._work_activity_gate();UPDATE public.work_activity_authority_generation SET capture_enabled=false,revision=revision+1;COMMIT;"
        self.enrollment_attempted=True;self.r.run(sql,user='supabase_admin');self.active_enrolled=True
        self.catalog_equal(self.active,'Only authored active catalog after enrollment');self.guards(False)
    def restore(self):
        if not self.enrollment_attempted:return
        if not self.active_enrolled:
            # A client timeout does not establish whether COMMIT happened.
            live=self.r.json(self.catalog)
            if live==self.inert:
                self.report.value['catalogRestored']=True;self.report.persist();return
            require(live==self.active,'Ambiguous enrollment left unreviewed catalog; refuse normalization')
        # Retain all synthetic rows. Restore the catalog, expected proof and held
        # flags; no operational cleanup/deletion or lineage rewrite is performed.
        self.catalog_equal(self.active,'Active catalog exact before restoration')
        sql='BEGIN;'+GATE_FALSE+'ALTER TABLE public.work_cross_job_contract DISABLE TRIGGER work_cross_job_contract_immutable;'
        sql+='UPDATE public.work_cross_job_contract SET expected_catalog_sha256='+q(self.profile['inertCatalogDigest'])+" WHERE proof_key='cross_job_kernel_2';ALTER TABLE public.work_cross_job_contract ENABLE TRIGGER work_cross_job_contract_immutable;"
        sql+='SELECT public._work_activity_gate();UPDATE public.work_activity_authority_generation SET capture_enabled=false,revision=revision+1;COMMIT;'
        self.r.run(sql,user='supabase_admin');self.catalog_equal(self.inert,'Restored authored inert catalog and proof; retained synthetic history')
        self.check(self.r.run('select not _work_cross_job_enabled() and _work_cross_job_coverage() and not (select capture_enabled from work_activity_authority_generation where singleton)')=='t','Held gate and capture flag restored false')
        self.report.value['catalogRestored']=True;self.report.persist()
    def auth(self,actor,sql,zone='UTC',digits=1,error=None,message=None):
        login="select jsonb_build_object('kind','login','pid',pg_backend_pid(),'backendStart',(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()),'sessionUser',session_user,'currentUser',current_user,'zone',current_setting('TimeZone'),'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'));"
        runtime="SET ROLE authenticated;SET request.jwt.claim.sub="+q(actor)+";select jsonb_build_object('kind','runtime','sessionUser',session_user,'currentUser',current_user,'jwtSubject',auth.uid(),'zone',current_setting('TimeZone'),'floatDigits',current_setting('extra_float_digits'),'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'));"
        guard="DO $$BEGIN IF session_user<>'authenticator' OR current_user<>'authenticated' OR auth.uid() IS DISTINCT FROM "+q(actor)+"::uuid OR current_setting('statement_timeout')<>'8s' OR current_setting('lock_timeout')<>'8s' THEN RAISE EXCEPTION 'Runtime identity or installed timeout changed';END IF;END$$;"
        rows=[json.loads(x) for x in self.r.run(login+runtime+guard+sql,user='authenticator',zone=zone,digits=digits,error=error,message=message).splitlines() if x.strip()]
        require(len(rows)>=2,'Missing fresh runtime identity evidence');a,b=rows[:2];identity=(a['pid'],a['backendStart'])
        require(identity not in self.identities and a['sessionUser']==a['currentUser']=='authenticator' and b['sessionUser']=='authenticator' and b['currentUser']=='authenticated' and b['jwtSubject']==actor,'Actual fresh LOGIN/SET ROLE/JWT subject mismatch')
        require(a['zone']==b['zone']==zone and b['floatDigits']==str(digits) and a['statementTimeout']==b['statementTimeout']=='8s' and a['lockTimeout']==b['lockTimeout']=='8s','Runtime setting mismatch; no timeout normalization allowed')
        self.identities.add(identity);self.report.value['sessions'].append({'login':a,'runtime':b,'expectedError':error});self.report.persist()
        return rows[2:]
    def rpc(self,actor,expression,**kwargs):
        rows=self.auth(actor,'select '+expression+';',**kwargs)
        require(len(rows)==1,'Expected one actual RPC response');return rows[0]
    def rows(self):
        actors=','.join(q(a)+'::uuid' for a in self.actors);pieces=[]
        for table,column in BUSINESS_TABLES.items():
            pieces.extend([q(table),"(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from public."+table+' t where '+column+' in('+actors+'))'])
        pieces.extend(["'heads'","(select coalesce(jsonb_agg(to_jsonb(t) order by shift_id),'[]'::jsonb) from work_cross_job_heads t where shift_id in(select id from time_shifts where profile_id in("+actors+")))"])
        return self.r.json('select jsonb_build_object('+','.join(pieces)+')')
    def observations(self):
        return self.r.json('select jsonb_build_object(\'count\',count(*),\'ids\',coalesce(jsonb_agg(id order by id),\'[]\'::jsonb)) from work_activity_observations where actor_id in('+','.join(q(a)+'::uuid' for a in self.actors)+')')
    def paid(self,shift):
        return self.r.json("select jsonb_build_object('row',to_jsonb(s),'xmin',xmin::text,'ctid',ctid::text,'actions',(select count(*) from time_clock_actions a where a.shift_id=s.id),'retainedReceipts',(select count(*) from work_activity_clock_receipts r where r.shift_id=s.id)) from time_shifts s where id="+q(shift)+'::uuid')
    def retained(self,key):
        row=self.r.json('select to_jsonb(r) from work_activity_clock_receipts r where client_id='+q(key)+'::uuid');exact(row,FIELDS,'retained paid receipt');return row
    def compare_paid_wire(self,first,replay):
        return self.r.run('select jsonb_populate_record(null::public.time_shifts,'+q(encoded(first))+'::jsonb) is not distinct from jsonb_populate_record(null::public.time_shifts,'+q(encoded(replay))+'::jsonb)')=='t'
    def clock_sql(self,key,version,tap):
        return 'to_jsonb(public.clock_in('+q(self.job_a)+'::uuid,'+q(self.cost)+"::uuid,null::text,37.123456789::double precision,-111.987654321::double precision,'V2 fixture original Ω'::text,null::text,"+q(key)+'::uuid,'+q(tap)+'::timestamptz,'+q(self.times['checked'])+'::timestamptz,0,'+str(version)+'))'
    def request_proof(self,key):
        return self.r.json("select jsonb_build_object('version',v.setup_version,'registered',exists(select 1 from work_cross_job_shifts x where x.shift_id=v.shift_id),'fingerprintMatches',v.receipt_sha256=_work_cross_job_clock_receipt_fingerprint(r)) from work_cross_job_clock_requests v join work_activity_clock_receipts r using(client_id) where v.client_id="+q(key)+'::uuid')
    def seed(self):
        actors=','.join(q(a) for a in self.actors)
        self.check(self.r.run('select not exists(select 1 from auth.users where id in('+actors+'))')=='t','Dedicated v2 fixture actor IDs unused')
        sql='BEGIN;insert into auth.users(id) values '+','.join('('+q(a)+')' for a in self.actors)+';'
        sql+='insert into profiles(id,display_name,role,is_test) values '+','.join('('+q(a)+','+q('V2 fixture '+str(i))+','+q('owner' if a==self.owner else 'installer')+',false)' for i,a in enumerate(self.actors))+';'
        sql+='insert into projects(id,job_code,name) values('+q(self.job_a)+",'V2-PG-A','Synthetic A'),("+q(self.job_b)+",'V2-PG-B','Synthetic B');insert into cost_codes(id,code,label) values("+q(self.cost)+",'V2-PG-COST','Synthetic physical cost');"
        sql+='insert into project_openings(id,project_id,opening_code) values('+q(uid(20))+','+q(self.job_b)+",'V2-PG-SPECIFIC');COMMIT;";self.r.run(sql)
        self.times=self.r.json("select jsonb_build_object('clock',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '10 minutes'+interval '0.123456 seconds'),'finish',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '9 minutes'+interval '0.123456 seconds'),'a',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '8 minutes'+interval '0.123456 seconds'),'b',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '7 minutes'+interval '0.123456 seconds'),'break',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '6 minutes'+interval '0.123456 seconds'),'return',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '5 minutes'+interval '0.123456 seconds'),'out',_work_activity_iso(date_trunc('second',clock_timestamp())-interval '4 minutes'+interval '0.123456 seconds'),'checked',_work_activity_iso(clock_timestamp()))")
        self.report.value['syntheticTimes']=self.times;self.report.persist()
        for actor in [uid(1),uid(2),uid(4),uid(5)]:
            row=self.rpc(actor,'to_jsonb(public.sign_toolbox_talk('+q(self.new_id())+'::uuid,'+q(actor)+"::uuid,null::uuid,'Synthetic fixture signature',null::text,null::text,'Disposable fixture only',clock_timestamp()))")
            self.check(row['profile_id']==actor,'Supported public toolbox signing by own installer actor')
        self.definitions={}
        for scope in ('general','specific'):
            code='v2_pg_'+scope
            call='public.work_publish_activity_version('+q(self.new_id())+'::uuid,'+q(code)+',0,'+q(scope)+",'V2 fixture','V2 fixture',false,'[]'::jsonb)"
            self.rpc(self.owner,call)
            self.definitions[scope]=self.r.json('select to_jsonb(v) from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='+q(code))
        denied='select public.work_publish_activity_version('+q(self.new_id())+"::uuid,'v2_worker_forbidden',0,'general','Forbidden','Forbidden',false,'[]'::jsonb);"
        before=self.r.run('select count(*) from work_activity_definitions')
        self.auth(uid(1),denied,error='42501',message='Only an owner may publish company configuration.')
        self.check(self.r.run('select count(*) from work_activity_definitions')==before,'Installer cannot publish owner configuration')
        items=[{'definitionId':d['definition_id'],'versionId':d['id'],'position':i,'enabled':True} for i,d in enumerate(self.definitions.values())]
        self.rpc(self.owner,'public.work_publish_menu_version('+q(self.new_id())+"::uuid,'v2_pg_menu',0,'V2 fixture','V2 fixture',"+q(encoded(items))+'::jsonb)')
        self.menu=self.r.run("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='v2_pg_menu'")
        self.selections={}
        for project in (self.job_a,self.job_b):
            self.rpc(self.owner,'public.work_select_job_menu('+q(self.new_id())+'::uuid,'+q(project)+'::uuid,'+q(self.menu)+'::uuid,0)')
            self.selections[project]=self.r.json('select to_jsonb(s) from work_job_menu_selections s where project_id='+q(project)+'::uuid')
        unit_payload={'id':uid(30),'revision':0,'project_id':self.job_b,'opening_id':uid(20),'label':'Synthetic v2 unit','type_label':'Window','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
        self.check(self.rpc(self.owner,'to_jsonb(public.custom_work_command('+q(self.new_id())+"::uuid,'unit',"+q(encoded(unit_payload))+'::jsonb))')==uid(30),'Supported owner unit constructor with independent fact evidence')
    def fallback_cases(self):
        self.check(self.r.run('select not capture_enabled from work_activity_authority_generation where singleton')=='t','Private gate active but capture state deliberately false for original2 fallback')
        fallback_key,old_key=uid(200),uid(201)
        first=self.rpc(uid(4),self.clock_sql(fallback_key,2,self.times['clock']))
        old=self.rpc(uid(5),self.clock_sql(old_key,1,self.times['clock']))
        self.check(self.request_proof(fallback_key)=={'version':2,'registered':False,'fingerprintMatches':True},'Original requested2 fallback retains version2 without registration')
        self.check(self.request_proof(old_key)=={'version':1,'registered':False,'fingerprintMatches':True},'Distinct original1 key remains version1')
        self.r.run('BEGIN;SELECT public._work_activity_gate();UPDATE public.work_activity_authority_generation SET capture_enabled=true,revision=revision+1;COMMIT;')
        before=self.rows();fallback_receipt=self.retained(fallback_key)
        replay=self.rpc(uid(4),self.clock_sql(fallback_key,2,self.times['clock']),zone='America/Denver')
        self.check(self.compare_paid_wire(first,replay) and self.retained(fallback_key)==fallback_receipt and self.rows()==before and self.request_proof(fallback_key)['registered'] is False,'Original2 capture-disabled fallback never registers on identical retry after capture enable')
        self.auth(uid(5),'select '+self.clock_sql(old_key,2,self.times['clock'])+';',error='23514',message='Clock command identity conflicts.')
        self.check(self.rows()==before and self.request_proof(old_key)['version']==1,'Original non2 key cannot become2 and changes no measured business row')
        # Scope refusal can append private observations before returning; record
        # their delta separately rather than claiming a completely read-only RPC.
        require_snapshot_state(before,uid(4));observation_before=self.observations();snap=self.rpc(uid(4),'public.work_cross_job_snapshot('+q(uid(202))+'::uuid)')
        self.check(snap=={'protocolVersion':2,'availability':'unavailable','state':None} and self.rows()==before,'Unregistered original2 fallback receives exact v2 scope refusal without business mutation')
        self.report.value['cases'].append({'case':'fallback_scope_refusal','observationsBefore':observation_before,'observationsAfter':self.observations(),'originalPaidRow':first,'original1PaidRow':old});self.report.persist()
        legacy_device=uid(203);legacy=self.rpc(uid(5),'public.work_activity_snapshot('+q(legacy_device)+'::uuid)')
        p={'deviceId':legacy_device,'clientGeneration':uid(204),'clientSequence':0,'predecessorCommandId':None,'expectedRevision':legacy['state']['revision'],'basis':{'observationId':legacy['observation']['id']},'shiftRef':legacy['observation']['shiftRef'],'tappedAt':self.times['finish'],'clockCheckedAt':self.times['checked'],'clockSkewMs':0,'intent':{'kind':'establish_stream','previousGeneration':None,'previousHeadCommandId':None},'expectedAllocationId':None,'boundaryMode':'trusted_original_tap'}
        before=self.rows();reply=self.rpc(uid(5),'public.work_activity_command('+q(self.new_id())+'::uuid,2,'+q(encoded(p))+'::jsonb)')
        self.check(reply=={'protocolVersion':2,'availability':'unavailable','receipt':None} and self.rows()==before,'Unregistered original1 shift refuses version2 command without measured business mutation')
        self.guards(False)
    def activity(self,actor,shift,device,generation,head,sequence,intent,tap):
        snap=self.rpc(actor,'public.work_cross_job_snapshot('+q(device)+'::uuid)')
        exact(snap,('protocolVersion','asOf','deviceId','capability','observation','stream','state'),'v2 snapshot')
        require(snap['protocolVersion']==2 and snap['state']['shift']['id']==shift and snap['capability']['mode']=='active','Live registered v2 snapshot unavailable')
        payload={'deviceId':device,'clientGeneration':generation,'clientSequence':sequence,'predecessorCommandId':head,'expectedRevision':snap['state']['revision'],'basis':{'observationId':snap['observation']['id']},'shiftRef':snap['observation']['shiftRef'],'tappedAt':tap,'clockCheckedAt':self.times['checked'],'clockSkewMs':0,'intent':intent,'expectedAllocationId':snap['state']['shift']['allocationId'],'boundaryMode':'trusted_original_tap'}
        validate_payload(payload);command_id=self.new_id();paid_before=self.paid(shift)
        response=self.rpc(actor,'public.work_activity_command('+q(command_id)+'::uuid,2,'+q(encoded(payload))+'::jsonb)')
        lookup=self.rpc(actor,'public.work_cross_job_receipt('+q(command_id)+'::uuid)')
        expected='noop' if intent['kind']=='establish_stream' else 'applied'
        validate_wire(command_id,payload,response,lookup,expected)
        self.check(self.paid(shift)==paid_before,'Activity '+intent['kind']+' preserves whole paid row, tuple identity and paid action/receipt counts')
        before=self.rows();replay=self.rpc(actor,'public.work_activity_command('+q(command_id)+'::uuid,2,'+q(encoded(payload))+'::jsonb)',zone='America/Denver')
        self.check(replay==response and self.rows()==before,'Exact activity request retry preserves immutable receipt and measured business state')
        case={'case':intent['kind'],'actor':actor,'commandId':command_id,'payload':payload,'commandResponse':response,'lookup':lookup,'paidBefore':paid_before,'paidAfter':self.paid(shift)}
        self.report.value['cases'].append(case);self.report.persist();return command_id,payload,response
    def switch_intent(self,project,scope,basis=None):
        selection=self.selections[project]
        return {'kind':'switch','projectId':project,'selectionId':selection['id'],'selectionRevision':selection['revision'],'menuVersionId':self.menu,'definitionVersionId':self.definitions[scope]['id'],'scope':scope,'unit':basis,'machineKind':None,'values':{}}
    def active_case(self,actor,scope):
        key=self.new_id();first=self.rpc(actor,self.clock_sql(key,2,self.times['clock']));shift=first['id'];device=self.new_id();generation=self.new_id()
        self.check(first['profile_id']==actor and first['project_id']==self.job_a and first['cost_code_id']==self.cost and self.request_proof(key)=={'version':2,'registered':True,'fingerprintMatches':True},'Fresh '+scope+' original clock2 creates one registered physical A row')
        self.guards(True);receipt=self.retained(key);paid=self.paid(shift);before=self.rows()
        for zone in ('America/Denver','UTC'):
            replay=self.rpc(actor,self.clock_sql(key,2,self.times['clock']),zone=zone)
            self.check(self.compare_paid_wire(first,replay) and self.retained(key)==receipt and self.paid(shift)==paid and self.rows()==before,scope+' exact original clock2 retry retains all15 receipt fields/version/microseconds in '+zone)
        self.auth(actor,'select '+self.clock_sql(key,2,self.times['clock'])+';',digits=-15,error='23514',message='Clock command identity conflicts.')
        self.check(self.rows()==before and self.retained(key)==receipt,'Version2 changed extra_float_digits refuses without rewriting original receipt')
        fingerprint=self.r.run('select _work_cross_job_clock_receipt_fingerprint(r) from work_activity_clock_receipts r where client_id='+q(key)+'::uuid')
        changed=self.r.run("select _work_cross_job_clock_receipt_fingerprint(jsonb_populate_record(r,jsonb_build_object('arrived_at',r.arrived_at+interval '1 microsecond'))) from work_activity_clock_receipts r where client_id="+q(key)+'::uuid')
        self.check(fingerprint!=changed and self.rows()==before,'Read-only version2 fingerprint composite distinguishes adjacent microseconds; no corruption bypass')
        public_receipt=self.rpc(actor,'public.work_activity_clock_receipt('+q(key)+'::uuid)')
        self.check(public_receipt=={'protocolVersion':1,'availability':'unavailable','receipt':None},'Registered2 does not masquerade as public version1 paid receipt; version2 reader remains absent')
        # Literal protocol mismatch is refused before command persistence.
        head,payload,_=self.activity(actor,shift,device,generation,None,0,{'kind':'establish_stream','previousGeneration':None,'previousHeadCommandId':None},self.times['finish'])
        before=self.rows();refused=self.rpc(actor,'public.work_activity_command('+q(self.new_id())+'::uuid,1,'+q(encoded({k:v for k,v in payload.items() if k not in ('expectedAllocationId','boundaryMode')}))+'::jsonb)')
        self.check(refused=={'protocolVersion':1,'availability':'unavailable','receipt':None} and self.rows()==before,'Registered2 version1 command unavailable with no measured business write')
        require_snapshot_state(before,actor);obs_before=self.observations();old_snapshot=self.rpc(actor,'public.work_activity_snapshot('+q(device)+'::uuid)')
        self.check(old_snapshot['protocolVersion']==1 and old_snapshot['capability']=={'mode':'unavailable','reasonCode':'not_ready'} and all(old_snapshot[k] is None for k in ('observation','stream','state')) and self.rows()==before,'Registered2 version1 snapshot hides source and changes no measured business row')
        self.report.value['cases'].append({'case':'registered2_v1_snapshot_refusal','observationsBefore':obs_before,'observationsAfter':self.observations()});self.report.persist()
        head,_,_=self.activity(actor,shift,device,generation,head,1,{'kind':'finish_setup','projectId':self.job_a,'costCodeId':self.cost},self.times['finish'])
        head,_,_=self.activity(actor,shift,device,generation,head,2,self.switch_intent(self.job_a,'general'),self.times['a'])
        basis=None
        if scope=='specific':
            view=self.rpc(actor,'public.work_activity_unit_basis('+q(uid(30))+'::uuid)')['unit'];require(view['eligibleForCapture'] and view['projectId']==self.job_b,'Specific basis unavailable')
            basis={k:view[k] for k in ('id','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch')};basis.update({'factId':view['fact']['id'],'factRevision':view['fact']['revision'],'originProjectEpoch':view['fact']['originProjectEpoch'],'originOpeningEpoch':view['fact']['originOpeningEpoch']})
        head,_,_=self.activity(actor,shift,device,generation,head,3,self.switch_intent(self.job_b,scope,basis),self.times['b'])
        self.check(self.paid(shift)==paid,'Finish A and A→B allocations preserve complete original physical A paid evidence')
        current=self.r.json("select jsonb_build_object('project',s.project_id,'metadataProject',m.project_id,'bindingProject',b.project_id,'scope',m.scope,'protocol',t.protocol_version,'unit',m.unit_id) from personal_activity_state p join custom_work_sessions s on s.id=p.active_source_id join work_session_capture_metadata m on m.session_id=s.id join work_cross_job_bindings b on b.source_id=s.id join personal_activity_transitions t on t.id=p.last_transition_id where p.profile_id="+q(actor)+'::uuid')
        self.check(current=={'project':self.job_b,'metadataProject':self.job_b,'bindingProject':self.job_b,'scope':scope,'protocol':2,'unit':uid(30) if scope=='specific' else None},'Actual '+scope+' B source/metadata/binding agree while physical A remains')
        started=self.rpc(actor,'to_jsonb(public.start_break('+q(shift)+"::uuid,'rest'::text,"+q(self.new_id())+'::uuid,'+q(self.times['break'])+'::timestamptz,'+q(self.times['checked'])+'::timestamptz,0))')
        validate_paid_response('start_break',started,first,self.times)
        self.check(True,scope+' actual start_break row preserves physical A and exact original break tap')
        returned=self.rpc(actor,'to_jsonb(public.end_break('+q(shift)+'::uuid,'+q(self.new_id())+'::uuid,'+q(self.times['return'])+'::timestamptz,'+q(self.times['checked'])+'::timestamptz,0))')
        returned_shift=validate_paid_response('end_break',returned,first,self.times)
        resumed=self.r.json("select jsonb_build_object('activeKind',p.active_source_kind,'choice',p.choice_required,'project',s.project_id,'physical',h.project_id,'origin',h.clock_in_at,'resumed',b.resumed_from_history_id is not null) from personal_activity_state p join custom_work_sessions s on s.id=p.active_source_id join time_shifts h on h.id=p.shift_id join work_cross_job_bindings b on b.source_id=s.id where p.profile_id="+q(actor)+'::uuid')
        self.check(resumed['activeKind']=='custom' and not resumed['choice'] and resumed['project']==self.job_b and resumed['physical']==self.job_a and resumed['resumed'] and returned_shift['id']==shift and instant(resumed['origin'])==instant(first['clock_in_at']),scope+' actual paid break/return resumes B on one physical A shift')
        out=self.rpc(actor,'to_jsonb(public.clock_out('+q(shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,'+q(self.new_id())+'::uuid,'+q(self.times['out'])+'::timestamptz,'+q(self.times['checked'])+'::timestamptz,0))')
        validate_paid_response('clock_out',out,first,self.times)
        counts=self.r.json("select jsonb_build_object('physicalRows',(select count(*) from time_shifts where profile_id="+q(actor)+"::uuid),'allocations',(select count(*) from work_cross_job_allocations where profile_id="+q(actor)+"::uuid),'boundaries',jsonb_build_object('out',_work_activity_iso(clock_out_at),'punch',_work_activity_iso(last_punch_at)),'sourceReview',(select bool_or(review_required) from custom_work_sessions where shift_id=h.id)) from time_shifts h where id="+q(shift)+'::uuid')
        self.check(out['id']==shift and out['project_id']==self.job_a and out['cost_code_id']==self.cost and out['clock_in_at']==first['clock_in_at'] and counts=={'physicalRows':1,'allocations':3,'boundaries':{'out':self.times['out'],'punch':self.times['out']},'sourceReview':False},scope+' actual paid clock-out keeps physical A/time/code with three exact allocations and no normal source review')
        self.report.value['cases'].append({'case':scope+'_paid_lifecycle','originalPaidRow':first,'originalRetainedReceipt':receipt,'resumed':resumed,'startedPaidRow':started,'endBreakResponse':returned,'returnedPaidRow':returned_shift,'clockOutRow':out,'finalCounts':counts});self.report.persist()
    def census(self):
        return self.r.json("select jsonb_build_object('allPaidRows',(select count(*) from time_shifts),'allPaidActions',(select count(*) from time_clock_actions),'allRetainedPaidReceipts',(select count(*) from work_activity_clock_receipts),'allRegistered2',(select count(*) from work_cross_job_shifts),'allAllocations',(select count(*) from work_cross_job_allocations),'allSourceHistory',(select count(*) from work_activity_source_history),'paidUpdateStatsInformational',(select n_tup_upd from pg_stat_all_tables where relid='public.time_shifts'::regclass))")
    def run(self):
        primary=None
        try:
            self.predecessors()
            self.report.value['baselineCensus']=self.census();self.report.persist()
            self.enroll();self.seed();self.fallback_cases()
            self.active_case(uid(1),'general');self.active_case(uid(2),'specific')
            self.catalog_equal(self.active,'Final exact authored active catalog; no hidden fixture DDL');self.guards(True)
            same_instance(self.report.value['instance'],self.instance())
            self.report.value['finalCensus']=self.census();self.report.persist('scenarios_complete_before_restoration')
        except BaseException as error:
            primary=error
            self.report.value.update(status='failed',v2SuccessProof=False,primaryFailure=error_evidence(error))
            self.report.persist('primary_failure_before_restoration')
        finally:
            try:self.restore()
            except BaseException as error:
                self.report.value.update(status='failed',v2SuccessProof=False,restorationFailure=error_evidence(error))
                self.report.persist('restoration_failed')
                if primary is None:raise
        if primary is not None:raise primary.with_traceback(primary.__traceback__)
        self.report.value.update(status='passed',v2SuccessProof=True)
        self.report.persist('complete_first_finite_v2_fixture')


def validate_payload(payload):
    exact(payload,('deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent','expectedAllocationId','boundaryMode'),'v2 payload')
    require(payload['boundaryMode']=='trusted_original_tap' and payload['clockSkewMs']==0,'This finite fixture uses only synthetic trusted zero-skew originals')
    require(all(type(payload[k]) is int and 0<=payload[k]<=9007199254740991 for k in ('clientSequence','expectedRevision','clockSkewMs')),'Unsafe fixture numeric envelope')
    for name in ('tappedAt','clockCheckedAt'):
        require(isinstance(payload[name],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z',payload[name]),'Exact microsecond fixture timestamp required')
        datetime.fromisoformat(payload[name][:-1]+'+00:00')
    uuid_pattern=r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
    for name in ('deviceId','clientGeneration','predecessorCommandId','expectedAllocationId'):
        value=payload[name]
        require((value is None and name in ('predecessorCommandId','expectedAllocationId')) or isinstance(value,str) and re.fullmatch(uuid_pattern,value),'Invalid fixture identity')
    require((payload['clientSequence']==0)==(payload['predecessorCommandId'] is None),'Wrong causal predecessor shape')
    exact(payload['basis'],('observationId',),'observation basis');exact(payload['shiftRef'],('kind','id'),'physical shift')
    require(payload['shiftRef']['kind']=='shift' and re.fullmatch(uuid_pattern,payload['shiftRef']['id']) and re.fullmatch(uuid_pattern,payload['basis']['observationId']),'Actual registered physical reference required')
    intent=payload['intent'];kind=intent.get('kind') if isinstance(intent,dict) else None
    shapes={'establish_stream':('kind','previousGeneration','previousHeadCommandId'),'finish_setup':('kind','projectId','costCodeId'),'switch':('kind','projectId','selectionId','selectionRevision','menuVersionId','definitionVersionId','scope','unit','machineKind','values')}
    require(kind in shapes,'Unsupported first-stage intent');exact(intent,shapes[kind],'intent')
    if kind=='establish_stream':require(payload['clientSequence']==0,'Establishment sequence must be zero')
    else:require(payload['clientSequence']>0 and re.fullmatch(uuid_pattern,intent['projectId']),'Activity sequence or project invalid')
    if kind=='switch':
        require(intent['scope'] in ('general','specific') and (intent['scope']=='general')==(intent['unit'] is None) and intent['machineKind'] is None and intent['values']=={},'Finite fixture switch scope shape mismatch')
        if intent['unit'] is not None:exact(intent['unit'],('id','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch','factId','factRevision','originProjectEpoch','originOpeningEpoch'),'specific unit basis')


def validate_wire(command_id,payload,response,lookup,status):
    validate_payload(payload);require(status in ('applied','noop'),'Invalid expected status')
    exact(response,('protocolVersion','availability','receipt'),'command response')
    exact(lookup,('protocolVersion','availability','receipt','allocation'),'lookup response')
    require(response['protocolVersion']==lookup['protocolVersion']==2 and response['availability']==lookup['availability']=='available','Expected actual available version2 responses')
    r=response['receipt'];exact(r,('protocolVersion','commandId','status','reasonCode','beforeRevision','afterRevision','transitionId','effectiveAt'),'activity receipt')
    require(r==lookup['receipt'] and r['protocolVersion']==2 and r['commandId']==command_id and r['status']==status and r['reasonCode'] is None,'Receipt identity/status mismatch')
    require(all(type(r[k]) is int and 0<=r[k]<=9007199254740991 for k in ('beforeRevision','afterRevision')),'Unsafe receipt revisions')
    require(r['beforeRevision']==payload['expectedRevision'] and r['afterRevision']==payload['expectedRevision']+(status=='applied'),'Receipt revision arithmetic mismatch')
    creates=payload['intent']['kind'] in ('switch','finish_setup')
    if creates:
        a=lookup['allocation'];exact(a,('id','predecessorId','boundaryMode','originalTappedAt','effectiveAt','shiftId','transitionId'),'allocation')
        require(a=={'id':command_id,'predecessorId':payload['expectedAllocationId'],'boundaryMode':'trusted_original_tap','originalTappedAt':payload['tappedAt'],'effectiveAt':payload['tappedAt'],'shiftId':payload['shiftRef']['id'],'transitionId':r['transitionId']},'Exact original allocation boundary mismatch')
    else:require(lookup['allocation'] is None,'Noncreating command must not invent allocation')
    if status=='noop':require(r['transitionId'] is None and r['effectiveAt'] is None,'Noop invented a transition')
    else:require(isinstance(r['transitionId'],str) and re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}',r['transitionId']) and r['effectiveAt']==payload['tappedAt'],'Applied receipt does not preserve synthetic trusted original tap')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check-plan',action='store_true');parser.add_argument('--execute-fixture',action='store_true');parser.add_argument('--output');args=parser.parse_args(argv)
    require(not(args.check_plan and args.execute_fixture),'Choose plan or explicit fixture execution')
    if not args.execute_fixture:
        require(args.output is None,'Plan mode never creates runtime evidence');profile,_,_=validate_source()
        print(json.dumps({'status':'PLAN VALIDATED','databaseContacted':False,'fixtureExecuted':False,'productionActivation':False,'v2SuccessProof':False,'sourceSha256':profile['sourcePins'][CANDIDATE],'scope':'Source-only first finite active v2 harness; exact47+66 predecessors executed only by explicit fixture mode','predecessorStart':'unchanged0846 installed,0847 absent','remainingOpen':profile['remainingOpen']}));return 0
    require(args.output,'Explicit new output path required')
    report=Report(args.output)  # Durable initial partial BEFORE source/URL checks.
    try:
        profile,inert,active=validate_source();report.value['sourceValidated']=True;report.value['sourceSha256']=profile['sourcePins'][CANDIDATE];report.persist('validating_target')
        target=validate_target(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
        Fixture(Runner(target,report),report,profile,inert,active).run();return 0
    except BaseException as error:
        report.value.update(status='failed',v2SuccessProof=False,failure=error_evidence(error));report.persist('failed');raise


if __name__=='__main__':
    raise SystemExit(main())
