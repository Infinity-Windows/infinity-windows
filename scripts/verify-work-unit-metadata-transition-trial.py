#!/usr/bin/env python3
"""Source-only by default; explicit limited PG17 owner-helper characterization.

This is not a port of original184/168/all18 parity, authenticated public-entry
proof, internal PL/pgSQL plan observation, or ACTIVE paid performance.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
PROFILE = 'scripts/work-unit-metadata-transition-trial-profile.json'
PROFILE_SHA = '79e58b251b0d9c953eaecad7231810109c64a43a6d3d7ac06d1f20c802e7e535'
INPUTS = 'scripts/fixtures/metadata-transition-trial/'
SOURCE = 'supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql'
MAIN = 'scripts/verify-work-unit-metadata-cohorts-postgres.py'
DATABASE = 'forge_work_activity_role_test'
NAME = 'work-unit-metadata-transition-trial.json'
OWNER = 'postgres'
KINDS = {'custom_work_sessions':'custom','unit_sessions':'unit','task_sessions':'task','service_time_sessions':'service','opening_phases':'phase','summon_helpers':'helper'}
UUID = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
GUARDS = ('_work_unit_metadata_coverage','_work_unit_review_coverage','_work_totals_coverage','_work_unit_contributors_coverage')
INSTANCE_SQL = "select jsonb_build_object('systemIdentifier',(select system_identifier::text from pg_control_system()),'postmasterStart',extract(epoch from pg_postmaster_start_time())::text,'databaseOid',(select oid::text from pg_database where datname=current_database()),'database',current_database(),'serverVersionNum',current_setting('server_version_num'))"
IDENTITY_SQL = "select jsonb_build_object('pid',pg_backend_pid(),'backendStart',(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()),'sessionUser',session_user,'currentUser',current_user,'superuser',(select rolsuper from pg_roles where rolname=current_user),'database',current_database(),'databaseOid',(select oid::text from pg_database where datname=current_database()),'postmasterStart',extract(epoch from pg_postmaster_start_time())::text,'serverVersionNum',current_setting('server_version_num'),'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'),'isolation',current_setting('transaction_isolation'),'planCacheMode',current_setting('plan_cache_mode'),'standardConformingStrings',current_setting('standard_conforming_strings'),'actor',auth.uid())"
CENSUS_SQL = "select jsonb_build_object('history',(select count(*) from work_activity_source_history),'transitions',(select count(*) from personal_activity_transition_sources),'units',(select count(*) from custom_work_units),'paidRows',(select count(*) from time_shifts),'paidActions',(select count(*) from time_clock_actions),'paidReceipts',(select count(*) from work_activity_clock_receipts),'metadataRevisions',(select count(*) from _work_unit_metadata_revisions),'reviewEvents',(select count(*) from work_unit_review_events),'captureEnabled',(select capture_enabled from work_activity_authority_generation where singleton))"


def require(value,message):
    if not value:raise RuntimeError(message)


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def digest(text):return hashlib.sha256(text.encode()).hexdigest()
def lit(value):return 'null' if value is None else "'"+str(value).replace("'","''")+"'"
def encoded(value):return json.dumps(value,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def ident(n):return '00000000-0000-4000-8000-'+str(650000+n).zfill(12)
def json_literal(value):return lit(encoded(value))+'::jsonb'
def error_info(error):return {'type':type(error).__name__,'message':str(error)[-2500:]}


def extract(source,name,args,tag='$$',replace=False):
    pattern=r'create '+('or replace ' if replace else '')+r'function public\.'+re.escape(name)+r'\('+re.escape(args)+r'\).*?as '+re.escape(tag)+r'(.*?)'+re.escape(tag)+';'
    found=re.findall(pattern,source,re.S)
    require(len(found)==1,'Unique authored function extraction required: '+name)
    return found[0]


def validate_source(root=ROOT):
    require(sha(root/PROFILE)==PROFILE_SHA,'Authored trial profile drift')
    p=json.loads((root/PROFILE).read_text())
    for name,h in p['sourcePins'].items():require(sha(root/name)==h,'Pinned trial input changed: '+name)
    source=(root/SOURCE).read_text();require(re.search(r'rollback;\s*$',source,re.I),'Terminal source ROLLBACK required')
    bodies={name:(root/INPUTS/name).read_text() for name in ('old-scope-body.sql','candidate-scope-body.sql','members-body.sql','coverage-body.sql','old-transition-block.sql','candidate-transition-block.sql')}
    require(extract(source,'_work_unit_metadata_scope','actor uuid,unit_id uuid,p_sourceids jsonb')==bodies['old-scope-body.sql'],'Old scope extraction changed')
    require(extract(source,'_work_unit_metadata_members','p_units uuid[]')==bodies['members-body.sql'],'Members extraction changed')
    require(extract(source,'_work_unit_metadata_coverage','',tag='$coverage$',replace=True)==bodies['coverage-body.sql'],'Coverage extraction changed')
    old=bodies['old-transition-block.sql'].removesuffix('\n');new=bodies['candidate-transition-block.sql'].removesuffix('\n')
    require(bodies['old-scope-body.sql'].count(old)==1 and bodies['candidate-scope-body.sql'].count(new)==1 and bodies['candidate-scope-body.sql'].replace(new,old,1)==bodies['old-scope-body.sql'],'Only approved transition block may differ')
    require(p['candidateBodySha256']=='9f39e62075a8e002c438c0fd2e80ca7b0a8cb7eca45b221d3f59d1088814c34a' and p['warmupsPerVariant']==6 and p['pairedMeasurementsPerCase']==20,'Reviewed candidate/protocol changed')
    return p,bodies


def validate_url(value):
    try:p=urlparse(value);port=p.port
    except ValueError as e:raise RuntimeError('Invalid fixture URL') from e
    require(p.scheme in ('postgres','postgresql') and p.hostname in ('localhost','127.0.0.1') and port==5432 and p.path=='/'+DATABASE and p.username=='supabase_admin' and p.password=='fixture-only' and not p.query and not p.fragment and not p.params,'Exact explicit localhost:5432 supabase_admin:fixture-only fixture URL required')
    return p


def validate_predecessor(receipt,profile):
    require(receipt.get('status')=='passed' and receipt.get('stage')=='complete' and receipt.get('checks')==92,'Exact completed main92 predecessor required')
    require(receipt.get('sourceSha256')==profile['sourceSha256'] and receipt.get('harnessSha256')==profile['mainHarnessSha256'],'Predecessor source/harness mismatch')
    require(receipt.get('plan',{}).get('timeoutsSeconds')=={'statement':20,'lock':12},'Predecessor timeout mismatch')
    tiers=receipt.get('tiers',[])
    require(len(tiers)==9 and {(t.get('additionalUnrelatedRows'),t.get('currentUnits')) for t in tiers}=={(n,u) for n in (0,1000,10000) for u in (1,10,100)},'Nine exact predecessor tiers required')
    for t in tiers:
        samples=t.get('samplesMs',[])
        require(len(samples)==20 and all(type(n) in (int,float) and math.isfinite(n) and n>=0 for n in samples),'Twenty finite samples required per predecessor tier')
    require(any(w.get('case')=='active_batch_payroll' and w.get('observed') is True and w.get('holderWasActive') is True and w.get('controlledIdleHold') is False and w.get('stage')=='reader_and_payroll_completed' for w in receipt.get('waits',[])),'Completed observed predecessor paid edge required; no budget acceptance inferred')


def validate_instance(instance):
    require(isinstance(instance,dict) and set(instance)=={'systemIdentifier','postmasterStart','databaseOid','database','serverVersionNum'} and all(isinstance(v,str) and v for v in instance.values()),'Complete database instance identity required')
    require(instance['database']==DATABASE and instance['serverVersionNum'].isdigit() and int(instance['serverVersionNum'])//10000==17,'Instance must be fixture PG17')
    return instance


def run_predecessor(target,report,profile,admin,launch=subprocess.Popen):
    instance=validate_instance(admin.json(INSTANCE_SQL,'instance_before_main'))
    report.data['instanceBeforePredecessor']=instance;report.persist('before_main_admission')
    require(admin.json("select to_jsonb(to_regclass('public._work_unit_metadata_contract') is null and to_regprocedure('public._work_unit_metadata_scope(uuid,uuid,jsonb)') is null)",'main_not_preinstalled') is True,'Start after0846 with0848 absent; existing main owns its exact installation')
    path=report.path.parent/'main-predecessor.json';require(not path.exists(),'Fresh predecessor output required')
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env.update(PGCONNECT_TIMEOUT='3',WORK_ACTIVITY_ROLE_TEST_DB_URL=urlunparse(target),WORK_UNIT_METADATA_COHORTS_PG_OUT=str(path))
    deadline=time.monotonic()+1200;process=None;primary=None
    with (report.path.parent/'main-predecessor.stdout').open('x') as out,(report.path.parent/'main-predecessor.stderr').open('x') as err:
        report.persist('before_owned_main_process')
        try:
            process=launch([sys.executable,str(ROOT/MAIN)],cwd=ROOT,env=env,stdout=out,stderr=err,text=True)
            while True:
                report.data['predecessorWait']={'remainingSeconds':max(0,round(deadline-time.monotonic(),2))};report.persist('waiting_owned_main')
                try:
                    code=process.wait(timeout=min(5,max(.001,deadline-time.monotonic())))
                    require(code==0,'Owned source-matched main predecessor failed');break
                except subprocess.TimeoutExpired:require(time.monotonic()<deadline,'Owned predecessor exceeded finite1200-second process limit')
        except BaseException as error:
            primary=error;report.data['predecessorPrimaryFailure']=error_info(error);report.persist('predecessor_failed_before_cleanup')
        finally:
            try:
                if process is not None and process.poll() is None:
                    process.kill();report.persist('waiting_predecessor_cleanup');process.wait(timeout=5)
            except BaseException as error:
                report.data['predecessorCleanupFailure']=error_info(error);report.persist('predecessor_cleanup_failed')
                if primary is None:primary=error
    if primary is not None:raise primary.with_traceback(primary.__traceback__)
    receipt=json.loads(path.read_text());validate_predecessor(receipt,profile)
    after=validate_instance(admin.json(INSTANCE_SQL,'instance_after_main'));require(after==instance,'Database instance changed during owned predecessor')
    report.data['predecessor']={'path':str(path),'sha256':sha(path),'sourceSha256':profile['sourceSha256'],'mainHarnessSha256':profile['mainHarnessSha256'],'instanceBefore':instance,'instanceAfter':after,'budgetAcceptance':False}
    report.persist('owned_predecessor_source_and_instance_matched');return instance


def keys(members):
    # Offline classification only; PG executes the actual authored SQL guards.
    return sorted({(KINDS[x['kind']],x['id']) for x in members if isinstance(x,dict) and x.get('kind') in KINDS and isinstance(x.get('id'),str) and re.fullmatch(UUID,x['id'])})


def selector_sql(bodies,variant):
    block=bodies[variant+'-transition-block.sql']
    if variant=='candidate':block=block[block.index(' with selected as materialized'):block.index("\n else normal_sources")]
    require(block.count('into normal_sources')==1,'Exact authored selector assignment required')
    return re.sub(r'\bsourceids\b','$1',block.replace(' into normal_sources','')).strip().removesuffix(';')


def metadata_sql(name,args):
    return "select jsonb_build_object('owner',pg_get_userbyid(p.proowner),'body',p.prosrc,'language',l.lanname,'definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,'acl',p.proacl::text,'kind',p.prokind,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'returns',p.prorettype::regtype::text,'setReturning',p.proretset,'args',pg_get_function_identity_arguments(p.oid),'defaults',p.pronargdefaults,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::oid::bigint,'binary',p.probin) from pg_proc p join pg_language l on l.oid=p.prolang where p.oid="+lit('public.'+name+'('+args+')')+'::regprocedure'


def expected_metadata(name,body):
    scope=name=='_work_unit_metadata_scope';members=name=='_work_unit_metadata_members'
    return {'owner':OWNER,'body':body,'language':'plpgsql' if scope else 'sql','definer':True,'volatility':'v' if scope else 's','config':['search_path=public, pg_temp'],'acl':'{postgres=X/postgres}','kind':'f','strict':False,'leakproof':False,'parallel':'u','returns':'boolean' if not(scope or members) else 'jsonb','setReturning':False,'args':'actor uuid, unit_id uuid, p_sourceids jsonb' if scope else ('p_units uuid[]' if members else ''),'defaults':0,'cost':100,'rows':0,'support':0,'binary':None}


class Report:
    def __init__(self,path):
        self.path=Path(path)
        require(self.path.is_absolute() and self.path.name==NAME and ROOT not in self.path.resolve().parents and not self.path.parent.exists(),'Unused absolute trial output directory outside checkout required')
        self.path.parent.mkdir(parents=True,exist_ok=False)
        self.data={'status':'running','stage':'initial_before_validation','databaseContacted':False,'fixtureExecuted':False,'productionActivation':False,'authenticatedPublicProof':False,'fullPG17Review184':False,'fullPG17Membership168':False,'all18Categories':False,'paidBudgetAccepted':False,'internalPLpgSQLPlanObserved':False,'calls':[],'checks':[],'cases':[],'plans':[],'memberships':[],'cleanup':{},'scriptSha256':sha(__file__)}
        self.persist()
    def persist(self,stage=None):
        if stage:self.data['stage']=stage
        temp=self.path.with_suffix('.tmp');temp.write_text(json.dumps(self.data,indent=2)+'\n');temp.replace(self.path)
    def check(self,condition,label):
        require(condition,label);self.data['checks'].append(label);self.persist()
    def artifact(self,name,value):
        path=self.path.parent/name;require(not path.exists(),'Never overwrite trial evidence')
        path.write_text(json.dumps(value,indent=2)+'\n');return {'path':str(path),'sha256':sha(path)}


class Session:
    """One persistent psql backend; bounded calls, flushed evidence before waits."""
    def __init__(self,target,report,user=OWNER,launch=subprocess.Popen):
        self.report=report;self.user=user;self.sequence=0;self.closed=False
        uri=urlunparse((target.scheme,f'{user}:fixture-only@{target.hostname}:5432',target.path,'','',''))
        env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
        self.out_path=report.path.parent/(user+'-session.stdout');self.err_path=report.path.parent/(user+'-session.stderr')
        # Popen inherits the writer's open-file description. Never seek/read that
        # handle (or os.dup it): doing so changes the child's output position.
        # A separately opened binary reader has its own byte cursor, while the
        # original files retain every child byte for incomplete-run evidence.
        self.out=self.out_path.open('x');self.reader=None;self.err=None;self.offset=0
        try:
            self.reader=self.out_path.open('rb');self.err=self.err_path.open('x')
            report.data['databaseContacted']=True;report.persist('before_'+user+'_connection')
            self.proc=launch(['psql',uri,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=self.out,stderr=self.err,text=True,env=env)
        except BaseException:
            for handle in (self.reader,self.out,self.err):
                if handle is not None:handle.close()
            raise
    def query(self,sql,label):
        require(not self.closed,'Session already closed');self.sequence+=1;marker='trial_done_'+str(self.sequence)
        call={'session':self.user,'sequence':self.sequence,'label':label,'sqlSha256':digest(sql),'status':'waiting'}
        self.report.data['calls'].append(call);self.report.persist('waiting_'+label)
        began=time.monotonic();deadline=began+35
        try:
            self.proc.stdin.write(sql.rstrip().removesuffix(';')+';\n\\echo '+marker+'\n');self.proc.stdin.flush()
            while True:
                self.reader.seek(self.offset);raw=self.reader.read()
                # A partial marker (or partial UTF-8 value) is not a response.
                # Only the exact complete LF-terminated marker line may end it.
                lines=raw.split(b'\n');mark=marker.encode('ascii')
                if mark in lines[:-1]:
                    require(lines.count(mark)==1 and lines[-2]==mark and lines[-1]==b'','Unexpected trailing response after marker')
                    value=b'\n'.join(lines[:-2]).decode('utf-8').strip()
                    self.offset=self.reader.tell();call['status']='returned';return value
                if self.proc.poll() is not None:
                    raise RuntimeError('Persistent psql exited: '+self.err_path.read_text(errors='replace')[-2500:])
                require(time.monotonic()<deadline,'Persistent psql response exceeded 35 seconds')
                time.sleep(.025)
        finally:call['callerWallMsIncludingTransportAndCollection']=(time.monotonic()-began)*1000;self.report.persist()
    def json(self,sql,label):return json.loads(self.query(sql,label))
    def close(self):
        if self.closed:return
        self.report.persist('waiting_'+self.user+'_disconnect')
        try:
            if self.proc.poll() is None:
                self.proc.stdin.write('\\q\n');self.proc.stdin.flush()
                try:self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait(timeout=5);raise RuntimeError('Session required forced termination')
            require(self.proc.returncode==0,'Session closed with psql failure')
        finally:self.closed=True;self.reader.close();self.out.close();self.err.close()


def identity_valid(value,instance,actor):
    require(value['sessionUser']==value['currentUser']==OWNER and value['superuser'] is False,'Clone requires original nonsuperuser owner LOGIN, without SET ROLE')
    require(all(value[k]==instance[k] for k in ('database','databaseOid','postmasterStart','serverVersionNum')),'Owner session database instance mismatch')
    require(value['statementTimeout']=='20s' and value['lockTimeout']=='12s' and value['isolation']=='read committed' and value['planCacheMode']=='auto' and value['standardConformingStrings']=='on' and value['actor']==actor,'Original owner session settings or actor mismatch; no repair')
    return (value['pid'],value['backendStart'])


def result_equal(old,new):
    require(old['value']==new['value'] and old['valueText']==new['valueText'],'Whole ordered scope JSON/bytes differ')
    require(old.get('review')==new.get('review') and old.get('reviewText')==new.get('reviewText'),'Whole ordered review JSON/bytes differ')


def finite_ms(value):
    require(type(value) in (int,float) and math.isfinite(value) and value>=0,'Invalid actual server timing');return value


def summary(values):
    ordered=sorted(finite_ms(x) for x in values)
    require(len(ordered)==20,'Exactly twenty measured pairs required')
    return {'medianMs':statistics.median(ordered),'p95Ms':ordered[18],'maxMs':ordered[-1]}


class Trial:
    def __init__(self,session,report,profile,bodies,instance):
        self.s=session;self.report=report;self.p=profile;self.b=bodies;self.instance=instance;self.actor=ident(1);self.identity=None;self.begun=False;self.prepared=[];self.case_data={}
    def query(self,sql,label):return self.s.json(sql,label)
    def timed(self,expression,label,review=False):
        tail="'review',r,'reviewText',r::text," if review else ''
        review_sql=("select jsonb_agg(public._work_unit_metadata_review("+lit(self.actor)+"::uuid,x) order by n) into r from jsonb_array_elements(v) with ordinality q(x,n);" if review=='batch' else "r:=public._work_unit_metadata_review("+lit(self.actor)+"::uuid,v);") if review else ''
        body="declare t timestamptz;v jsonb;r jsonb;ms double precision;begin t:=clock_timestamp();v:="+expression+";ms:=extract(epoch from clock_timestamp()-t)*1000;"+review_sql+"insert into pg_temp.metadata_trial_result values(jsonb_build_object('ms',ms,"+tail+"'value',v,'valueText',v::text));end;"
        sql="truncate pg_temp.metadata_trial_result;do "+lit(body)+";select value from pg_temp.metadata_trial_result"
        result=self.query(sql,label);finite_ms(result['ms']);return result
    def guard(self):
        proof=self.query("select jsonb_agg(to_jsonb(p) order by proof_key) from public._work_unit_metadata_contract p",'authored_proof_row')
        self.report.check(proof==[{'proof_key':'metadata_v1','expected_catalog_sha256':'27eee46a6bf49c11183f3086805c09c3708c2d7416c7d431a0d37c7fa3edb726'}],'Exact source-authored proof row, never learned from live catalog')
        v=self.query('select jsonb_build_object('+','.join(lit(n)+',public.'+n+'()' for n in GUARDS)+')','all_four_catalog_guards')
        self.report.check(v==dict.fromkeys(GUARDS,True),'Full source-authored metadata catalog and frozen guard admission')
    def admit(self):
        self.s.query("\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s'",'inspection_timeouts')
        self.s.query('begin;set local request.jwt.claim.sub='+lit(self.actor)+";do $locks$ begin perform pg_advisory_xact_lock(7712,0);perform pg_advisory_xact_lock(7710,0);end $locks$",'G7712_before_A7710');self.begun=True
        first=self.query(IDENTITY_SQL,'owner_identity_before');self.identity=identity_valid(first,self.instance,self.actor);self.report.data['identityBefore']=first
        for name,signature,body in [('_work_unit_metadata_scope','uuid,uuid,jsonb','old-scope-body.sql'),('_work_unit_metadata_members','uuid[]','members-body.sql'),('_work_unit_metadata_coverage','','coverage-body.sql')]:
            actual=self.query(metadata_sql(name,signature),'authored_attributes_'+name)
            self.report.check(actual==expected_metadata(name,self.b[body]),'Exact authored body/attributes/owner/ACL '+name)
        self.report.check(self.query('select to_jsonb(public._work_activity_actor())','fresh_synthetic_actor')==self.actor,'Eligible synthetic actor recaptured after G/A')
        self.guard();self.report.data['baselineCensus']=self.query(CENSUS_SQL,'baseline_census');self.report.persist()
        clone="create temporary table metadata_trial_result(value jsonb);create function pg_temp.metadata_scope_transition_probe(actor uuid,unit_id uuid,p_sourceids jsonb) returns jsonb language plpgsql volatile security invoker set search_path=public,pg_temp as $probe$"+self.b['candidate-scope-body.sql']+"$probe$;revoke all on function pg_temp.metadata_scope_transition_probe(uuid,uuid,jsonb) from public,anon,authenticated,service_role;"
        self.s.query(clone,'temporary_invoker_clone')
        permitted=self.query("select jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'ordinaryExecute',exists(select 1 from pg_roles r where r.rolname in('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'EXECUTE'))) from pg_proc p where p.oid='pg_temp.metadata_scope_transition_probe(uuid,uuid,jsonb)'::regprocedure",'clone_identity')
        self.report.check(permitted=={'owner':OWNER,'definer':False,'body':self.p['candidateBodySha256'],'ordinaryExecute':False},'Temporary clone invoker identity and revoked ordinary/service execution')
    def capture_members(self):
        groups={1:[ident(30)],10:[ident(21000+n) for n in range(10)],100:[ident(30000+n) for n in range(100)]}
        for size,units in groups.items():
            v=self.query('select public._work_unit_metadata_members('+lit('{'+','.join(units)+'}')+'::uuid[])','actual_members_'+str(size))
            require(isinstance(v,dict) and set(v)==set(units) and all(isinstance(x,list) for x in v.values()),'Exact existing unit memberships required')
            self.report.data['memberships'].append({'units':units,'size':size,'actualMembers':v,'compatibleKeyCounts':{u:len(keys(v[u])) for u in units}})
            self.case_data[size]=(units,v);self.report.persist()
        active=self.case_data[1][1][ident(30)];empty=self.case_data[100][1][ident(30000)]
        require(keys(active) and not keys(empty),'Required populated and empty-compatible-key branches absent; no replacement seed allowed')
        return [('supported_populated_unit',[ident(30)],{ident(30):active}),('existing_empty_key_unit',[ident(30000)],{ident(30000):empty}),('existing_10_light_units',*self.case_data[10]),('existing_100_light_units',*self.case_data[100])]
    def expression(self,variant,units,members):
        function='public._work_unit_metadata_scope' if variant=='old' else 'pg_temp.metadata_scope_transition_probe'
        calls=[function+'('+lit(self.actor)+'::uuid,'+lit(u)+'::uuid,'+json_literal(members[u])+')' for u in units]
        if len(calls)==1:return calls[0]
        return '(select jsonb_agg(v order by n) from (values '+','.join('('+str(n)+','+call+')' for n,call in enumerate(calls))+') q(n,v))'
    def scopes(self,cases):
        for name,units,members in cases:
            case={'caseId':name,'units':units,'memberInputSha256':digest(encoded(members)),'warmups':[],'pairs':[],'populatedBranchUnits':[u for u in units if keys(members[u])],'status':'running'}
            self.report.data['cases'].append(case);self.report.persist('scope_'+name)
            expected=None;expressions={v:self.expression(v,units,members) for v in ('old','candidate')}
            for phase,count in [('warmups',6),('pairs',20)]:
                for i in range(count):
                    order=['old','candidate'] if i%2==0 else ['candidate','old'];pair={}
                    for variant in order:pair[variant]=self.timed(expressions[variant],name+'_'+phase+'_'+str(i)+'_'+variant,review=True if len(units)==1 else 'batch')
                    ref=self.report.artifact(name+'-'+phase+'-'+str(i)+'.json',pair)
                    entry={'iteration':i,'order':order,'serverMs':{v:pair[v]['ms'] for v in pair},'fullResults':ref,'equality':'pending'}
                    case[phase].append(entry);self.report.persist('before_whole_json_equality')
                    result_equal(pair['old'],pair['candidate'])
                    if expected is None:expected=pair['old']
                    else:result_equal(expected,pair['old'])
                    scopes=[pair['old']['value']] if len(units)==1 else pair['old']['value']
                    require(isinstance(scopes,list) and len(scopes)==len(units) and all(isinstance(v,dict) and v.get('unit',{}).get('id')==u for u,v in zip(units,scopes)),'Every timed existing unit must return its actual complete scope')
                    if name=='supported_populated_unit':require(isinstance(pair['old']['value'],dict) and pair['old']['value']['manifest']['transitions'],'Populated scope must have actual transitions')
                    if name=='existing_empty_key_unit':require(isinstance(pair['old']['value'],dict) and pair['old']['value']['manifest']['transitions']==[],'Empty branch must retain exact empty transitions')
                    entry['equality']='passed';self.report.persist()
            case['completedTimedRequestsPerVariant']={'warmups':6,'measurements':20}
            case['scopeCallsPerRequestFromAuthoredExpression']=len(units)
            case['runtimeFunctionInvocationCounterMeasured']=False
            case['summary']={v:summary([p['serverMs'][v] for p in case['pairs']]) for v in ('old','candidate')};case['status']='finite_equality_passed';self.report.persist()
    def plan(self,statement,label):
        body="declare p jsonb;begin execute "+lit('explain(analyze,buffers,verbose,format json) '+statement)+" into p;insert into pg_temp.metadata_trial_result values(p);end;"
        sql="truncate pg_temp.metadata_trial_result;do "+lit(body)+";select value from pg_temp.metadata_trial_result"
        return self.query(sql,label)
    def plans(self,cases):
        for variant in ('old','candidate'):
            name='metadata_trial_'+variant;self.s.query('prepare '+name+'(jsonb) as '+selector_sql(self.b,variant),'prepare_'+variant);self.prepared.append(name)
        for case,units,members in cases[:2]:
            for variant in ('old','candidate'):
                name='metadata_trial_'+variant;statement='execute '+name+'('+json_literal(members[units[0]])+')'
                record={'caseId':case,'variant':variant,'notInternalPLpgSQLPlan':True,'candidateEmptyBranchSkipsSelector':variant=='candidate' and not keys(members[units[0]]),'warmupExecutions':[]};self.report.data['plans'].append(record);self.report.persist()
                record['before']=self.plan(statement,'prepared_plan_before_'+case+'_'+variant);self.report.persist()
                for i in range(6):
                    result=self.query(statement,'prepared_warmup_'+case+'_'+variant+'_'+str(i));record['warmupExecutions'].append({'iteration':i,'result':result});self.report.persist()
                record['after']=self.plan(statement,'prepared_plan_after_'+case+'_'+variant)
                record['cacheCounters']=self.query("select jsonb_build_object('genericPlans',generic_plans,'customPlans',custom_plans,'parameterTypes',parameter_types::text) from pg_prepared_statements where name="+lit(name),'prepared_cache_counters');self.report.persist()
    def members_profile(self):
        body=self.b['members-body.sql'].strip().removesuffix(';');require(body.count('p_units')==1,'One authored member parameter expected')
        cte_end=body.index(' select case when (select count(*) from selected)')
        ctes=['versions','units','roots','mapped','windows','service_units','summons_for_unit','crew','custom_sessions','visits','selected','grouped']
        for size,(units,members) in self.case_data.items():
            literal=lit('{'+','.join(units)+'}')+'::uuid[]';expression='public._work_unit_metadata_members('+literal+')';record={'size':size,'samples':[],'warmups':[],'scope':'Whole unchanged membership helper; no sum/extrapolation'}
            self.report.data.setdefault('membershipProfiles',[]).append(record);self.report.persist()
            record['expandedPlan']=self.plan(body.replace('p_units',literal),'expanded_members_plan_'+str(size))
            counts=body[:cte_end]+" select jsonb_build_object("+','.join(lit(n)+',(select count(*) from '+n+')' for n in ctes)+')'
            record['cteCounts']=self.query(counts.replace('p_units',literal),'members_cte_counts_'+str(size));self.report.persist()
            for phase,count in [('warmups',6),('samples',20)]:
                for i in range(count):
                    got=self.timed(expression,'members_'+str(size)+'_'+phase+'_'+str(i));require(got['value']==members,'Membership changed under trial G/A snapshot discipline')
                    record[phase].append(got['ms']);self.report.persist()
            record['summary']=summary(record['samples']);self.report.persist()
    def guard_profile(self):
        for name in GUARDS:
            record={'function':name,'samples':[],'warmups':[],'scope':'Independent server call, never added to whole RPC cost'}
            self.report.data.setdefault('guardProfiles',[]).append(record);self.report.persist()
            for phase,count in [('warmups',6),('samples',20)]:
                for i in range(count):
                    got=self.timed('to_jsonb(public.'+name+'())','guard_'+name+'_'+phase+'_'+str(i));require(got['value'] is True,'Guard refused during independent timing')
                    record[phase].append(got['ms']);self.report.persist()
            record['summary']=summary(record['samples']);self.report.persist()
        # A void gate has no comparable boolean result. Its real server-only
        # time is collected independently, without asserting a cost breakdown.
        gate=self.timed('(select to_jsonb(true) from (select public._work_activity_gate()) g)','existing_G_gate_single_probe')
        self.report.data['gateSingleProbe']=gate;self.report.persist()
    def cleanup(self):
        failures=[]
        try:self.s.query('rollback','terminal_rollback');self.report.data['cleanup']['rollbackConfirmed']=True
        except BaseException as error:failures.append(error_info(error))
        if not failures:
            for name in self.prepared:
                try:self.s.query('deallocate '+name,'deallocate_'+name)
                except BaseException as error:failures.append(error_info(error))
            try:
                absent=self.query("select to_jsonb(to_regprocedure('pg_temp.metadata_scope_transition_probe(uuid,uuid,jsonb)') is null and to_regclass('pg_temp.metadata_trial_result') is null)",'temp_cleanup_check');require(absent is True,'Temporary objects survived rollback');self.report.data['cleanup']['temporaryObjectsAbsent']=True
            except BaseException as error:failures.append(error_info(error))
        self.report.data['cleanup']['errors']=failures;self.report.persist('cleanup_complete' if not failures else 'cleanup_failed')
        require(not failures,'Trial cleanup failed: '+encoded(failures))
    def run(self):
        primary=None
        try:
            self.admit();cases=self.capture_members();self.plans(cases);self.scopes(cases);self.members_profile();self.guard_profile();self.guard()
            self.report.check(self.query(CENSUS_SQL,'final_census')==self.report.data['baselineCensus'],'Unchanged baseline row census and capture flag')
            final=self.query(IDENTITY_SQL,'owner_identity_after');require(identity_valid(final,self.instance,self.actor)==self.identity,'Persistent diagnostic backend changed');self.report.data['identityAfter']=final
        except BaseException as error:
            primary=error;self.report.data.update(status='failed',primaryFailure=error_info(error));self.report.persist('primary_failure_before_cleanup')
        finally:
            try:self.cleanup()
            except BaseException as error:
                self.report.data['cleanupFailure']=error_info(error);self.report.persist('cleanup_failed')
                if primary is None:raise
        if primary is not None:raise primary.with_traceback(primary.__traceback__)
        self.report.data.update(status='passed_limited_characterization',fixtureExecuted=True);self.report.persist('limited_trial_complete_full_parity_held')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--execute-fixture',action='store_true');parser.add_argument('--check-plan',action='store_true');parser.add_argument('--output');args=parser.parse_args(argv)
    require(not(args.execute_fixture and args.check_plan),'Choose plan or execution')
    if not args.execute_fixture:
        require(args.output is None,'Plan mode cannot accept runtime output')
        p,_=validate_source();print(json.dumps({'status':'PLAN VALIDATED','databaseContacted':False,'fixtureExecuted':False,'scopeCases':p['scopeCases'],'warmupsPerVariant':6,'pairsPerCase':20,'held':p['held']}));return 0
    require(args.output,'Explicit unused output required');report=Report(args.output);sessions=[];primary=None
    try:
        p,b=validate_source();report.data['profileSha256']=PROFILE_SHA;report.data['held']=p['held'];report.persist('source_validated')
        target=validate_url(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
        admin=Session(target,report,user='supabase_admin');sessions.append(admin)
        admin.query("\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s'",'admin_inspection_limits')
        instance=run_predecessor(target,report,p,admin);admin.close()
        session=Session(target,report);sessions.append(session);Trial(session,report,p,b,instance).run()
    except BaseException as error:
        primary=error;report.data.update(status='failed',failure=error_info(error));report.persist('failed')
    finally:
        for session in reversed(sessions):
            try:session.close()
            except BaseException as error:
                report.data.setdefault('disconnectFailures',[]).append(error_info(error));report.data['status']='failed';report.persist('disconnect_failed')
                if primary is None:primary=error
    if primary is not None:raise primary.with_traceback(primary.__traceback__)
    return 0


if __name__=='__main__':raise SystemExit(main())
