#!/usr/bin/env python3
"""No-contact source/control-flow tests; no PostgreSQL results are simulated as evidence."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('verify-work-unit-metadata-transition-trial.py')
spec=importlib.util.spec_from_file_location('transition_trial',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TARGET='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test'
INSTANCE={'systemIdentifier':'123','postmasterStart':'456','databaseOid':'42','database':m.DATABASE,'serverVersionNum':'170006'}


def good_receipt(profile):
    return {'status':'passed','stage':'complete','checks':92,'sourceSha256':profile['sourceSha256'],'harnessSha256':profile['mainHarnessSha256'],'plan':{'timeoutsSeconds':{'statement':20,'lock':12}},'tiers':[{'additionalUnrelatedRows':n,'currentUnits':u,'samplesMs':[1.0]*20} for n in (0,1000,10000) for u in (1,10,100)],'waits':[{'case':'active_batch_payroll','observed':True,'holderWasActive':True,'controlledIdleHold':False,'stage':'reader_and_payroll_completed'}]}


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.profile,cls.bodies=m.validate_source()
    def test_reviewed_input_hashes_and_exact_transition_only_change(self):
        self.assertEqual(self.profile['candidateBodySha256'],'9f39e62075a8e002c438c0fd2e80ca7b0a8cb7eca45b221d3f59d1088814c34a')
        old=self.bodies['old-transition-block.sql'].removesuffix('\n');new=self.bodies['candidate-transition-block.sql'].removesuffix('\n')
        self.assertEqual(self.bodies['candidate-scope-body.sql'].replace(new,old,1),self.bodies['old-scope-body.sql'])
    def test_default_and_plan_no_process_db_or_output(self):
        with patch.object(m,'Session',side_effect=AssertionError('no DB')),patch.object(m,'Report',side_effect=AssertionError('no output')),patch.object(m.subprocess,'Popen',side_effect=AssertionError('no process')),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main([]),0);self.assertEqual(m.main(['--check-plan']),0)
        for line in out.getvalue().splitlines():self.assertFalse(json.loads(line)['databaseContacted'])
    def test_source_drift_refuses_before_process(self):
        with patch.object(m,'sha',return_value='0'*64),self.assertRaisesRegex(RuntimeError,'profile drift'):m.validate_source()
    def test_bad_modes_and_outputs_refused(self):
        for args in [['--check-plan','--execute-fixture'],['--check-plan','--output','/tmp/not-used'],['--execute-fixture']]:
            with self.assertRaises(RuntimeError):m.main(args)
    def test_strict_url(self):
        m.validate_url(TARGET)
        for bad in ['',TARGET.replace(':5432',''),TARGET.replace('localhost','remote'),TARGET.replace('5432','5433'),TARGET.replace('fixture-only','password'),TARGET.replace('supabase_admin','postgres'),TARGET+'?host=remote',TARGET+'#fragment',TARGET.replace('5432','oops'),TARGET.replace(m.DATABASE,'postgres')]:
            with self.subTest(url=bad),self.assertRaises(RuntimeError):m.validate_url(bad)
    def test_predecessor_count_and_all_nine_twenty_sample_tiers(self):
        good=good_receipt(self.profile);m.validate_predecessor(good,self.profile)
        for field,value in [('checks',91),('status','running'),('stage','incomplete'),('sourceSha256','bad'),('harnessSha256','bad'),('waits',[]),('tiers',good['tiers'][:-1]),('plan',{})]:
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_predecessor({**good,field:value},self.profile)
        for bad in [float('nan'),float('inf'),-1,True]:
            v=copy.deepcopy(good);v['tiers'][0]['samplesMs'][0]=bad
            with self.assertRaises(RuntimeError):m.validate_predecessor(v,self.profile)
    def test_instance_identity_requires_complete_pg17(self):
        m.validate_instance(INSTANCE)
        for value in [{**INSTANCE,'serverVersionNum':'160001'},{**INSTANCE,'database':'production'},{**INSTANCE,'extra':'x'},{}]:
            with self.assertRaises(RuntimeError):m.validate_instance(value)
    def test_owner_session_semantics_and_timeouts(self):
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        self.assertEqual(m.identity_valid(identity,INSTANCE,m.ident(1)),(1,'789'))
        for key,value in [('sessionUser','authenticator'),('currentUser','authenticated'),('superuser',True),('statementTimeout','30s'),('lockTimeout','20s'),('planCacheMode','force_custom_plan'),('standardConformingStrings','off'),('actor',m.ident(2)),('databaseOid','43')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.identity_valid({**identity,key:value},INSTANCE,m.ident(1))
    def test_native_identity_guard_and_all_six_mappings(self):
        valid='abcdefab-cdef-abcd-efab-cdefabcdefab'
        entries=[{'kind':kind,'id':valid} for kind in m.KINDS]
        self.assertEqual(len(m.keys(entries)),6);self.assertEqual(m.keys(entries*3),m.keys(entries))
        for invalid in [None,123,valid.upper(),'{'+valid+'}',valid.replace('-',''),' '+valid,valid+'\n']:
            self.assertEqual(m.keys([{'kind':'custom_work_sessions','id':invalid}]),[])
        self.assertEqual(m.keys([None,{},1,{'kind':'setup','id':valid},{'kind':'unknown','id':valid},{'kind':'custom_work_units','id':valid}]),[])
    def test_prepared_selector_is_exact_authored_parameterized_sql(self):
        for variant in ('old','candidate'):
            sql=m.selector_sql(self.bodies,variant)
            self.assertIn('$1',sql);self.assertNotIn('into normal_sources',sql);self.assertNotIn('jsonb_array_elements(sourceids)',sql)
        self.assertIn('select distinct case',m.selector_sql(self.bodies,'candidate'))
        self.assertIn("then (x->>'id')::uuid end",m.selector_sql(self.bodies,'candidate'))
    def test_main_has_one_owner_session_and_no_repair_or_planner_override(self):
        text=SCRIPT.read_text();tree=ast.parse(text)
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main');src=ast.get_source_segment(text,main)
        self.assertEqual(src.count('Session(target,report)'),1);self.assertEqual(src.count("Session(target,report,user='supabase_admin')"),1)
        for forbidden in ['create or replace function','set role ','plan_cache_mode=','create index','alter role','disable trigger']:
            self.assertNotIn(forbidden,text)
        self.assertIn("metadata_scope_transition_probe",text);self.assertIn("security invoker",text)
        self.assertIn('before_owned_main_process',text)
    def test_full_parity_holds_not_relabelled(self):
        self.assertTrue(any('184' in s for s in self.profile['held']));self.assertTrue(any('168' in s for s in self.profile['held']));self.assertTrue(any('All18' in s for s in self.profile['held']))
        self.assertEqual(len(self.profile['scopeCases']),4)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.out=Path(self.temp.name)/'new'/m.NAME;self.report=m.Report(self.out);self.p,self.b=m.validate_source()
    def test_partial_written_before_validation_failure(self):
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'fresh'/m.NAME
            with patch.object(m,'validate_source',side_effect=RuntimeError('source failed')),patch.object(m,'Session',side_effect=AssertionError('no DB')),self.assertRaisesRegex(RuntimeError,'source failed'):m.main(['--execute-fixture','--output',str(out)])
            data=json.loads(out.read_text());self.assertEqual(data['status'],'failed');self.assertFalse(data['databaseContacted'])
    def test_output_never_overwrites_and_must_be_outside_checkout(self):
        for path in [self.out,Path('relative')/m.NAME,m.ROOT/'new'/m.NAME,Path(self.temp.name)/'other'/'wrong.json']:
            with self.assertRaises(RuntimeError):m.Report(path)
    def test_case_equality_checks_whole_order_and_exact_text(self):
        good={'ms':1,'value':{'ordered':[1,2],'token':'x'},'valueText':'{"ordered": [1, 2], "token": "x"}','review':{'a':1},'reviewText':'{"a": 1}'}
        m.result_equal(good,copy.deepcopy(good))
        for field,value in [('value',{'ordered':[2,1],'token':'x'}),('valueText','different'),('review',None),('reviewText','different')]:
            with self.assertRaises(RuntimeError):m.result_equal(good,{**good,field:value})
    def test_summary_requires_actual_finite_twenty_samples(self):
        self.assertEqual(m.summary(list(range(20))),{'medianMs':9.5,'p95Ms':18,'maxMs':19})
        for bad in [[1]*19,[1]*19+[True],[1]*19+[float('nan')]]:
            with self.assertRaises(RuntimeError):m.summary(bad)
    def test_same_session_six_warmups_and_twenty_paired_calls_exclude_warmups(self):
        outer=self;calls=[]
        class T(m.Trial):
            def timed(inner,expression,label,review=False):
                calls.append((id(inner.s),label,review));value={'unit':{'id':m.ident(30)},'manifest':{'transitions':[{'id':'existing'}]}}
                return {'ms':999 if '_warmups_' in label else 2,'value':value,'valueText':m.encoded(value),'review':{'full':'review'},'reviewText':'{"full":"review"}'}
        session=object();t=T(session,self.report,self.p,self.b,INSTANCE)
        members={m.ident(30):[{'kind':'custom_work_sessions','id':m.ident(99)}]}
        t.scopes([('supported_populated_unit',[m.ident(30)],members)])
        case=self.report.data['cases'][0];self.assertEqual(len(case['warmups']),6);self.assertEqual(len(case['pairs']),20)
        self.assertEqual(len(calls),52);self.assertEqual({x[0] for x in calls},{id(session)})
        self.assertEqual(case['summary']['old']['medianMs'],2)
        self.assertEqual(case['pairs'][0]['order'],['old','candidate']);self.assertEqual(case['pairs'][1]['order'],['candidate','old'])
        self.assertTrue(all(x[2] is True for x in calls));self.assertEqual(len(list(self.out.parent.glob('supported*.json'))),26)
    def test_mismatch_preserves_full_results_before_refusal(self):
        class T(m.Trial):
            def timed(self,expression,label,review=False):
                value={'different':label.endswith('candidate')};return {'ms':1,'value':value,'valueText':m.encoded(value),'review':None,'reviewText':None}
        t=T(object(),self.report,self.p,self.b,INSTANCE)
        with self.assertRaisesRegex(RuntimeError,'Whole ordered scope'):t.scopes([('supported_populated_unit',[m.ident(30)],{m.ident(30):[]})])
        entry=self.report.data['cases'][0]['warmups'][0];self.assertEqual(entry['equality'],'pending')
        full=json.loads(Path(entry['fullResults']['path']).read_text());self.assertIn('old',full);self.assertIn('candidate',full)
    def test_prepared_plans_before_and_after_six_executes_same_session(self):
        calls=[]
        class S:
            def query(self,sql,label):calls.append(('query',sql,label));return ''
        class T(m.Trial):
            def plan(self,sql,label):calls.append(('plan',sql,label));return [{'Plan':{'mock':True}}]
            def query(self,sql,label):calls.append(('json',sql,label));return [] if sql.startswith('execute') else {'genericPlans':0,'customPlans':7,'parameterTypes':'{jsonb}'}
        t=T(S(),self.report,self.p,self.b,INSTANCE);units=[m.ident(30)];t.plans([('supported_populated_unit',units,{units[0]:[{'kind':'custom_work_sessions','id':m.ident(99)}]}),('existing_empty_key_unit',units,{units[0]:[]})])
        self.assertEqual(len(t.prepared),2)
        for record in self.report.data['plans']:
            self.assertEqual(len(record['warmupExecutions']),6);self.assertTrue(record['notInternalPLpgSQLPlan'])
        self.assertEqual(sum(c[0]=='plan' for c in calls),8);self.assertEqual(sum(c[0]=='json' and c[1].startswith('execute') for c in calls),24)
        self.assertTrue(all('$1' in c[1] and '(jsonb)' in c[1] for c in calls if c[0]=='query'))
    def test_primary_and_cleanup_error_persist_without_masking(self):
        outer=self
        class T(m.Trial):
            def admit(inner):raise ValueError('original failure')
            def cleanup(inner):
                saved=json.loads(outer.out.read_text());outer.assertEqual(saved['primaryFailure']['message'],'original failure');raise RuntimeError('cleanup failure')
        with self.assertRaisesRegex(ValueError,'original failure'):T(None,self.report,self.p,self.b,INSTANCE).run()
        saved=json.loads(self.out.read_text());self.assertEqual(saved['cleanupFailure']['message'],'cleanup failure');self.assertEqual(saved['primaryFailure']['type'],'ValueError')
    def test_timing_clock_ends_before_review_and_quote_safe_do(self):
        calls=[]
        class T(m.Trial):
            def query(self,sql,label):calls.append(sql);return {'ms':0.25,'value':None,'valueText':None,'review':None,'reviewText':None}
        t=T(None,self.report,self.p,self.b,INSTANCE)
        t.timed(m.json_literal({'untrusted':"$measure$'; select 99; --"}),'synthetic',review='batch')
        sql=calls[0];self.assertIn(";do 'declare",sql);self.assertNotIn(';do $measure$',sql)
        self.assertLess(sql.index('ms:=extract'),sql.index('_work_unit_metadata_review'))
        self.assertIn('with ordinality',sql);self.assertIn("''; select 99; --",sql)
        t.plan("execute metadata_trial_old('[]'::jsonb)",'prepared')
        self.assertIn(";do 'declare",calls[1]);self.assertIn('explain(analyze,buffers,verbose,format json) execute',calls[1])
    def test_authored_owner_attributes_refuse_before_clone(self):
        calls=[];outer=self
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        class S:
            def query(self,sql,label):calls.append((sql,label));return ''
        class T(m.Trial):
            def query(self,sql,label):
                calls.append((sql,label))
                if label=='owner_identity_before':return identity
                return {**m.expected_metadata('_work_unit_metadata_scope',outer.b['old-scope-body.sql']),'definer':False}
        with self.assertRaisesRegex(RuntimeError,'Exact authored body'):T(S(),self.report,self.p,self.b,INSTANCE).admit()
        self.assertFalse(any('create function' in sql for sql,_ in calls))
        lock=next(sql for sql,label in calls if label=='G7712_before_A7710')
        self.assertLess(lock.index('7712'),lock.index('7710'))
    def test_membership_profile_keeps_whole_helper_one_ten_hundred(self):
        calls=[]
        class T(m.Trial):
            def plan(self,sql,label):calls.append(('plan',sql,label));return [{'Plan':{'mock':True}}]
            def query(self,sql,label):calls.append(('query',sql,label));return {'versions':0}
            def timed(self,expression,label,review=False):
                calls.append(('timed',expression,label));size=int(label.split('_')[1]);return {'ms':1,'value':self.case_data[size][1],'valueText':'{}'}
        t=T(None,self.report,self.p,self.b,INSTANCE)
        for size in (1,10,100):
            units=[m.ident(1000+n) for n in range(size)];t.case_data[size]=(units,{u:[] for u in units})
        t.members_profile()
        self.assertEqual([r['size'] for r in self.report.data['membershipProfiles']],[1,10,100])
        self.assertTrue(all(len(r['warmups'])==6 and len(r['samples'])==20 for r in self.report.data['membershipProfiles']))
        for kind,sql,label in calls:
            if kind=='plan':self.assertIn('with versions as materialized',sql);self.assertNotIn('p_units',sql)
            if kind=='query':self.assertIn('(select count(*) from versions)',sql);self.assertIn('(select count(*) from selected)',sql)
    def test_cleanup_failure_after_success_is_fatal(self):
        class T(m.Trial):
            def admit(self):pass
            def capture_members(self):return []
            def plans(self,*a):pass
            def scopes(self,*a):pass
            def members_profile(self):pass
            def guard_profile(self):pass
            def guard(self):pass
            def query(self,sql,label):return {} if label=='final_census' else identity
            def cleanup(self):raise RuntimeError('cleanup only')
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        self.report.data['baselineCensus']={};t=T(None,self.report,self.p,self.b,INSTANCE);t.identity=(1,'789')
        with self.assertRaisesRegex(RuntimeError,'cleanup only'):t.run()
        self.assertNotEqual(self.report.data['status'],'passed_limited_characterization');self.assertFalse(self.report.data['fixtureExecuted'])
    def test_rollback_and_explicit_prepared_temp_cleanup(self):
        calls=[]
        class S:
            def query(self,sql,label):calls.append(sql)
            def json(self,sql,label):calls.append(sql);return True
        t=m.Trial(S(),self.report,self.p,self.b,INSTANCE);t.prepared=['metadata_trial_old','metadata_trial_candidate'];t.cleanup()
        self.assertEqual(calls[:3],['rollback','deallocate metadata_trial_old','deallocate metadata_trial_candidate']);self.assertTrue(self.report.data['cleanup']['temporaryObjectsAbsent'])
    def test_owned_predecessor_is_executed_and_instance_bound(self):
        outer=self;calls=[]
        class Admin:
            def json(self,sql,label):calls.append(label);return True if label=='main_not_preinstalled' else INSTANCE
        class Process:
            def wait(self,timeout):return 0
            def poll(self):return 0
        def launch(args,**kw):
            saved=json.loads(outer.out.read_text());outer.assertEqual(saved['stage'],'before_owned_main_process')
            Path(kw['env']['WORK_UNIT_METADATA_COHORTS_PG_OUT']).write_text(json.dumps(good_receipt(outer.p)))
            outer.assertEqual(args,[m.sys.executable,str(m.ROOT/m.MAIN)]);return Process()
        got=m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),launch)
        self.assertEqual(got,INSTANCE);self.assertEqual(calls,['instance_before_main','main_not_preinstalled','instance_after_main']);self.assertFalse(self.report.data['predecessor']['budgetAcceptance'])
    def test_preinstalled_main_refused_without_process(self):
        class Admin:
            def json(self,sql,label):return INSTANCE if label=='instance_before_main' else False
        with self.assertRaisesRegex(RuntimeError,'0848 absent'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),lambda *a,**k: self.fail('must not launch'))
    def test_predecessor_primary_and_cleanup_failures_both_retained(self):
        outer=self
        class Admin:
            def json(self,sql,label):return INSTANCE if label=='instance_before_main' else True
        class P:
            def wait(self,timeout):raise ValueError('predecessor failure')
            def poll(self):return None
            def kill(self):
                outer.assertEqual(json.loads(outer.out.read_text())['predecessorPrimaryFailure']['message'],'predecessor failure')
                raise RuntimeError('predecessor cleanup failure')
        with self.assertRaisesRegex(ValueError,'predecessor failure'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),lambda *a,**k:P())
        saved=json.loads(self.out.read_text());self.assertEqual(saved['predecessorCleanupFailure']['message'],'predecessor cleanup failure')
    def test_predecessor_instance_change_refuses(self):
        outer=self
        class Admin:
            def json(self,sql,label):return True if label=='main_not_preinstalled' else ({**INSTANCE,'postmasterStart':'999'} if label=='instance_after_main' else INSTANCE)
        class P:
            def wait(self,timeout):return 0
            def poll(self):return 0
        def launch(*a,**kw):Path(kw['env']['WORK_UNIT_METADATA_COHORTS_PG_OUT']).write_text(json.dumps(good_receipt(outer.p)));return P()
        with self.assertRaisesRegex(RuntimeError,'instance changed'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),launch)
    def test_persistent_transport_one_process_multiple_queries_and_pre_wait_receipt(self):
        outer=self;launched=[]
        class Process:
            def __init__(self,**kw):self.kw=kw;self.returncode=None;self.stdin=self
            def write(self,text):
                if text=='\\q\n':self.returncode=0;return
                saved=json.loads(outer.out.read_text());outer.assertEqual(saved['calls'][-1]['status'],'waiting')
                marker=re.search(r'\\echo (trial_done_\d+)',text)[1];self.kw['stdout'].seek(0,2);self.kw['stdout'].write('true\n'+marker+'\n');self.kw['stdout'].flush()
            def flush(self):pass
            def poll(self):return self.returncode
            def wait(self,timeout):return self.returncode
        def launch(args,**kw):launched.append((args,kw));return Process(**kw)
        with patch.dict(os.environ,{'PGHOST':'unsafe','PGOPTIONS':'-c role=authenticated'}):s=m.Session(m.validate_url(TARGET),self.report,launch=launch)
        self.assertTrue(s.json('select true','first'));self.assertTrue(s.json('select true','second'));s.close()
        self.assertEqual(len(launched),1);self.assertNotIn('PGHOST',launched[0][1]['env']);self.assertNotIn('PGOPTIONS',launched[0][1]['env']);self.assertEqual(len(self.report.data['calls']),2)
    def test_transport_timeout_is_bounded_and_partial_survives(self):
        class P:
            returncode=None
            def __init__(self):self.stdin=self
            def write(self,*a):pass
            def flush(self):pass
            def poll(self):return None
        s=m.Session(m.validate_url(TARGET),self.report,launch=lambda *a,**k:P())
        with patch.object(m.time,'monotonic',side_effect=[0,36,37]),self.assertRaisesRegex(RuntimeError,'35 seconds'):s.query('select true','blocked')
        self.assertEqual(json.loads(self.out.read_text())['calls'][-1]['status'],'waiting');s.out.close();s.err.close()


if __name__=='__main__':unittest.main(verbosity=2)
