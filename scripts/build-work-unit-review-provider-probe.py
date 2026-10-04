#!/usr/bin/env python3
"""Build a pinned held-review rehearsal for the forced-rollback provider tool."""
import hashlib
from pathlib import Path
from db_dry_run import check_probe, split_statements

ROOT = Path(__file__).resolve().parent.parent
base = ROOT / 'scripts/dry-run-probes/work-activity-engine-current-readiness-rehearsal.sql'
review = ROOT / 'supabase/migrations/20261108440000_work_unit_review.sql'
metadata = ROOT / 'scripts/verify-work-unit-review-installed.sql'
calls = ROOT / 'scripts/dry-run-probes/work-unit-review-provider-calls.sql'
target = ROOT / 'scripts/dry-run-probes/work-unit-review-current-rehearsal.sql'
pins = {
    base: 'e5083557889fb1fb58dd0408b3c6d1aa937662f8966ff0f964ac4e231f492f55',
    review: '2acd7ece715122550628e115c3866ed0f9fb46c94987e80391d906a5c7fe36de',
    metadata: 'f84779c3982e3cbe4d11e9c46e85a13ed091c356d6c2f4e9e211192b9cc790ce',
}
for path, expected in pins.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, path
source = review.read_text()
statements = split_statements(source)
first, last = statements[0], statements[-1]
assert first.skeleton == 'begin' and last.skeleton == 'rollback'
# Only the outer held wrapper is omitted. Every prerequisite/hash guard remains.
body = source[:first.code_start] + source[first.end:last.code_start] + source[last.end:]
fragment = metadata.read_text().strip().removesuffix(';')
sql = (base.read_text() + '\n-- Additive held review candidate; batch still owns rollback.\n' + body
       + '\ndo $review_metadata$ declare r record; begin\n'
       + ' for r in (' + fragment + ') loop\n'
       + "  perform pg_temp.dry_run_check('provider/'||r.check_name,r.passed,'Exact private review metadata');\n"
       + ' end loop; end; $review_metadata$;\n' + calls.read_text())
count = check_probe(str(target), sql)
target.write_text(sql)
print(f'Pinned review {pins[review]}; {count} provider probe statements; forced rollback owned by db_dry_run.py')
