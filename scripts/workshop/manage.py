#!/usr/bin/env python3
"""Workshop-only SQL transport. The write target is fixed in its manifest.

Token values stay in private curl config files, never command arguments/logs.
There is no production write option. Responses are private files.
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path.home()/".config/forge-workshop"
PRODUCTION={"czprjcskmzzagdztqonm","jvsyhtarnvmdilsgksdi"}

def target(manifest):
    ref=manifest["supabase_project_ref"]
    if ref in PRODUCTION or ref != "magcghmnbjiukidyalxd":
        raise ValueError("Refusing any target other than this workshop's exact project")
    if manifest["supabase_url"] != f"https://{ref}.supabase.co":
        raise ValueError("Workshop identity mismatch")
    return ref

def stage_query(sql, output):
    ref=target(json.loads((ROOT/"workshop/manifest.json").read_text()))
    PRIVATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile('w',dir=PRIVATE,delete=False) as c:
        c.write('header = "Authorization: Bearer '+(PRIVATE/'staging-management-token').read_text().strip()+'"\nheader = "Content-Type: application/json"\n'); config=Path(c.name)
    with tempfile.NamedTemporaryFile('w',dir=PRIVATE,delete=False) as b:
        json.dump({"query":sql},b);body=Path(b.name)
    try:
        output.parent.mkdir(parents=True,exist_ok=True)
        output.touch(mode=0o600,exist_ok=True);os.chmod(output,0o600)
        r=subprocess.run(['curl','--silent','--show-error','--config',str(config),'-X','POST',f'https://api.supabase.com/v1/projects/{ref}/database/query','--data-binary','@'+str(body),'--output',str(output),'--write-out','%{http_code}'],text=True,capture_output=True,timeout=120)
        if r.returncode or r.stdout not in ('200','201'):
            raise RuntimeError(f"Workshop query failed with HTTP {r.stdout}; private response saved")
        return json.loads(output.read_text())
    finally:
        config.unlink(missing_ok=True);body.unlink(missing_ok=True)

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('sql',type=Path);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    stage_query(args.sql.read_text(),args.out)
    print('Workshop-only query completed; response saved privately')
if __name__=='__main__':main()
