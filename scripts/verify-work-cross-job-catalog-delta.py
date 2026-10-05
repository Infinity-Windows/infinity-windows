#!/usr/bin/env python3
"""Inventory frozen catalog differences; does not accept or refresh source guards."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
load = lambda name: json.loads((root / 'scripts' / name).read_text())
old = load('work-cross-job-old-catalog.json')
new = load('work-cross-job-new-catalog.json')
identity = lambda f: f["name"] + '(' + f["arguments"] + ')'
before = {identity(f): f for f in old['metadata']['functions']}
after = {identity(f): f for f in new['metadata']['functions']}
removed = sorted(before.keys() - after.keys())
assert not removed, removed
changed = [{'identity': k, 'before': before[k], 'after': after[k]}
           for k in sorted(before) if before[k] != after[k]]
added = [{'identity': k, 'after': after[k]} for k in sorted(after.keys() - before.keys())]
inventory = load('work-cross-job-dispatch-inventory.json')
entries = []
typed = lambda f: f['name'] + '(' + ', '.join(a.strip().split(' ', 1)[1] for a in f['arguments'].split(',')) + ')' if f['arguments'] else f['name'] + '()'
before_typed = {typed(f): identity(f) for f in old['metadata']['functions']}
for e in inventory['entries']:
    k = before_typed[e['identity']]
    assert k in before and k in after, k
    entries.append({'identity': k, 'directTimingCandidate': e['directTimingCandidate'],
                    'before': before[k], 'after': after[k],
                    'bodyDisposition': 'unchanged' if before[k]['body'] == after[k]['body'] else 'replaced',
                    'executionStatus': e['executionStatus']})
assert len(entries) == 220
assert sum(e['directTimingCandidate'] for e in entries) == 60
tables = {'time_shifts', 'custom_work_sessions', 'unit_sessions', 'task_sessions',
          'service_time_sessions', 'opening_phases', 'work_setup_sessions'}
triggers = sorted((t for t in new['metadata']['triggers'] if t['table'] in tables),
                  key=lambda t: (t['table'], t['name']))
result = {'scope': 'Exact frozen disposable catalog delta; no genuine provider evidence',
          'oldCatalogSha256': old['catalogSha256'], 'newCatalogSha256': new['catalogSha256'],
          'migrationSha256': hashlib.sha256((root / 'supabase/migrations/20261108470000_work_cross_job_capture.sql').read_bytes()).hexdigest(),
          'oldFunctionCount': len(before), 'newFunctionCount': len(after),
          'replacedFunctions': changed, 'addedFunctions': added, 'removedFunctions': removed,
          'generatedWrappersAndCallbacks': entries,
          'relevantTriggerOrder': triggers,
          'triggerOrderNote': 'Names sort within identical event/timing classes; definitions retain event/timing. Functional tests verify custom/service before lifecycle behavior. No genuine session proof.'}
(root / 'scripts/work-cross-job-catalog-delta.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'changedFunctions': len(changed), 'addedFunctions': len(added),
                  'frozenWrapperCallbacks': len(entries), 'directTimingCandidates': 60}))
