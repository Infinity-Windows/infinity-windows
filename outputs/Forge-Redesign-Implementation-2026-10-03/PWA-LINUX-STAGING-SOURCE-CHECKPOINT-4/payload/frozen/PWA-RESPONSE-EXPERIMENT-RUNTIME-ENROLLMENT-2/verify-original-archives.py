#!/usr/bin/env python3
"""Attest immutable failed-run bundles before observation; never build/edit them."""
import hashlib,json,sys
from pathlib import Path
assert len(sys.argv) in (3,4),"Expected archive directory, receipt path and optional exact archive profile"
base,target=map(Path,sys.argv[1:3])
profile=sys.argv[3] if len(sys.argv)==4 else "original"
assert profile in ("original","current-701","retained-300fd","current-f9"),"Unknown archive profile; refuse unpinned bundles"
expected={"old":(304,"4f1ef9bf86ef045992a1c4222fa04a03a5d7b95d2b0a6e39a4887e0434b7f828"),
 "new":(357,"f74b1a9011b426dfad33fcce470d5375ac6cda0c816f0d0ef50418d107f683ec")}
run_id,artifact=37231644970,"pwa-older-builds-and-results"
if profile=="current-701":
 expected={"old":(330,"3051b303ccc20ca5d7c6f9ac47d683643e522f4ab928910a5774f45800e15cf4"),
  "new":(330,"02cee35d453773334c5022b2e0796463727dc12f89a73c5e35942ec518f51493")}
 run_id,artifact=37241657741,"pwa-current-builds-and-results"
if profile=="retained-300fd":
 expected={"old":(304,"dfd36f1974a5ff824e123b3411990833d29c6c647ce3b27fe0fadbaf16c36696"),
  "new":(362,"325f2dae2ef7c6eaaf5c7ec3e39782a43e9f40babeb64a57210dacf684b6b08e")}
 run_id,artifact=37245259066,"pwa-older-builds-and-results"
if profile=="current-f9":
 expected={"old":(330,"231841e43bc8f3a6ef189c9976ff17f0156ba951cad82fdc6151bd946214c6c1"),
  "new":(330,"e821fb290fc6bb5a4a72fe892d5b52fd23719c3744af57e60995380377620e73")}
 run_id,artifact=37246658287,"pwa-current-builds-and-results"
report={"runId":run_id,"artifact":artifact,"profile":profile,"bundles":{}}
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
print(f"Verified exact retained failed-run bundles from {run_id}:"
      f"{expected['old'][0]} old files/{expected['new'][0]} new files; no rebuilding")
