#!/usr/bin/env python3
"""Attest immutable failed-run bundles before observation; never build/edit them."""
import hashlib,json,sys
from pathlib import Path
assert len(sys.argv)==3,"Expected archive directory and receipt path"
base,target=map(Path,sys.argv[1:])
expected={"old":(304,"4f1ef9bf86ef045992a1c4222fa04a03a5d7b95d2b0a6e39a4887e0434b7f828"),
 "new":(357,"f74b1a9011b426dfad33fcce470d5375ac6cda0c816f0d0ef50418d107f683ec")}
report={"runId":37231644970,"artifact":"pwa-older-builds-and-results","bundles":{}}
for kind,(count,digest) in expected.items():
 folder=base/(kind+"-dist")
 assert folder.is_dir(),f"Missing archived {kind} directory; refuse fallback rebuild"
 for required in ("index.html","sw.js","version.json"):
  assert (folder/required).is_file(),f"Missing archived {kind}/{required}"
 items={str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob("*")) if p.is_file()}
 actual=hashlib.sha256(json.dumps(items,sort_keys=True,separators=(",",":")).encode()).hexdigest()
 assert (len(items),actual)==(count,digest),(kind,len(items),actual,"Archived bundle differs")
 report["bundles"][kind]={"files":len(items),"manifestSha256":actual,"sha256":items}
target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(report,indent=2)+"\n")
print("Verified exact retained failed-run bundles:304 old files/357 new files; no rebuilding")
