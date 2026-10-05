"""Future pre-list/per-arm verifier. Only reads stage; no config imports."""
import json,sys,os
from pathlib import Path
from transport import sha,require,inventory,load_manifest,no_link_ancestors,verify_tree
from reconstruct import R,P
O=Path(__file__).resolve().parent

def verify_stage(scratch):
 s=no_link_ancestors(scratch); pins= json.loads((O/'PACKAGE-PINS.json').read_text())
 m=load_manifest(O/'TRANSPORT-MANIFEST.json',pins['manifestSha256'])
 # Frozen, provenance sources, delta, originals, dependency manifests all exact.
 for root in ['frozen','source-a703','PWA-F9-CURRENT-FAIL-ARTIFACT',P]:
  expected={k[len(root)+1:]:v for k,v in m.items() if k.startswith(root+'/')}
  if root==P:
   for mode in ['off','baseline','blob','stream']:
    raw=(s/P/f'DERIVED-{mode}-MANIFEST.json').read_bytes();require(sha(raw)==m[f'{P}/DERIVED-{mode}-MANIFEST.json']['sha256'],'manifest changed')
    manifest=json.loads(raw)
    for side in ['old','new']:
     entries=inventory(s/P/'derived-pairs'/mode/(side+'-dist'));require(len(entries)==330,'330 required')
     require({k:v['sha256'] for k,v in entries.items()}==manifest[side]['sha256'],'derived mismatch')
     for k,v in entries.items():expected[f'derived-pairs/{mode}/{side}-dist/{k}']=v
  verify_tree(s/root,expected)
 for k,v in m.items():
  if k.startswith(('provenance/','dependencies/')):
   p=no_link_ancestors(s/k);require(p.is_file() and p.stat().st_nlink==1,'missing/special input');require({'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())}==v,'provenance/dependency manifest changed')
 # Sole runtime link; no other links, extra files or directories allowed.
 runtime=s/R;link=runtime/'app/node_modules';require(link.is_symlink(),'missing sole dependency link');dep=s/'dependencies/app/node_modules';no_link_ancestors(dep);require(link.resolve()==dep,'wrong dependency link')
 expected={k[len(R)+1:]:v for k,v in m.items() if k.startswith(R+'/')};actual={};dirs=set()
 for base,sub,files in os.walk(runtime,followlinks=False):
  for name in sub+files:
   p=Path(base)/name;rel=p.relative_to(runtime).as_posix()
   if p==link:continue
   require(not p.is_symlink(),'extra runtime symlink')
   if p.is_dir():dirs.add(rel)
   else:require(p.is_file() and p.stat().st_nlink==1,'special runtime file');actual[rel]={'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())}
 original=json.loads((s/'frozen'/R/'RUNTIME-PINS.json').read_text());bound=json.loads((runtime/'RUNTIME-PINS.json').read_text());want=json.loads(json.dumps(original))
 rekey=lambda p:str(dep/p.split('/node_modules/')[1]);want['playwrightCLI']=rekey(original['playwrightCLI']);want['runtimeSources']={rekey(k):v for k,v in original['runtimeSources'].items()}
 require(len(want['runtimeSources'])==7 and bound==want,'unauthorized pin mutation')
 expected['RUNTIME-PINS.json']=actual['RUNTIME-PINS.json'] # Value-exact comparison above, not a hash waiver.
 probe=O/'resolution-probe.mjs';expected['app/resolution-probe.mjs']={'bytes':probe.stat().st_size,'sha256':sha(probe.read_bytes())}
 require(actual==expected,'runtime missing/extra/hash mismatch')
 expected_dirs={str(p) for name in expected for p in Path(name).parents if str(p)!='.'};require(dirs==expected_dirs,'runtime extra directory')
 for file,h in bound['runtimeSources'].items():p=no_link_ancestors(file);require(p.is_file() and sha(p.read_bytes())==h,'installed runtime hash changed')
 return {'sourceFiles':len(expected),'soleLink':str(link),'originalFiles':660,'derivedPairs':4,'runtimePinsPathOnly':True}
if __name__=='__main__':
 require(len(sys.argv)==2,'scratch required');print(json.dumps(verify_stage(sys.argv[1])))
