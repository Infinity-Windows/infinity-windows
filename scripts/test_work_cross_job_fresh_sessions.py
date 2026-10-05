#!/usr/bin/env python3
"""No-contact source/AST/mock controls. Does not claim PostgreSQL execution."""
import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('verify-work-cross-job-fresh-sessions.py')
spec=importlib.util.spec_from_file_location('fresh_sessions',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TARGET='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test'

class FakeProcess:
    def __init__(self,stdout='t\n',stderr='',returncode=0):self.calls=[];self.result=subprocess.CompletedProcess([],returncode,stdout,stderr)
    def __call__(self,args,**kwargs):self.calls.append((args,kwargs));return self.result

class FreshSessionPlan(unittest.TestCase):
    def test_exact_pins_and_schema_are_current(self):
        metadata=m.validate_source();self.assertEqual(len(m.FIELDS),15);self.assertEqual(len(m.TIMESTAMPS),5)
        self.assertTrue(all(any(x['name']==name for x in metadata['columns']) for name in m.FIELDS))
    def test_check_plan_and_default_never_contact(self):
        with patch.object(m.subprocess,'run',side_effect=AssertionError('Unexpected process')),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main(['--check-plan']),0);self.assertEqual(m.main([]),0)
        for line in out.getvalue().splitlines():self.assertFalse(json.loads(line)['databaseTests'])
    def test_execution_is_explicit(self):
        with self.assertRaises(RuntimeError):m.main(['--check-plan','--execute-fixture'])
    def test_only_exact_disposable_target(self):
        self.assertEqual(m.validate_target(TARGET).hostname,'localhost')
        self.assertEqual(m.validate_target(TARGET.replace('localhost','127.0.0.1')).hostname,'127.0.0.1')
        for bad in ['',TARGET.replace('localhost','remote.example'),TARGET.replace('5432','5433'),TARGET+'?host=remote',TARGET+'#x',TARGET.replace('fixture-only','secret'),TARGET.replace('supabase_admin','postgres'),TARGET.replace('forge_work_activity_role_test','postgres'),'postgresql://supabase_admin:fixture-only@localhost:bad/forge_work_activity_role_test']:
            with self.subTest(bad=bad),self.assertRaises(RuntimeError):m.validate_target(bad)
    def test_exact_predecessor_receipt(self):
        good={'status':'passed','stage':'complete_inert_catalog_roles','sourceSha256':m.SOURCE_SHA,'harnessSha256':m.HARNESS_SHA,'newCatalogSha256':m.CATALOG_SHA,'activation':False};m.validate_predecessor(good)
        for field in good:
            bad={**good,field:'wrong'}
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_predecessor(bad)
    def test_bad_target_rejected_before_process(self):
        with patch.dict(os.environ,{'WORK_ACTIVITY_ROLE_TEST_DB_URL':TARGET.replace('localhost','remote.example')}),patch.object(m.subprocess,'run',side_effect=AssertionError('Unexpected process')):
            with self.assertRaises(RuntimeError):m.main(['--execute-fixture'])
    def test_inert_receipt_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            receipt=Path(d)/'inert.json';receipt.write_text(json.dumps({'status':'passed','stage':'complete_inert_catalog_roles','sourceSha256':m.SOURCE_SHA,'harnessSha256':m.HARNESS_SHA,'newCatalogSha256':m.CATALOG_SHA,'activation':False}))
            with patch.dict(os.environ,{'WORK_ACTIVITY_ROLE_TEST_DB_URL':TARGET,'WORK_CROSS_JOB_POSTGRES_OUT':str(receipt),'WORK_CROSS_JOB_FRESH_SESSIONS_OUT':str(receipt)}),patch.object(m.subprocess,'run',side_effect=AssertionError('Unexpected process')):
                with self.assertRaises(RuntimeError):m.main(['--execute-fixture'])
    def test_existing_or_wrong_output_refused_before_contact(self):
        with tempfile.TemporaryDirectory() as d:
            receipt=Path(d)/'inert.json';receipt.write_text(json.dumps({'status':'passed','stage':'complete_inert_catalog_roles','sourceSha256':m.SOURCE_SHA,'harnessSha256':m.HARNESS_SHA,'newCatalogSha256':m.CATALOG_SHA,'activation':False}))
            existing=Path(d)/'work-cross-job-fresh-sessions.json';existing.write_text('prior evidence')
            for output in [existing,Path(d)/'wrong.json',Path(d)/'subdir/work-cross-job-fresh-sessions.json']:
                with patch.dict(os.environ,{'WORK_ACTIVITY_ROLE_TEST_DB_URL':TARGET,'WORK_CROSS_JOB_POSTGRES_OUT':str(receipt),'WORK_CROSS_JOB_FRESH_SESSIONS_OUT':str(output)}),patch.object(m.subprocess,'run',side_effect=AssertionError('Unexpected process')):
                    with self.assertRaises(RuntimeError):m.main(['--execute-fixture'])
            self.assertEqual(existing.read_text(),'prior evidence')
    def test_each_run_starts_independent_psql_without_ambient_pg(self):
        fake=FakeProcess()
        with patch.dict(os.environ,{'PGHOST':'remote.example','PGOPTIONS':'-c role=postgres','PGSERVICE':'production','PGDATABASE':'real'}):runner=m.Runner(m.validate_target(TARGET),fake)
        runner.run('select 1',user='authenticator');runner.run('select 2',user='authenticator',zone='America/Denver')
        self.assertEqual(len(fake.calls),2)
        for args,kwargs in fake.calls:
            self.assertIn('authenticator:fixture-only@localhost:5432/forge_work_activity_role_test',args[1]);self.assertIn('-X',args);self.assertEqual(args[-1],'ON_ERROR_STOP=1')
            self.assertFalse(any(k in kwargs['env'] for k in ('PGHOST','PGDATABASE','PGSERVICE')));self.assertNotIn('statement_timeout',kwargs['input']);self.assertNotIn('lock_timeout',kwargs['input'])
        self.assertNotIn('PGOPTIONS',fake.calls[0][1]['env']);self.assertEqual(fake.calls[1][1]['env']['PGOPTIONS'],'-c timezone=America/Denver')
    def test_connection_options_and_negative_float_are_bounded(self):
        fake=FakeProcess();runner=m.Runner(m.validate_target(TARGET),fake);runner.run('select 1',user='authenticator',zone='UTC',digits=-15)
        self.assertEqual(fake.calls[0][1]['env']['PGOPTIONS'],'-c timezone=UTC -c extra_float_digits=-15')
        for kwargs in [{'user':'service_role'},{'zone':'UTC -c role=postgres'},{'digits':0}]:
            with self.assertRaises(RuntimeError):runner.run('select 1',**kwargs)
    def test_expected_refusal_requires_state_and_message(self):
        runner=m.Runner(m.validate_target(TARGET),FakeProcess(stderr='ERROR: 23514: Clock command identity conflicts.',returncode=3))
        runner.run('select 1',error='23514',message='Clock command identity conflicts.')
        for state,msg in [('42501','Clock command identity conflicts.'),('23514','Other')]:
            with self.assertRaises(RuntimeError):runner.run('select 1',error=state,message=msg)
        with self.assertRaises(RuntimeError):m.Runner(m.validate_target(TARGET),FakeProcess()).run('select 1',error='23514')
    def test_settings_config_proves_nologin_does_not_apply(self):
        sql=m.configure_sql('database','UTC');self.assertIn('ALTER DATABASE "forge_work_activity_role_test" SET "TimeZone" TO \'UTC\'',sql);self.assertIn('ALTER ROLE "authenticated" SET "TimeZone" TO \'America/Denver\'',sql);self.assertIn('ALTER ROLE "authenticated" SET extra_float_digits TO -15',sql)
        sql=m.configure_sql('login_role','America/Denver');self.assertIn('ALTER ROLE "authenticator" SET "TimeZone" TO \'America/Denver\'',sql);self.assertIn('ALTER DATABASE "forge_work_activity_role_test" SET "TimeZone" TO \'UTC\'',sql)
        self.assertNotIn('ALTER SYSTEM',sql);self.assertNotIn('RESET ALL',sql)
    def test_restore_preserves_absence_values_and_unrelated_keys(self):
        rows=[{'role':'authenticator','database':None,'settings':['statement_timeout=8s','TimeZone=America/Denver','extra_float_digits=3']},{'role':None,'database':m.DATABASE,'settings':['lock_timeout=8s','TimeZone=UTC']}]
        sql=m.restore_sql(rows)
        self.assertIn('ALTER ROLE "authenticator" SET "TimeZone" TO \'America/Denver\'',sql);self.assertIn('SET "extra_float_digits" TO \'3\'',sql)
        self.assertIn('ALTER DATABASE "forge_work_activity_role_test" RESET "extra_float_digits"',sql);self.assertNotIn('statement_timeout',sql);self.assertNotIn('lock_timeout',sql);self.assertNotIn('RESET ALL',sql)
        reversed_rows=[{**x,'settings':list(reversed(x['settings']))} for x in rows];self.assertEqual(m.settings_map(rows),m.settings_map(reversed_rows))
    def test_runtime_identity_and_reused_session_rejected(self):
        login={'kind':'login','pid':42,'backendStartEpoch':'123','sessionUser':'authenticator','currentUser':'authenticator','zone':'UTC','floatDigits':'1'};runtime={'kind':'runtime','sessionUser':'authenticator','currentUser':'authenticated','zone':'UTC','floatDigits':'1'}
        fake=FakeProcess(stdout=json.dumps(login)+'\n'+json.dumps(runtime)+'\n');runner=m.Runner(m.validate_target(TARGET),fake)
        with tempfile.TemporaryDirectory() as d:
            scenario=m.Scenario(runner,Path(d)/'out.json');scenario.auth(m.uid(1),'select 1','UTC')
            sent=fake.calls[0][1]['input'];self.assertLess(sent.index('Fresh runtime settings mismatch'),sent.index('select 1'));self.assertIn('SET ROLE authenticated',sent)
            with self.assertRaises(RuntimeError):scenario.auth(m.uid(1),'select 1','UTC')
            self.assertNotIn('supabase_admin',fake.calls[0][0][1])
    def test_wrong_runtime_settings_refuse(self):
        login={'kind':'login','pid':43,'backendStartEpoch':'123','sessionUser':'authenticator','currentUser':'authenticator','zone':'America/Denver','floatDigits':'1'};runtime={**login,'kind':'runtime','currentUser':'authenticated'}
        runner=m.Runner(m.validate_target(TARGET),FakeProcess(stdout=json.dumps(login)+'\n'+json.dumps(runtime)))
        with tempfile.TemporaryDirectory() as d,self.assertRaises(RuntimeError):m.Scenario(runner,Path(d)/'out.json').auth(m.uid(1),'select 1','UTC')
    def test_restore_runs_after_mid_scenario_failure(self):
        class Stub:
            calls=[]
            def run(self,sql,**kwargs):
                self.calls.append({'sql':sql,**kwargs})
                if 'server_version_num' in sql:return '17'
                if 'not exists(select 1 from auth.users' in sql:raise RuntimeError('synthetic mid-run failure')
                return 't'
            def json(self,sql,**kwargs):return [{'role':None,'database':m.DATABASE,'settings':['TimeZone=UTC']}]
        stub=Stub()
        with tempfile.TemporaryDirectory() as d:
            scenario=m.Scenario(stub,Path(d)/'out.json')
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'synthetic mid-run'):scenario.run()
            self.assertTrue(scenario.report['settingsRestored']);self.assertEqual(scenario.report['status'],'failed');self.assertTrue(any(x['sql'].startswith('BEGIN;ALTER DATABASE') and x['user']=='supabase_admin' for x in stub.calls))
    def test_restore_after_configuration_was_changed(self):
        class Stub:
            def __init__(self):self.calls=[]
            def run(self,sql,**kwargs):self.calls.append({'sql':sql,**kwargs});return '17' if 'server_version_num' in sql else 't'
            def json(self,sql,**kwargs):
                if sql==m.SETTINGS_SQL:return [{'role':None,'database':m.DATABASE,'settings':['TimeZone=UTC']}]
                return {'tap':'2026-10-05T00:00:00Z','checked':'2026-10-05T00:01:00Z'}
        class FailAfterConfig(m.Scenario):
            def auth(self,*args,**kwargs):raise RuntimeError('after committed configuration')
        stub=Stub()
        with tempfile.TemporaryDirectory() as d:
            scenario=FailAfterConfig(stub,Path(d)/'out.json')
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'after committed configuration'):scenario.run()
            self.assertTrue(scenario.report['settingsRestored']);self.assertEqual(scenario.report['status'],'failed')
            admin=[x['sql'] for x in stub.calls if x.get('user')=='supabase_admin' and x['sql'].startswith('BEGIN;')]
            self.assertEqual(admin,[m.configure_sql('database','UTC'),m.restore_sql([{'role':None,'database':m.DATABASE,'settings':['TimeZone=UTC']}])])
    def test_restore_failure_is_reported_and_propagated(self):
        class Stub:
            calls=[]
            def run(self,sql,**kwargs):
                self.calls.append({'sql':sql,**kwargs})
                if sql.startswith('BEGIN;ALTER DATABASE'):raise RuntimeError('restore unavailable')
                if 'not exists(select 1 from auth.users' in sql:raise RuntimeError('original failure')
                return '17' if 'server_version_num' in sql else 't'
            def json(self,sql,**kwargs):return []
        with tempfile.TemporaryDirectory() as d:
            scenario=m.Scenario(Stub(),Path(d)/'out.json')
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'restore unavailable'):scenario.run()
            self.assertEqual(scenario.report['status'],'failed');self.assertFalse(scenario.report['settingsRestored']);self.assertEqual(scenario.report['restorationFailure'],'restore unavailable')
    def test_runtime_sql_uses_supported_clock_and_no_fabricated_v2(self):
        with tempfile.TemporaryDirectory() as d:
            scenario=m.Scenario(None,Path(d)/'out.json');sql=scenario.clock_sql(m.uid(1),m.uid(101),m.uid(201),'2026-10-05T00:00:00.123456Z','2026-10-05T00:01:00Z',1)
            self.assertIn('public.clock_in(',sql);self.assertIn('37.123456789::double precision',sql);self.assertIn('Original note Ω',sql);self.assertIn('0,1)',sql)
        source=SCRIPT.read_text();self.assertNotIn('CREATE OR REPLACE FUNCTION',source.upper());self.assertNotIn('INSERT INTO WORK_CROSS_JOB_CLOCK_REQUESTS',source.upper());self.assertNotIn('INSERT INTO WORK_ACTIVITY_CLOCK_RECEIPTS',source.upper());self.assertNotIn('UPDATE WORK_CROSS_JOB_CONTRACT',source.upper());self.assertNotIn('CAPTURE_ENABLED=TRUE',source.upper());self.assertNotIn('SUBPROCESS.POPEN',source.upper())
    def test_ast_subprocess_single_boundary_and_no_kernel_file_write(self):
        tree=ast.parse(SCRIPT.read_text());calls=[x for x in ast.walk(tree) if isinstance(x,ast.Call) and isinstance(x.func,ast.Attribute)]
        writes=[x for x in calls if x.func.attr=='write_text'];self.assertEqual(len(writes),1)
        self.assertEqual(len([x for x in calls if x.func.attr=='execute']),1)
    def test_both_directions_all_default_modes(self):
        self.assertEqual(len(m.CASES),6)
        for mode in ('database','login_role','connection'):
            self.assertIn((mode,'UTC','America/Denver'),m.CASES);self.assertIn((mode,'America/Denver','UTC'),m.CASES)

if __name__=='__main__':unittest.main(verbosity=2)
