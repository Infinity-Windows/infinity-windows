#!/usr/bin/env python3
"""Add exact held totals to the frozen review rehearsal; wrapper forces rollback."""
import hashlib
from pathlib import Path
from db_dry_run import check_probe, split_statements
ROOT=Path(__file__).resolve().parent.parent
base=ROOT/'scripts/dry-run-probes/work-unit-review-current-rehearsal.sql'
source_path=ROOT/'supabase/migrations/20261108450000_work_activity_totals.sql'
metadata=ROOT/'scripts/verify-work-activity-totals-installed.sql'
calls=ROOT/'scripts/dry-run-probes/work-activity-totals-provider-calls.sql'
target=ROOT/'scripts/dry-run-probes/work-activity-totals-current-rehearsal.sql'
# Pins are populated only after the bounded implementation and source closure.
PINS={
 base: 'c32342321e4d224d4f3196ba50039c52e1bee43607c62af0cb2acb33ed3fc280',
 source_path: '1545a569be66e374c0c01abccf1920a649704d4ce784d8ba1753fa0ebe8189f8',
 metadata: '215399700dfaf630313f00348e190a9aaabf3eef2a926a105ec467c4ef03c077',
 calls: '4f93fdfd6e61abe9e57623da6ad06aaa600bd025b09f7a8fb798e68eb7ea81dc',
}
assert len(PINS)==4, 'Totals provider pins pending source freeze; nothing sent'
for path,sha in PINS.items():
 assert hashlib.sha256(path.read_bytes()).hexdigest()==sha,path
source=source_path.read_text();statements=split_statements(source);first,last=statements[0],statements[-1]
assert first.skeleton=='begin' and last.skeleton=='rollback'
body=source[:first.code_start]+source[first.end:last.code_start]+source[last.end:]
fragment=metadata.read_text().strip().removesuffix(';')
sql=base.read_text()+'\n-- Additive held totals, outer forced rollback retained.\n'+body
sql+='\ndo $totals_metadata$ declare result record; begin for result in ('+fragment+') loop\n'
sql+="perform pg_temp.dry_run_check('provider/'||result.check_name,result.passed,'Exact totals source/ACL/capture-off metadata');\n"
sql+='end loop; end; $totals_metadata$;\n'+calls.read_text()
count=check_probe(str(target),sql);target.write_text(sql)
print('Pinned totals',PINS[source_path],count,'statements; final forced ROLLBACK owned by db_dry_run.py')
