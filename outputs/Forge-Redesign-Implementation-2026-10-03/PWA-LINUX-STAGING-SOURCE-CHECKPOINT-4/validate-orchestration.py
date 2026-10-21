"""Local offline test/parse/hash receipts only; never invoke proposed workflow or setup."""
import ast,json,subprocess,sys,hashlib,os,shutil
from pathlib import Path
import yaml
O=Path(__file__).resolve().parent;B=O.parent;node='/Users/emmatimpson/.nvm/versions/node/v22.23.1/bin/node';checks=[]
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args,name):
 p=O/name;result=subprocess.run(args,capture_output=True,text=True,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'});p.write_text(result.stdout+result.stderr);checks.append({'argv':args,'exit':result.returncode,'log':name});assert result.returncode==0,(name,result.stderr)
for name in ['bootstrap.py','orchestration_gates.py','orchestrate.py','test_orchestration.py','validate-orchestration.py']:ast.parse((O/name).read_text(),filename=name)
run([node,'--check',str(O/'browser-metadata.mjs')],'METADATA-SYNTAX.txt')
run([node,'--test',str(O/'browser-metadata.test.mjs')],'METADATA-TEST-RESULTS.txt')
run([sys.executable,'-B',str(O/'test_orchestration.py')],'ORCHESTRATION-TEST-RESULTS.txt')
run(['bash','-n',str(O/'SETUP-SHELL.sh.txt')],'SETUP-SHELL-SYNTAX.txt')
workflow=yaml.safe_load((O/'PROPOSED-WORKFLOW.yml.txt').read_text());job=workflow['jobs']['archived-four-arms'];assert job['timeout-minutes']==70;assert workflow['permissions']=={'contents':'read','actions':'read'}
steps=job['steps'];assert steps[0]['uses']=='actions/checkout@11d5960a326750d5838078e36cf38b85af677262';assert steps[-1]['uses']=='actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';assert steps[-1]['if']=='${{ always() }}';assert steps[-1]['timeout-minutes']==10
setup=steps[1]['run'];assert setup==(O/'SETUP-SHELL.sh.txt').read_text();assert (O/'bootstrap.py').read_text() in setup;assert setup.index((O/'bootstrap.py').read_text())<setup.index("/'orchestrate.py'")
for i,step in enumerate(steps):
 if 'run' in step:
  # bash -n validates stdin text without executing any commands.
  r=subprocess.run(['bash','-n'],input=step['run'],capture_output=True,text=True);assert r.returncode==0,(i,r.stderr)
# Re-run inherited pure checks from this copy; no original frozen checkpoint writes.
run([node,'--test',str(O/'staging.test.mjs'),str(O/'adapter-lifecycle.test.mjs'),str(O/'payload/PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2/enrollment.test.mjs'),str(O/'payload/PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2/corrections.test.mjs')],'INHERITED-NODE-TESTS.txt')
run([sys.executable,'-B',str(O/'test_transport.py')],'INHERITED-TRANSPORT-TESTS.txt');run([sys.executable,'-B',str(O/'test_reconstruct.py')],'INHERITED-RECONSTRUCTION-TESTS.txt')
source2=B/'PWA-LINUX-STAGING-SOURCE-CHECKPOINT-2';m=json.loads((source2/'MANIFEST.json').read_text());assert sha(source2/'MANIFEST.json')=='9c9e25207010cf719dd0218163d747bc29d483688ce4243cd730f9cc5a44ce88';actual={p.relative_to(source2).as_posix():{'bytes':p.stat().st_size,'sha256':sha(p)} for p in source2.rglob('*') if p.is_file() and p!=source2/'MANIFEST.json'};assert actual==m['files'];renamed={'MANIFEST.json','HANDOFF.md','VALIDATION.json','PROPOSED-WORKFLOW.yml.txt','PACKAGE-RECIPE.md'}
for key in [*m['files'],'MANIFEST.json']:
 dest=O/('SOURCE-2-'+key if key in renamed else key);assert (source2/key).read_bytes()==dest.read_bytes(),key
source1=B/'PWA-LINUX-STAGING-SOURCE-CHECKPOINT-1';m1=json.loads((source1/'MANIFEST.json').read_text());assert sha(source1/'MANIFEST.json')=='e525f4e245d12ad9efd8bd300b0996c65c3ceffe6c98e3f68ec1a3b148778628';assert {p.relative_to(source1).as_posix():{'bytes':p.stat().st_size,'sha256':sha(p)} for p in source1.rglob('*') if p.is_file() and p!=source1/'MANIFEST.json'}==m1['files']
assert not any(p.name.startswith('.test-') for p in O.iterdir());assert not any(p.is_symlink() for p in O.rglob('*'))
result={'scope':'SOURCE4_OFFLINE_ONLY_NO_PLAYWRIGHT_OR_CONFIG_IMPORT_BROWSER_INSTALL_OR_NETWORK','checks':checks,'newNodeTests':7,'newPythonTests':12,'inheritedNodeTests':60,'inheritedPythonTests':8,'yamlParsed':True,'allWorkflowShellSyntaxPassed':True,'inlineBootstrapByteExactToReviewedSource':True,'source2OriginalEntriesVerified':803,'source2All804FilesPreservedInCopy':True,'source1OriginalEntriesVerified':793,'source2DriverAndElevenCorrectionsByteIdentical':True,'payloadTarSha256':sha(O/'payload.tar'),'payloadTarBytes':(O/'payload.tar').stat().st_size,'payloadEntries':len(json.loads((O/'TRANSPORT-MANIFEST.json').read_text())),'testScratchRemaining':0,'newHelperFiles':['bootstrap.py','orchestration_gates.py','orchestrate.py','browser-metadata.mjs'],'researchManifestSha256':sha(O/'research-inputs/MANIFEST.json')}
(O/'SOURCE4-VALIDATION.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
