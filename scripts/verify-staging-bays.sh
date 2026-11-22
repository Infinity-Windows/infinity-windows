#!/usr/bin/env bash
# Read-only container-bay invariant check (ADR-0009).
# Every non-deleted job has a bay history; at most one bay may be active.
# Empty bays may intentionally be inactive and are recreated on first ask.
# Active bays must reference an existing project. Legacy J-zone locations
# were retired by 20260998000000_bays_are_boxes.sql; never recreate them here.
# This remains a scheduled row check, not a deploy gate or a repair script.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   scripts/verify-staging-bays.sh
#
# SUPABASE_PROJECT_REF has no default for the same reason scripts/pgq.sh has
# none: an audit run against an unnamed project once reported production clean
# while it was 31 tables short. See docs/migration-drift-2026-07-29-production.md.
#
# Read-only. The one statement it runs goes through scripts/pgq.sh, which
# refuses anything that is not a SELECT.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

# Overridable so the test suite can feed it a fixture instead of a database.
PGQ="${PGQ:-scripts/pgq.sh}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so nothing was checked." >&2
  echo "This is a VERIFICATION failure, not a warehouse failure." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project you mean to check, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-staging-bays.sh

Guessing here once produced an audit of the wrong database.
EOF
  exit 1
fi

sql="$(mktemp)" || exit 1
out="$(mktemp)" || exit 1
trap 'rm -f "$sql" "$out"' EXIT

cat >"$sql" <<'SQL'
select json_build_object(
  'version', 2,
  'jobs', (
    select coalesce(json_agg(json_build_object(
      'job_code', p.job_code,
      'name', p.name,
      'bays', (select count(*) from storage_containers c
                where c.kind = 'bay' and c.project_id = p.id),
      'active_bays', (select count(*) from storage_containers c
                where c.kind = 'bay' and c.project_id = p.id and c.active)
    ) order by p.job_code), '[]'::json)
    from projects p
    where p.deleted_at is null
  ),
  'orphans', (
    select coalesce(json_agg(c.id::text order by c.id), '[]'::json)
    from storage_containers c
    where c.kind = 'bay' and c.active
      and not exists (select 1 from projects p where p.id = c.project_id)
  )
) as report;
SQL

echo "==> checking job staging bays in $SUPABASE_PROJECT_REF"
if ! "$PGQ" "$sql" >"$out"; then
  echo "FAIL: could not read $SUPABASE_PROJECT_REF." >&2
  echo "This is a VERIFICATION failure. Nothing here says the warehouse is wrong." >&2
  exit 1
fi

report="$(mktemp)" || exit 1
trap 'rm -f "$sql" "$out" "$report"' EXIT

python3 - "$out" >"$report" 2>&1 <<'PY'
import json, sys

try:
    payload = json.load(open(sys.argv[1]))
except (OSError, ValueError) as exc:
    print(f"FAIL: could not read the database's answer ({exc}).")
    print("This is a VERIFICATION failure, not a warehouse failure.")
    raise SystemExit(1)

# Missing, obsolete or malformed results must never become a clean warehouse.
try:
    if not isinstance(payload, list) or len(payload) != 1:
        raise ValueError()
    report = payload[0]['report']
    if not isinstance(report, dict) or type(report.get('version')) is not int or report['version'] != 2:
        raise ValueError()
    jobs, orphans = report['jobs'], report['orphans']
    if not isinstance(jobs, list) or not isinstance(orphans, list):
        raise ValueError()
    for j in jobs:
        if (not isinstance(j, dict) or not isinstance(j.get('job_code'), str)
                or not isinstance(j.get('name'), str)
                or type(j.get('bays')) is not int or type(j.get('active_bays')) is not int
                or not 0 <= j['active_bays'] <= j['bays']):
            raise ValueError()
    if any(not isinstance(o, str) or not o for o in orphans):
        raise ValueError()
except (KeyError, TypeError, ValueError):
    print('FAIL: malformed or obsolete container-bay report. VERIFICATION failure; warehouse not verified.')
    raise SystemExit(1)

missing = [j for j in jobs if j['bays'] == 0]
duplicate = [j for j in jobs if j['active_bays'] > 1]
print('## Job container bays\n')
print(f'- {len(jobs)} non-deleted job(s) checked')
print(f'- {len(missing)} without bay history')
print(f'- {len(duplicate)} with multiple active bays')
print(f'- {len(orphans)} active bay(s) belonging to no job\n')
if not missing and not duplicate and not orphans:
    print('Container-bay relationships are consistent; intentionally inactive empty bays are allowed.')
    raise SystemExit(0)
for j in missing:
    print(f"- **{j['job_code']}** ({j['name']}) has no container-bay history. Review migration/creation history; do not recreate legacy rack locations.")
for j in duplicate:
    print(f"- **{j['job_code']}** has {j['active_bays']} active container bays; at most one is allowed.")
for identity in orphans:
    print(f'- Active container bay **{identity}** references no existing job.')
print('Investigate before repair; this check changes no records.')
raise SystemExit(1)
PY
status=$?

cat "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >>"$GITHUB_STEP_SUMMARY"
fi
exit "$status"
