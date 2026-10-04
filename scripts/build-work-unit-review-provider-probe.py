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
diagnostic = ROOT / 'scripts/dry-run-probes/work-unit-review-coverage-diagnostic.fragment.sql'
target = ROOT / 'scripts/dry-run-probes/work-unit-review-current-rehearsal.sql'
pins = {
    base: 'e5083557889fb1fb58dd0408b3c6d1aa937662f8966ff0f964ac4e231f492f55',
    review: '4ec3c7486cba34976af5670aab08659b7525eff9fd714478b2cd10782877b474',
    metadata: 'f84779c3982e3cbe4d11e9c46e85a13ed091c356d6c2f4e9e211192b9cc790ce',
    diagnostic: 'df642efcd812f2cb0b1399f2ff371acf255ab47f37ca109d4f5c38da0ce6da05',
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
       + '\ndo $review_metadata$ declare probe_result record; begin\n'
       + ' for probe_result in (' + fragment + ') loop\n'
       + "  perform pg_temp.dry_run_check('provider/'||probe_result.check_name,probe_result.passed,'Exact private review metadata');\n"
       + ' end loop; end; $review_metadata$;\n' + calls.read_text())
# A failed attestation remains failed. Report only catalog category/attribute
# hashes, never function bodies or operational records, to diagnose parity.
diagnostic_sql = diagnostic.read_text().strip().removesuffix(';')
diagnostic_statements = split_statements(diagnostic_sql + ';')
assert len(diagnostic_statements) == 1 and diagnostic_statements[0].skeleton.startswith('with expected')
sql += ('\ndo $review_diagnostic$ declare probe_result record; begin\n'
        + ' if not public._work_unit_review_coverage() then\n'
        + '  for probe_result in (' + diagnostic_sql + ') loop\n'
        + "   perform pg_temp.dry_run_check('provider/'||probe_result.check_name,probe_result.passed,'category='||probe_result.category||';object='||probe_result.object_name||';attribute='||probe_result.attribute||';'||probe_result.detail);\n"
        + '  end loop;\n end if;\n end; $review_diagnostic$;\n')
count = check_probe(str(target), sql)
target.write_text(sql)
print(f'Pinned review {pins[review]}; {count} provider probe statements; forced rollback owned by db_dry_run.py')
