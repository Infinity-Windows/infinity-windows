#!/usr/bin/env python3
"""Read-only source inventory; candidate hits are not semantic release approval."""
from pathlib import Path
import json,re,hashlib
root=Path(__file__).resolve().parent.parent
items=[]
for folder in ['app/src','supabase/functions','scripts']:
 for p in sorted((root/folder).rglob('*')):
  if not p.is_file() or p.suffix not in ['.ts','.tsx','.mjs','.py','.sql'] or 'work-cross-job' in p.name or 'fixtures' in p.parts:continue
  text=p.read_text(errors='replace')
  if 'time_shifts' not in text:continue
  lines=text.splitlines();hits=[{'line':i+1,'text':v.strip()[:240]} for i,v in enumerate(lines) if 'time_shifts' in v or ('project_id' in v or 'cost_code_id' in v)]
  if not any('project_id' in v or 'cost_code_id' in v for v in lines):continue
  items.append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'candidateLocations':hits,'status':'semantic audit pending; v2 production prevented by immutable false admission','requiredDisposition':'retain person payroll semantics or adopt allocation projection or explicitly fence old job attribution'})
# Actual source definitions, not migration-history duplicates. The source fixture
# and generated manifest are both included in the exact old catalog preflight.
fixture=(root/'scripts/fixtures/work-activity-engine-online-schema.sql').read_text()
routines=[]
pattern=re.compile(r'^create (?:or replace )?function (?:public\.)?([a-z_][a-z0-9_]*)\([\s\S]*?\bas\s+(\$[a-z0-9_]*\$)',re.M|re.I)
for m in pattern.finditer(fixture):
 end=fixture.find(m[2],m.end());body=fixture[m.end():end]
 if 'time_shifts' in body and ('project_id' in body or 'cost_code_id' in body):
  routines.append({'name':m[1],'line':fixture.count('\n',0,m.start())+1,'bodySha256':hashlib.sha256(body.encode()).hexdigest(),'status':'legacy body requires attribution or retained-payroll classification before v2 activation'})
out={'status':'exhaustive textual candidate inventory; semantic release disposition intentionally pending','sourceRevision':'7016866e35e0b0c8f3a9de5735df4a736559665f','files':items,'fixtureRoutines':routines,'cachedClients':{'status':'not executed','required':['Classic raw time-shift queries','old installed PWA and existing tabs','old v1 activity journal/paid-chain/photo outbox','version2 snapshot/receipt parsers','native Work final selection and explicit recovery']},'fences':{'v2Production':'_work_cross_job_enabled() is immutable SQL false; terminal migration rollback','v1ActivityOnV2':'unapplied commands refuse before legacy setup retag; existing v1 receipts replay','legacySourceBirths':'shared row BEFORE admission runs before expected-mutation exemptions','oldWorkReports':'new exact guards retain all v1 reports with no v2 registrations; globally unavailable if any v2 registration exists','unfencedRawJobReaders':'not safe for activation; listed candidates need semantic review/adaptation; cannot infer fence from report guards'}}
(root/'scripts/work-cross-job-reader-inventory.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'files':len(items),'routineCandidates':len(routines),'semanticGate':'OPEN'}))
