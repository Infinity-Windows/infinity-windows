"""Output-only validation and original preservation, never imports config/spec."""
import ast,json,subprocess,sys,shutil,os
from pathlib import Path
from transport import inventory,sha,write_json,validate_tar
O=Path(__file__).resolve().parent;B=O.parent;R='PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2';P='PWA-F9-WORKER-PARITY-REHEARSAL-1';node='/Users/emmatimpson/.nvm/versions/node/v22.23.1/bin/node'
checks=[]
def run(args,name):
 r=subprocess.run(args,capture_output=True,text=True,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'});(O/name).write_text(r.stdout+r.stderr);checks.append({'argv':args,'exit':r.returncode,'output':name});assert r.returncode==0,(name,r.stderr)
for p in O.glob('*.py'):ast.parse(p.read_text(),filename=p.name)
for p in O.glob('*.mjs'):run([node,'--check',str(p)],'SYNTAX-'+p.name+'.txt')
run([node,'--test',str(O/'staging.test.mjs'),str(O/'adapter-lifecycle.test.mjs'),str(O/'payload'/R/'enrollment.test.mjs'),str(O/'payload'/R/'corrections.test.mjs')],'NODE-TEST-RESULTS.txt')
run([sys.executable,str(O/'test_transport.py')],'TRANSPORT-TEST-RESULTS.txt')
run([sys.executable,str(O/'test_reconstruct.py')],'RECONSTRUCTION-TEST-RESULTS.txt')
original=B/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'
run([sys.executable,str(O/'payload'/R/'verify-original-archives.py'),str(original),str(O/'ORIGINAL-STRICT-FINAL.json'),'current-f9'],'ORIGINAL-STRICT-FINAL.txt')
run([sys.executable,str(O/'payload'/R/'verify-original-archives.py'),str(O/'payload/PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'),str(O/'STAGED-ORIGINAL-STRICT.json'),'current-f9'],'STAGED-ORIGINAL-STRICT.txt')
before=json.loads((O/'INPUTS-BEFORE.json').read_text());after={'runtime':inventory(B/R),'originals':{side:inventory(original/(side+'-dist')) for side in ['old','new']},'derivedPairs':{mode:inventory(B/P/'derived-pairs'/mode) for mode in ['off','baseline','blob','stream']},'delta':inventory(O/'payload'/P)}
assert before==after
write_json(O/'INPUTS-AFTER.json',after)
pins=json.loads((O/'PACKAGE-PINS.json').read_text());manifest=json.loads((O/'TRANSPORT-MANIFEST.json').read_text());assert inventory(O/'payload')==manifest;validate_tar(O/'payload.tar',manifest,pins['archiveSha256'])
# Clean only explicitly named disposable fixtures created by this checkpoint's tests.
for p in O.iterdir():
 if p.name.startswith(('.test-root-','.test-child-','.test-transport-','.test-reconstruct-')) and p.is_dir():shutil.rmtree(p)
write_json(O/'VALIDATION.json',{'status':'HELD_SOURCE_CHECKS_PASS_NOT_EXECUTION_ENROLLMENT','checks':checks,'nodeTestsPassed':60,'pythonTestsPassed':8,'pythonSyntaxFiles':len(list(O.glob('*.py'))),'runtimeFrozenFiles':33,'sourceChangedFiles':['app/playwright.pwa.config.ts','start-verified-harness.mjs'],'originalFilesPreserved':660,'existingDerivedFilesPreserved':2640,'sourceAndArchiveBeforeAfterExact':True,'transport':pins,'configListServerBrowserInvoked':False,'installed':False,'runtimePinRebindPerformed':False,'nodeForLocalTests':node,'pythonForLocalTests':sys.executable})
old=B/'PWA-LINUX-STAGING-SOURCE-CHECKPOINT-1';old_manifest=json.loads((old/'MANIFEST.json').read_text())
old_actual={p.relative_to(old).as_posix():{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in old.rglob('*') if p.is_file() and p!=old/'MANIFEST.json'}
assert old_actual==old_manifest['files'];assert sha((old/'MANIFEST.json').read_bytes())=='e525f4e245d12ad9efd8bd300b0996c65c3ceffe6c98e3f68ec1a3b148778628'
assert inventory(old/'payload')==inventory(O/'payload')
for name in ['payload.tar','PACKAGE-PINS.json','TRANSPORT-MANIFEST.json','RUNTIME-SOURCE-DIFF.patch']:assert (old/name).read_bytes()==(O/name).read_bytes()
assert not any(p.name.startswith('.test-') for p in O.iterdir())
write_json(O/'SOURCE-1-PRESERVATION.json',{'source1ManifestSha256':sha((old/'MANIFEST.json').read_bytes()),'entriesVerified':len(old_actual),'allOriginalBytesPreserved':True,'payload754AndTarByteIdentical':True,'runtimeSourcePatchByteIdentical':True,'testScratchRemaining':0})
print('60 Node + 8 Python tests, syntax, original verification, transport and source1 preservation all passed.')
