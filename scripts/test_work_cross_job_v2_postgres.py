#!/usr/bin/env python3
"""Standard-library no-contact controls; these are not PostgreSQL results."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('verify-work-cross-job-v2-postgres.py')
spec=importlib.util.spec_from_file_location('v2_fixture',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TARGET='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test'

class FakeProcess:
    def __init__(self,stdout='t\n',stderr='',returncode=0):self.calls=[];self.result=subprocess.CompletedProcess([],returncode,stdout,stderr)
    def __call__(self,args,**kw):self.calls.append((args,kw));return self.result


def fixture_payload(kind='switch'):
    return {'deviceId':m.uid(1),'clientGeneration':m.uid(2),'clientSequence':1,'predecessorCommandId':m.uid(3),'expectedRevision':3,'basis':{'observationId':m.uid(4)},'shiftRef':{'kind':'shift','id':m.uid(5)},'tappedAt':'2026-10-05T06:00:00.123456Z','clockCheckedAt':'2026-10-05T06:01:00.000000Z','clockSkewMs':0,'intent':{'kind':kind,'projectId':m.uid(6),'selectionId':m.uid(7),'selectionRevision':1,'menuVersionId':m.uid(8),'definitionVersionId':m.uid(9),'scope':'general','unit':None,'machineKind':None,'values':{}},'expectedAllocationId':None,'boundaryMode':'trusted_original_tap'}


def fixture_wire(payload=None):
    p=payload or fixture_payload();cid=m.uid(99);r={'protocolVersion':2,'commandId':cid,'status':'applied','reasonCode':None,'beforeRevision':3,'afterRevision':4,'transitionId':m.uid(100),'effectiveAt':p['tappedAt']}
    return p,{'protocolVersion':2,'availability':'available','receipt':r},{'protocolVersion':2,'availability':'available','receipt':r.copy(),'allocation':{'id':cid,'predecessorId':None,'boundaryMode':'trusted_original_tap','originalTappedAt':p['tappedAt'],'effectiveAt':p['tappedAt'],'shiftId':m.uid(5),'transitionId':m.uid(100)}}


class SourceAndPlan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.profile,cls.inert,cls.active=m.validate_source()
    def test_exact_source_pins_and_authored_single_delta(self):
        self.assertEqual(len(m.FIELDS),15);self.assertEqual(self.inert['functions'].__len__(),self.active['functions'].__len__())
        m.authored_delta(self.inert,self.active,self.profile['allowedCatalogDelta'])
        self.assertEqual(self.profile['sourcePins'][m.CANDIDATE],'c0eaccc11ca212853a3950bb64d47805990a2b4af824755a04d92b3fdf170c07')
    def test_observation_query_uses_only_fixture_actors_without_extra_closing_token(self):
        class Capture:
            def json(self,sql):self.sql=sql;return {'count':0,'ids':[]}
        capture=Capture();fixture=m.Fixture(capture,None,self.profile,self.inert,self.active)
        self.assertEqual(fixture.observations(),{'count':0,'ids':[]})
        prefix="select jsonb_build_object('count',count(*),'ids',coalesce(jsonb_agg(id order by id),'[]'::jsonb)) from work_activity_observations where actor_id in("
        actors=','.join("'"+m.uid(i)+"'::uuid" for i in (1,2,3,4,5))
        self.assertEqual(capture.sql,prefix+actors+')')

    def test_generated_inspector_queries_have_balanced_unquoted_parentheses(self):
        # Lexical regression check on actual generated SQL, not a SQL parser or
        # PostgreSQL execution claim. JSON strings can contain parentheses.
        class Capture:
            def __init__(self):self.queries=[]
            def json(self,sql):self.queries.append(sql);return {k:None for k in m.FIELDS}
            def run(self,sql):self.queries.append(sql);return 't'
        capture=Capture();fixture=m.Fixture(capture,None,self.profile,self.inert,self.active)
        fixture.times={'checked':'2026-10-05T06:01:00.000000Z'}
        fixture.rows();fixture.observations();fixture.paid(m.uid(1));fixture.retained(m.uid(2));fixture.request_proof(m.uid(3));fixture.census()
        fixture.compare_paid_wire({'note':"quoted ' ) ("},{'note':'other )'})
        capture.queries.append(fixture.clock_sql(m.uid(4),2,'2026-10-05T06:00:00.123456Z'))
        self.assertEqual(len(capture.queries),8)
        for sql in capture.queries:
            with self.subTest(sql=sql):
                depth=0;quoted=False;i=0
                while i<len(sql):
                    char=sql[i]
                    if char=="'":
                        if quoted and i+1<len(sql) and sql[i+1]=="'":i+=2;continue
                        quoted=not quoted
                    elif not quoted:
                        if char=='(':depth+=1
                        elif char==')':depth-=1;self.assertGreaterEqual(depth,0)
                    i+=1
                self.assertFalse(quoted);self.assertEqual(depth,0)
    def test_settings_reordered_maps_equal_without_losing_values(self):
        rows=[{'setdatabase':42,'setrole':7,'setconfig':['TimeZone=UTC','extra_float_digits=1','app.test=a=b']},{'setdatabase':0,'setrole':9,'setconfig':['search_path=public, pg_temp']}]
        reordered=copy.deepcopy(rows[::-1]);reordered[1]['setconfig'].reverse()
        self.assertTrue(m.validate_settings_restored(m.normalize_settings(rows),reordered))
        for mutation in ['TimeZone=America/Denver','extra_float_digits=-15','app.test=a']:
            changed=copy.deepcopy(rows);key=mutation.split('=')[0];changed[0]['setconfig']=[v for v in changed[0]['setconfig'] if not v.startswith(key+'=')]+[mutation]
            with self.assertRaisesRegex(RuntimeError,'settings changed'):m.validate_settings_restored(m.normalize_settings(rows),changed)
        self.assertNotEqual(m.normalize_settings(rows),m.normalize_settings(rows[:1]))
    def test_settings_projected_uint32_identities_and_string_oid_refusal(self):
        # OIDs are unsigned32 identifiers, including the valid all-database zero.
        rows=[{'setdatabase':0,'setrole':4294967295,'setconfig':None},{'setdatabase':4294967295,'setrole':0,'setconfig':['app.test=a=b']}]
        self.assertTrue(m.validate_settings_restored(m.normalize_settings(rows),rows[::-1]))
        for key in ('setdatabase','setrole'):
            with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'identity'):
                m.normalize_settings([{**rows[0],key:str(rows[0][key])}])

    def test_settings_reject_duplicate_and_invalid_keys_rows_or_fields(self):
        row={'setdatabase':42,'setrole':7,'setconfig':['TimeZone=UTC']}
        for config in [['TimeZone=UTC','timezone=UTC'],['bad key=x'],['=x'],['missing_equals'],[None],'TimeZone=UTC']:
            with self.subTest(config=config),self.assertRaises(RuntimeError):m.normalize_settings([{**row,'setconfig':config}])
        for rows in [[row,row],[{**row,'setrole':True}],[{**row,'unaccounted':1}]]:
            with self.assertRaises(RuntimeError):m.normalize_settings(rows)
        self.assertNotEqual(m.normalize_settings([{**row,'setconfig':None}]),m.normalize_settings([{**row,'setconfig':[]}]))
    def test_unknown_catalog_changes_cannot_become_expected(self):
        for section,change in [('functions',lambda x:x[0].update(cost=101)),('indexes',lambda x:x.append({'name':'unreviewed'})),('triggers',lambda x:x[0].update(enabled='D'))]:
            bad=copy.deepcopy(self.active);change(bad[section])
            with self.subTest(section=section),self.assertRaisesRegex(RuntimeError,'Only the one'):m.authored_delta(self.inert,bad,self.profile['allowedCatalogDelta'])
    def test_default_and_check_plan_never_spawn_or_contact(self):
        with patch.object(m.subprocess,'run',side_effect=AssertionError('no contact')),patch.object(m.subprocess,'Popen',side_effect=AssertionError('no process')),patch.object(m,'Report',side_effect=AssertionError('no evidence writes')),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main([]),0);self.assertEqual(m.main(['--check-plan']),0)
        for line in out.getvalue().splitlines():self.assertFalse(json.loads(line)['databaseContacted'])
    def test_plan_cannot_claim_runtime_or_write_output(self):
        for args in [['--check-plan','--execute-fixture'],['--output','/tmp/invalid'],['--execute-fixture']]:
            with self.subTest(args=args),self.assertRaises(RuntimeError):m.main(args)
    def test_exact_explicit_target_only(self):
        m.validate_target(TARGET);m.validate_target(TARGET.replace('localhost','127.0.0.1'))
        for bad in ['',TARGET.replace(':5432',''),TARGET.replace('localhost','example.com'),TARGET.replace('5432','5433'),TARGET.replace('fixture-only','other'),TARGET.replace('supabase_admin','postgres'),TARGET.replace(m.DATABASE,'postgres'),TARGET+'?host=elsewhere',TARGET+'#fragment',TARGET.replace('5432','bad')]:
            with self.subTest(url=bad),self.assertRaises(RuntimeError):m.validate_target(bad)
    def test_initial_partial_precedes_source_failure(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'new'/m.REPORT_NAME
            with patch.object(m,'validate_source',side_effect=RuntimeError('source drift')),patch.object(m.subprocess,'run',side_effect=AssertionError('no contact')),self.assertRaisesRegex(RuntimeError,'source drift'):
                m.main(['--execute-fixture','--output',str(output)])
            result=json.loads(output.read_text());self.assertEqual(result['status'],'failed');self.assertFalse(result['databaseContacted']);self.assertFalse(result['v2SuccessProof'])
    def test_initial_partial_precedes_bad_url(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'new'/m.REPORT_NAME
            with patch.dict(os.environ,{'WORK_ACTIVITY_ROLE_TEST_DB_URL':TARGET.replace('localhost','remote')}),patch.object(m.subprocess,'run',side_effect=AssertionError('no contact')),self.assertRaises(RuntimeError):m.main(['--execute-fixture','--output',str(output)])
            self.assertEqual(json.loads(output.read_text())['status'],'failed')
    def test_new_output_never_overwrites_any_existing_directory(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d);old=directory/m.REPORT_NAME;old.write_text('prior evidence')
            for path in [old,directory/'wrong.json',Path('relative')/m.REPORT_NAME,m.ROOT/'new'/m.REPORT_NAME]:
                with self.assertRaises(RuntimeError):m.Report(path)
            self.assertEqual(old.read_text(),'prior evidence')
    def test_instance_binding_rejects_restarts_and_copied_receipts(self):
        a={'systemIdentifier':'123','postmasterStart':'456','databaseOid':'42','database':m.DATABASE,'serverVersionNum':'170006'};m.same_instance(a,a)
        for key in a:
            b={**a,key:'other'}
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.same_instance(a,b)
        with self.assertRaises(RuntimeError):m.same_instance({**a,'extra':'x'},a)
    def test_predecessors_require_exact_counts_source_roles_and_restore(self):
        inert={'status':'passed','checks':47,'activation':False,'stage':'complete_inert_catalog_roles','sourceSha256':self.profile['sourcePins'][m.CANDIDATE],'harnessSha256':self.profile['sourcePins']['scripts/verify-work-cross-job-postgres.py'],'newCatalogSha256':self.profile['inertCatalogDigest']}
        fresh={'status':'passed','checks':66,'activation':False,'sourceSha256':self.profile['sourcePins'][m.CANDIDATE],'scriptSha256':self.profile['sourcePins']['scripts/verify-work-cross-job-fresh-sessions.py'],'catalogSha256':self.profile['inertCatalogDigest'],'freshSessionV1Proof':True,'v2SuccessProof':False,'settingsRestored':True,'sessions':[{}]*22}
        for kind,good in [('inert',inert),('fresh',fresh)]:
            m.validate_predecessor(kind,good,self.profile)
            for key in good:
                with self.subTest(kind=kind,key=key),self.assertRaises((RuntimeError,TypeError)):m.validate_predecessor(kind,{**good,key:None},self.profile)
    def test_execution_is_not_reachable_from_module_import(self):
        tree=ast.parse(SCRIPT.read_text());top_calls=[x for x in tree.body if isinstance(x,ast.Expr) and isinstance(x.value,ast.Call)]
        self.assertEqual(top_calls,[])
        self.assertNotIn('socket',SCRIPT.read_text());self.assertNotIn('requests.',SCRIPT.read_text());self.assertNotIn('urllib.request',SCRIPT.read_text())


class RuntimeBoundaryMocks(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.report=m.Report(Path(self.temp.name)/'new'/m.REPORT_NAME)
    def test_each_sql_wait_persists_partial_and_scrubs_pg_environment(self):
        fake=FakeProcess()
        def checking(args,**kw):
            saved=json.loads(self.report.path.read_text());self.assertEqual(saved['stage'],'psql_wait');self.assertEqual(saved['calls'][-1]['status'],'waiting');return fake(args,**kw)
        with patch.dict(os.environ,{'PGHOST':'remote','PGSERVICE':'prod','PGOPTIONS':'-c role=postgres','PGDATABASE':'real'}):r=m.Runner(m.validate_target(TARGET),self.report,checking)
        r.run('select 1',user='authenticator');r.run('select 2',user='postgres')
        args,kw=fake.calls[0];self.assertIn('authenticator:fixture-only@localhost:5432/',args[1]);self.assertIn('-X',args)
        self.assertNotIn('PGHOST',kw['env']);self.assertNotIn('PGSERVICE',kw['env']);self.assertNotIn('PGDATABASE',kw['env']);self.assertEqual(kw['env']['PGOPTIONS'],'-c timezone=UTC -c extra_float_digits=1')
        self.assertNotIn('statement_timeout',kw['input']);self.assertNotIn('lock_timeout',kw['input']);self.assertEqual(kw['timeout'],35)
        self.assertIn("statement_timeout='20s'",fake.calls[1][1]['input']);self.assertIn("lock_timeout='12s'",fake.calls[1][1]['input'])
    def test_process_timeout_preserves_running_partial_for_outer_failure_handler(self):
        def timed(*args,**kwargs):raise subprocess.TimeoutExpired('fixture',35)
        with self.assertRaises(subprocess.TimeoutExpired):m.Runner(m.validate_target(TARGET),self.report,timed).run('select 1')
        self.assertTrue(json.loads(self.report.path.read_text())['databaseContacted'])
    def test_refusal_requires_actual_error_state_and_message(self):
        r=m.Runner(m.validate_target(TARGET),self.report,FakeProcess(stderr='ERROR: 23514: Clock command identity conflicts.',returncode=3));r.run('select 1',error='23514',message='Clock command identity conflicts.')
        for state,msg in [('42501','Clock command identity conflicts.'),('23514','wrong')]:
            with self.assertRaises(RuntimeError):r.run('select 1',error=state,message=msg)
        with self.assertRaises(RuntimeError):m.Runner(m.validate_target(TARGET),self.report,FakeProcess()).run('select 1',error='23514')
    def test_no_runtime_timeout_widening_or_unbounded_options(self):
        r=m.Runner(m.validate_target(TARGET),self.report,FakeProcess())
        for patch_args in [{'user':'service_role'},{'zone':'UTC -c role=postgres'},{'digits':0}]:
            with self.assertRaises(RuntimeError):r.run('select 1',**patch_args)
    def test_auth_uses_actual_fresh_login_role_jwt_and_installed_timeouts(self):
        a={'kind':'login','pid':123,'backendStart':'456','sessionUser':'authenticator','currentUser':'authenticator','zone':'UTC','statementTimeout':'8s','lockTimeout':'8s'}
        b={'kind':'runtime','sessionUser':'authenticator','currentUser':'authenticated','jwtSubject':m.uid(1),'zone':'UTC','floatDigits':'1','statementTimeout':'8s','lockTimeout':'8s'}
        fake=FakeProcess(stdout=json.dumps(a)+'\n'+json.dumps(b)+'\n');f=m.Fixture(m.Runner(m.validate_target(TARGET),self.report,fake),self.report,{}, {}, {})
        f.auth(m.uid(1),'select 1;');sent=fake.calls[0][1]['input'];self.assertLess(sent.index('Runtime identity or installed timeout changed'),sent.index('select 1;'));self.assertIn('SET ROLE authenticated',sent);self.assertIn('request.jwt.claim.sub',sent)
        with self.assertRaises(RuntimeError):f.auth(m.uid(1),'select 1;')
    def test_auth_wrong_jwt_or_defaults_not_counted(self):
        for key,value in [('jwtSubject',m.uid(99)),('statementTimeout','20s'),('currentUser','postgres')]:
            a={'kind':'login','pid':123,'backendStart':'456','sessionUser':'authenticator','currentUser':'authenticator','zone':'UTC','statementTimeout':'8s','lockTimeout':'8s'}
            b={'kind':'runtime','sessionUser':'authenticator','currentUser':'authenticated','jwtSubject':m.uid(1),'zone':'UTC','floatDigits':'1','statementTimeout':'8s','lockTimeout':'8s',key:value}
            f=m.Fixture(m.Runner(m.validate_target(TARGET),self.report,FakeProcess(stdout=json.dumps(a)+'\n'+json.dumps(b))),self.report,{}, {}, {})
            with self.subTest(key=key),self.assertRaises(RuntimeError):f.auth(m.uid(1),'select 1;')
    def test_predecessor_wait_heartbeat_and_nonzero_refusal(self):
        class Child:
            def __init__(self,code):self.code=code;self.calls=0
            def wait(self,timeout):
                self.calls+=1
                if self.calls==1:raise subprocess.TimeoutExpired('child',timeout)
                return self.code
            def poll(self):return self.code
        calls=[]
        def launch(*args,**kwargs):calls.append((args,kwargs));return Child(0)
        m.predecessor_process(Path('pinned.py'),[],{},Path(self.temp.name)/'child.log',self.report,launch)
        self.assertEqual(self.report.value['predecessorWait']['script'],'pinned.py');self.assertEqual(calls[0][0][0][0],m.sys.executable)
        with self.assertRaisesRegex(RuntimeError,'Pinned predecessor failed'):m.predecessor_process(Path('bad.py'),[],{},Path(self.temp.name)/'bad.log',self.report,lambda *a,**k:Child(1))
    def test_enrollment_expected_digest_is_authored_never_live(self):
        class Stub:
            def __init__(self):self.calls=[]
            def run(self,sql,**kwargs):self.calls.append((sql,kwargs));return 't'
        class Controlled(m.Fixture):
            def catalog_equal(self,*args):pass
            def guards(self,*args):pass
            def authored_digest(self,expected):return self.profile['inertCatalogDigest'] if expected==self.inert else 'b'*64
        stub=Stub();f=Controlled(stub,self.report,{'inertCatalogDigest':'a'*64,'allowedCatalogDelta':{'field':'body'}},{'authored':'inert'},{'authored':'active'});f.enroll()
        sql=next(sql for sql,_ in stub.calls if sql.startswith('BEGIN;'));self.assertIn("'{\"authored\":\"active\"}'::jsonb::text",sql)
        self.assertIn('ALTER TABLE public.work_cross_job_contract DISABLE TRIGGER work_cross_job_contract_immutable;',sql)
        self.assertEqual(sql.count('DISABLE TRIGGER'),1);self.assertEqual(sql.count('ENABLE TRIGGER'),1)
        self.assertLess(sql.index('ENABLE TRIGGER'),sql.index('COMMIT'))
        update=sql[sql.index('UPDATE public.work_cross_job_contract'):sql.index('ALTER TABLE public.work_cross_job_contract ENABLE')]
        self.assertNotIn('pg_proc',update);self.assertNotIn('c.value',update);self.assertNotIn(f.catalog,update)
    def test_ambiguous_enrollment_restores_only_an_authored_catalog(self):
        class Stub:
            def __init__(self,live):self.live=live;self.calls=[]
            def json(self,*a,**k):return self.live
            def run(self,sql,**kwargs):self.calls.append(sql);return 't'
        class Controlled(m.Fixture):
            def catalog_equal(self,*args):pass
        for live,allowed in [({'authored':'inert'},True),({'authored':'active'},True),({'unreviewed':'drift'},False)]:
            stub=Stub(live);f=Controlled(stub,self.report,{'inertCatalogDigest':'a'*64},{'authored':'inert'},{'authored':'active'});f.enrollment_attempted=True
            if allowed:
                with contextlib.redirect_stdout(io.StringIO()):f.restore()
                self.assertTrue(self.report.value['catalogRestored'])
            else:
                with self.assertRaisesRegex(RuntimeError,'refuse normalization'):f.restore()
                self.assertEqual(stub.calls,[])
    def test_predecessors_are_executed_not_accepted_as_external_receipt_arguments(self):
        tree=ast.parse(SCRIPT.read_text());node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='predecessors');text=ast.get_source_segment(SCRIPT.read_text(),node)
        self.assertIn('predecessor_process(',text);self.assertLess(text.index('predecessor_process('),text.index('validate_predecessor('))
        self.assertIn('same_instance(identity,before)',text);self.assertIn('same_instance(identity,after)',text)
        self.assertIn('Starts after0846, refuses already installed0847',text);self.assertIn('validate_settings_restored(settings,',text)
        self.assertNotIn('add_argument(\"--predecessor',SCRIPT.read_text())
    def test_only_literal_gate_body_and_proof_trigger_are_changed(self):
        text=SCRIPT.read_text();self.assertNotIn('create trigger ',text.lower());self.assertNotIn('create type ',text.lower());self.assertNotIn('grant execute',text.lower());self.assertNotIn('alter role',text.lower());self.assertNotIn('alter system',text.lower())
        self.assertNotIn('_work_cross_job_coverage() returns',text);self.assertNotIn('DISABLE TRIGGER ALL',text)
        self.assertEqual(m.GATE_TRUE.replace('select true','select false'),m.GATE_FALSE)
    def test_guard_expectations_preserve_intentional_v1_reporting_fence(self):
        class R:
            def __init__(self,v):self.v=v
            def json(self,*a,**k):return self.v
        f=m.Fixture(R({'cross':True,'review':False,'totals':False,'contributors':False,'enabled':True}),self.report,{}, {}, {})
        with contextlib.redirect_stdout(io.StringIO()):f.guards(True)
        with self.assertRaises(RuntimeError):f.guards(False)
    def test_primary_and_cleanup_errors_both_survive_outer_main(self):
        for primary_fails in (True,False):
            identity={'systemIdentifier':'123','postmasterStart':'456','databaseOid':'42','database':m.DATABASE,'serverVersionNum':'170006'}
            class F(m.Fixture):
                def predecessors(self):self.report.value['instance']=identity
                def census(self):return {}
                def enroll(self):pass
                def seed(self):
                    if primary_fails:raise ValueError('primary scenario failed')
                def fallback_cases(self):pass
                def active_case(self,*args):pass
                def catalog_equal(self,*args):pass
                def guards(self,*args):pass
                def instance(self):return identity
                def restore(inner):
                    saved=json.loads(inner.report.path.read_text())
                    if primary_fails:self.assertEqual(saved['primaryFailure']['message'],'primary scenario failed')
                    else:self.assertNotIn('primaryFailure',saved)
                    raise RuntimeError('cleanup also failed')
            with tempfile.TemporaryDirectory() as d:
                out=Path(d)/'new'/m.REPORT_NAME
                with patch.object(m,'Fixture',F),patch.dict(os.environ,{'WORK_ACTIVITY_ROLE_TEST_DB_URL':TARGET}),patch.object(m.subprocess,'run',side_effect=AssertionError('no DB')),self.assertRaisesRegex(ValueError if primary_fails else RuntimeError,'primary scenario failed' if primary_fails else 'cleanup also failed'):
                    m.main(['--execute-fixture','--output',str(out)])
                saved=json.loads(out.read_text());self.assertEqual(saved['status'],'failed');self.assertFalse(saved['v2SuccessProof'])
                self.assertEqual(saved['restorationFailure'],{'type':'RuntimeError','message':'cleanup also failed'})
                if primary_fails:self.assertEqual(saved['failure'],saved['primaryFailure'])
                else:self.assertEqual(saved['failure'],saved['restorationFailure'])
    def test_unexpected_enabled_event_trigger_refuses_before_ddl(self):
        class R:
            def __init__(self):self.calls=[]
            def run(self,sql,**kwargs):self.calls.append(sql);return 'f'
        r=R();f=m.Fixture(r,self.report,{}, {}, {})
        with self.assertRaisesRegex(RuntimeError,'no enabled event triggers'):f.enroll()
        self.assertEqual(len(r.calls),1);self.assertIn('pg_event_trigger',r.calls[0]);self.assertFalse(f.enrollment_attempted)
    def test_restore_runs_on_scenario_failure_and_does_not_delete_history(self):
        class F(m.Fixture):
            def predecessors(self):pass
            def census(self):return {}
            def enroll(self):self.active_enrolled=True
            def seed(self):raise RuntimeError('synthetic scenario failure')
            def restore(self):self.report.value['restorationAttempted']=True
        f=F(None,self.report,{}, {}, {})
        with self.assertRaisesRegex(RuntimeError,'synthetic'):f.run()
        self.assertTrue(self.report.value['restorationAttempted'])
        source=ast.get_source_segment(SCRIPT.read_text(),next(n for n in ast.walk(ast.parse(SCRIPT.read_text())) if isinstance(n,ast.FunctionDef) and n.name=='restore'))
        self.assertNotIn('DELETE FROM',source);self.assertNotIn('TRUNCATE',source)


class WireAndFiniteCases(unittest.TestCase):
    def test_real_keyed_paid_response_contracts_preserve_original_shift(self):
        times={'break':'2026-10-05T06:04:00.123456Z','return':'2026-10-05T06:05:00.123456Z','out':'2026-10-05T06:06:00.123456Z'}
        original={'id':m.uid(1),'profile_id':m.uid(2),'project_id':m.uid(3),'cost_code_id':m.uid(4),'clock_in_at':'2026-10-05T06:00:00.123456+00:00','clock_out_at':None,'last_punch_at':'2026-10-05T06:00:00.123456+00:00','break_started_at':None,'break_type':None,'break_seconds':0,'status':'open','review_reason':None,'injured':None,'time_confirmed':None}
        started={**original,'break_started_at':times['break'].replace('Z','+00:00'),'last_punch_at':times['break'],'break_type':'rest'}
        returned={**original,'break_seconds':60,'last_punch_at':times['return']}
        out={**returned,'status':'submitted','clock_out_at':times['out'],'last_punch_at':times['out'],'injured':False,'time_confirmed':True}
        cases=[('start_break',started),('end_break',{'outcome':'ended','shift':returned}),('clock_out',out)]
        for action,response in cases:
            saved=copy.deepcopy(original);row=m.validate_paid_response(action,response,original,times)
            self.assertEqual(row['id'],original['id']);self.assertEqual(original,saved)
            for field in ('id','profile_id','project_id','cost_code_id','clock_in_at','last_punch_at'):
                bad=copy.deepcopy(response);target=bad['shift'] if action=='end_break' else bad;target[field]=m.uid(77) if field.endswith('_id') or field=='id' else times['out']
                if field=='last_punch_at':target[field]=times['break'] if action!='start_break' else times['return']
                with self.subTest(action=action,field=field),self.assertRaises(RuntimeError):m.validate_paid_response(action,bad,original,times)
        for malformed in [returned,{'outcome':'requires_review','shift':returned},{'outcome':'ended','shift':returned,'extra':True}]:
            with self.assertRaises(RuntimeError):m.validate_paid_response('end_break',malformed,original,times)
        for action,row in [('start_break',started),('clock_out',out)]:
            with self.assertRaises(RuntimeError):m.validate_paid_response(action,{'outcome':'ended','shift':row},original,times)
        bad={**started,'break_started_at':times['return']}
        with self.assertRaises(RuntimeError):m.validate_paid_response('start_break',bad,original,times)
        bad={**out,'clock_out_at':times['return']}
        with self.assertRaises(RuntimeError):m.validate_paid_response('clock_out',bad,original,times)
    def test_refused_snapshot_keeps_private_state_in_business_equality(self):
        actor=m.uid(1);m.require_snapshot_state({'personal_activity_state':[{'profile_id':actor}]},actor)
        for states in [[],[{'profile_id':m.uid(2)}],[{'profile_id':actor},{'profile_id':actor}]]:
            with self.assertRaisesRegex(RuntimeError,'prior paid operation private state'):m.require_snapshot_state({'personal_activity_state':states},actor)
        self.assertEqual(m.BUSINESS_TABLES['personal_activity_state'],'profile_id')
    def test_exact_separate_response_shapes(self):
        p,r,l=fixture_wire();m.validate_wire(m.uid(99),p,r,l,'applied')
        with self.assertRaises(RuntimeError):m.validate_wire(m.uid(99),p,l,l,'applied')
        with self.assertRaises(RuntimeError):m.validate_wire(m.uid(99),p,r,r,'applied')
    def test_wrong_extra_missing_and_unsafe_payloads_refused(self):
        for key in fixture_payload():
            p=fixture_payload();del p[key]
            with self.subTest(missing=key),self.assertRaises(RuntimeError):m.validate_payload(p)
        for values in [{'extra':None},{'expectedRevision':True},{'clientSequence':2**53},{'clockSkewMs':float('nan')},{'boundaryMode':'arrival'},{'tappedAt':'2026-02-30T06:00:00.123456Z'},{'shiftRef':{'kind':'clock_command','id':m.uid(5)}}]:
            with self.subTest(values=values),self.assertRaises((RuntimeError,ValueError)):m.validate_payload({**fixture_payload(),**values})
    def test_allocation_and_receipt_lineage_mismatches_refused(self):
        for field,value in [('id',m.uid(98)),('predecessorId',m.uid(3)),('effectiveAt','2026-10-05T06:00:00.123457Z'),('shiftId',m.uid(88)),('boundaryMode','arrival')]:
            p,r,l=fixture_wire();l['allocation'][field]=value
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_wire(m.uid(99),p,r,l,'applied')
        for field,value in [('protocolVersion',1),('commandId',m.uid(1)),('afterRevision',5),('beforeRevision',True),('reasonCode','bad')]:
            p,r,l=fixture_wire();r['receipt'][field]=value;l['receipt']=copy.deepcopy(r['receipt'])
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_wire(m.uid(99),p,r,l,'applied')
    def test_establish_noop_never_creates_allocation(self):
        p=fixture_payload();p.update(clientSequence=0,predecessorCommandId=None,intent={'kind':'establish_stream','previousGeneration':None,'previousHeadCommandId':None})
        _,r,l=fixture_wire(p);r['receipt'].update(status='noop',afterRevision=3,effectiveAt=None,transitionId=None);l.update(receipt=r['receipt'].copy(),allocation=None)
        m.validate_wire(m.uid(99),p,r,l,'noop')
        l['allocation']={}
        with self.assertRaises(RuntimeError):m.validate_wire(m.uid(99),p,r,l,'noop')
    def test_finite_scenarios_use_public_commands_and_keep_later_families_open(self):
        text=SCRIPT.read_text()
        for name in ['public.sign_toolbox_talk(','public.clock_in(','public.work_publish_activity_version(','public.work_publish_menu_version(','public.work_select_job_menu(','public.work_activity_command(','public.work_cross_job_snapshot(','public.work_cross_job_receipt(','public.start_break(','public.end_break(','public.clock_out(']:self.assertIn(name,text)
        self.assertNotIn('insert into work_cross_job_allocations',text.lower());self.assertNotIn('insert into work_cross_job_shifts',text.lower());self.assertNotIn('_work_cross_job_source(',text)
        self.assertIn("self.active_case(uid(1),'general')",text);self.assertIn("self.active_case(uid(2),'specific')",text)
    def test_whole_row_and_tuple_checks_do_not_claim_audit_trigger_count(self):
        text=SCRIPT.read_text();self.assertIn("'xmin',xmin::text,'ctid',ctid::text",text);self.assertIn('observationsBefore',text);self.assertIn('Read-only version2 fingerprint composite',text)
        self.assertNotIn('paid_audit',text);self.assertNotIn('DISABLE TRIGGER work_activity_clock',text)


if __name__=='__main__':unittest.main(verbosity=2)
