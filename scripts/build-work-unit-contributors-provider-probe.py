#!/usr/bin/env python3
"""Append the exact held contributor candidate; db_dry_run forces rollback."""
import hashlib
from pathlib import Path
from db_dry_run import check_probe, split_statements

ROOT = Path(__file__).resolve().parent.parent
base = ROOT / 'scripts/dry-run-probes/work-activity-totals-current-rehearsal.sql'
source_path = ROOT / 'supabase/migrations/20261108460000_work_unit_contributors.sql'
metadata = ROOT / 'scripts/verify-work-unit-contributors-installed.sql'
calls = ROOT / 'scripts/dry-run-probes/work-unit-contributors-provider-calls.sql'
target = ROOT / 'scripts/dry-run-probes/work-unit-contributors-current-rehearsal.sql'
PINS = {
    base: '642b9f555ee1d4368640447d6273f83e5547a0ff372dc06791f4ff52e0b11fb2',
    source_path: 'ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5',
    metadata: '543e409d04bd6f064dd0900b3062b6da43049b6991910aa8ff9cf8eae9be4af7',
    calls: 'e2e8369708e2bffef31f92230796f42623f69f394b449fd26cd420c6b5259465',
}
for path, sha in PINS.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha, path
source = source_path.read_text()
statements = split_statements(source)
first, last = statements[0], statements[-1]
assert first.skeleton == 'begin' and last.skeleton == 'rollback'
body = source[:first.code_start] + source[first.end:last.code_start] + source[last.end:]
# Before the first new DDL, record the real provider namespace. The candidate's
# first metadata-only preflight also refuses every existing overload/helper.
audit = """
do $contributors_namespace_audit$ begin
 perform pg_temp.dry_run_check('provider/contributorsNamespaceBeforeDDL',
 not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname='work_unit_contributors_read' or starts_with(p.proname,'_work_unit_contributors_')))
 and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_')),
 'Provider namespace inspected before additive contributor DDL');
end; $contributors_namespace_audit$;
"""
fragment = metadata.read_text().strip().removesuffix(';')
assert len(split_statements(fragment + ';')) == 1
sql = base.read_text() + '\n' + audit + body
sql += '\ndo $contributors_metadata$ declare result record; begin for result in (' + fragment + ') loop\n'
sql += "perform pg_temp.dry_run_check('provider/'||result.check_name,result.passed,'Exact contributor source, ACL and capture-off metadata');\n"
sql += 'end loop; end; $contributors_metadata$;\n' + calls.read_text()
count = check_probe(str(target), sql)
target.write_text(sql)
print('Pinned contributors', PINS[source_path], count, 'statements; final forced ROLLBACK owned by db_dry_run.py')
