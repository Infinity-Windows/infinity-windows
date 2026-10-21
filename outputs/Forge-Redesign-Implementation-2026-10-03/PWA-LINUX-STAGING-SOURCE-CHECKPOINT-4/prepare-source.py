"""One-time output-only authoring receipt; no install/build/runtime invocation."""
from pathlib import Path
import hashlib,json,subprocess,shutil,difflib
O=Path(__file__).resolve().parent; B=O.parent
R='PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2'; P='PWA-F9-WORKER-PARITY-REHEARSAL-1'
sha=lambda b:hashlib.sha256(b).hexdigest()
def put(p,b):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
def inv(root):
 out={}
 for p in sorted(root.rglob('*')):
  assert not p.is_symlink(),p
  if p.is_file():out[p.relative_to(root).as_posix()]={'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())}
 return out
def dump(p,x):put(p,(json.dumps(x,indent=2)+'\n').encode())
frozen=inv(B/R); man=json.loads((B/R/'MANIFEST.json').read_text())
assert frozen['MANIFEST.json']['sha256']=='f9a6acc93ca66e3d9a329567fc62a0c42db4406fc1fc5d1ce11ace6daa96741c'
assert {k:v for k,v in frozen.items() if k!='MANIFEST.json'}==man['files']
payload=O/'payload';payload.mkdir() # One-time authoring; never overwrite an existing package.
shutil.copytree(B/R,payload/'frozen'/R)
shutil.copytree(B/R,payload/R)
for f in (payload/R).rglob('*'):
 if f.is_file():f.chmod(0o644)
c=payload/R/'app/playwright.pwa.config.ts'; s=c.read_text();assert s.count('command: `${shellQuote')==1;c.write_text(s.replace('command: `${shellQuote','command: `exec ${shellQuote'))
c=payload/R/'start-verified-harness.mjs';s=c.read_text();s=s.replace('let interrupted=false;','let parentSignalObserved=false;').replace('interrupted=true;child.kill(signal);','parentSignalObserved=true;child.kill(signal);')
s=s.replace("try{attest('after');writeFileSync", "try{attest('after');const childExitSignal=signal;const interrupted=parentSignalObserved||childExitSignal==='SIGTERM';writeFileSync")
s=s.replace('JSON.stringify({code,signal,interrupted})','JSON.stringify({code,signal,interrupted,parentSignalObserved,childExitSignal})');c.write_text(s)
changed=inv(payload/R); diff=[]
for f in frozen:
 if frozen[f]!=changed[f]:diff+=list(difflib.unified_diff((B/R/f).read_text().splitlines(True),(payload/R/f).read_text().splitlines(True),fromfile='frozen/'+f,tofile='source/'+f))
assert set(f for f in frozen if frozen[f]!=changed[f])=={'app/playwright.pwa.config.ts','start-verified-harness.mjs'}
put(O/'RUNTIME-SOURCE-DIFF.patch',''.join(diff).encode())
proposal=B/'PWA-LINUX-EXECUTION-STAGING-PROPOSAL-2'
for f in ['CHANGE-ALLOWLIST.json','TRANSPORT-INVENTORY.json','COMMITTED-DEPENDENCY-PINS.json','ABSOLUTE-PATH-INVENTORY.json','PROPOSAL.md','MANIFEST.json']:
 put(payload/'provenance'/'plan2'/f,(proposal/f).read_bytes())
put(payload/'provenance'/'plan2-root-receipt.json',(B/'PWA-LINUX-STAGING-PLAN-2-ROOT-RECEIPT.json').read_bytes())
pins=json.loads((B/R/'RUNTIME-PINS.json').read_text());commit=pins['sourceHead'];repo=B.parent.parent/'project-pwa-diagnostic';objects={}
for f,item in pins['originalSources'].items():
 spec=commit+':app/'+f;b=subprocess.check_output(['git','-C',str(repo),'show',spec]);assert sha(b)==item['sha256']
 put(payload/'source-a703'/'app'/f,b);objects['app/'+f]={'gitObject':subprocess.check_output(['git','-C',str(repo),'rev-parse',spec],text=True).strip(),'sha256':sha(b),'commit':commit}
for f,h in [('package.json','ca24a5be8471785a53bf8fa458b1abf503d96f115a200024842a17037e5bc8df'),('package-lock.json','b73730093a563941c1ead405d43537467a171733d27a14ca358467c41765b663')]:
 spec=commit+':app/'+f;b=subprocess.check_output(['git','-C',str(repo),'show',spec]);assert sha(b)==h;put(payload/'dependencies'/'app'/f,b)
 objects['app/'+f]={'gitObject':subprocess.check_output(['git','-C',str(repo),'rev-parse',spec],text=True).strip(),'sha256':h,'commit':commit}
b=Path(pins['traceReceiptPath']).read_bytes();assert sha(b)==pins['traceReceiptSha256'];put(payload/'provenance'/'browser-engine-receipt.json',b)
dump(payload/'provenance'/'GIT-OBJECTS.json',objects)
transport=json.loads((proposal/'TRANSPORT-INVENTORY.json').read_text())
for mode,v in transport['derivativeInputs'].items():
 for key,dest in [('manifest',f'DERIVED-{mode}-MANIFEST.json'),('worker',f'workers/{mode}/sw.js')]:
  b=Path(v[key]).read_bytes();assert sha(b)==v[key+'Sha256'];put(payload/P/dest,b)
orig=B/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'
originals={}
for side in ['old','new']:
 originals[side]=inv(orig/(side+'-dist'))
 hashes={k:v['sha256'] for k,v in originals[side].items()}
 assert len(hashes)==330 and sha(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode())==pins['originalCompact'][side]
 shutil.copytree(orig/(side+'-dist'),payload/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'/(side+'-dist'))
derived={mode:inv(B/P/'derived-pairs'/mode) for mode in ['off','baseline','blob','stream']}
dump(O/'INPUTS-BEFORE.json',{'runtime':frozen,'originals':originals,'derivedPairs':derived,'delta':inv(payload/P)})
dump(payload/'provenance'/'FROZEN-FILES.json',frozen);dump(payload/'provenance'/'SOURCE-FILES.json',changed)
print(json.dumps({'runtimeFiles':len(frozen),'changedSourceFiles':[f for f in frozen if frozen[f]!=changed[f]],'originalFiles':sum(len(x) for x in originals.values()),'payloadBytes':sum(v['bytes'] for v in inv(payload).values())}))
