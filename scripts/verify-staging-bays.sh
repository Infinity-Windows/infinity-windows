#!/usr/bin/env bash
# Prove that every active job in the live database still has its two staging
# bays, and that no staging bay has been orphaned from its job.
#
# WHY THIS IS NOT A DEPLOY GATE
# scripts/verify-schema.sh runs inside .github/workflows/deploy-backend.yml
# because it checks the SHAPE of the database, which is exactly what a deploy
# changes. This checks ROWS, and rows drift between deploys: a job can arrive
# by a merge, a restore or a hand-written INSERT on a Tuesday afternoon with no
# deploy anywhere near it. Wiring it into the deploy would mean it only looks
# on the days we happen to ship, and would block an unrelated fix from shipping
# because of a data problem a deploy cannot repair. So it runs on a schedule
# instead (.github/workflows/verify-warehouse.yml) and tells Slack.
#
# WHAT IT LOOKS FOR
#   1. An active job with fewer than two ACTIVE bays. That job's windows have
#      no shelf of their own; before 2026-07-29 the app answered that state by
#      quietly directing the foreman to a shared stock shelf.
#   2. A staging bay whose rack matches no job code. `locations` has no
#      project_id — the only link is the string `locations.rack =
#      projects.job_code` — so renaming a job's code, or deriving a bay's rack
#      by any rule that can differ from the code, leaves a shelf that is in
#      every picker and belongs to nobody.
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
  'jobs', (
    select coalesce(json_agg(json_build_object(
      'job_code', p.job_code,
      'name', p.name,
      'bays', (select count(*) from locations l
                where l.zone = 'J' and l.active and l.rack = p.job_code)
    ) order by p.job_code), '[]'::json)
    from projects p
    where p.status = 'active'
  ),
  'orphans', (
    select coalesce(json_agg(l.address order by l.address), '[]'::json)
    from locations l
    where l.zone = 'J' and l.active
      and not exists (select 1 from projects p where p.job_code = l.rack)
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

# The Management API answers a failed query with an object, not a row list.
if not isinstance(payload, list) or not payload:
    print(f"FAIL: unexpected answer from the database: {payload}")
    print("This is a VERIFICATION failure, not a warehouse failure.")
    raise SystemExit(1)

report = payload[0].get("report") or {}
jobs = report.get("jobs") or []
orphans = report.get("orphans") or []

short = [j for j in jobs if (j.get("bays") or 0) < 2]

print("## Job staging bays\n")
print(f"- {len(jobs)} active job(s) checked")
print(f"- {len(short)} without their two bays")
print(f"- {len(orphans)} bay(s) belonging to no job\n")

if not short and not orphans:
    print("Every active job has both of its staging bays, and every staging")
    print("bay belongs to a job.")
    raise SystemExit(0)

for j in short:
    n = j.get("bays") or 0
    print(
        f"- **{j.get('job_code')}** ({j.get('name')}) has {n} of 2 staging bays. "
        "Its windows have no shelf of their own, so nobody can be told where to "
        "put them. Fix it from the job's Warehouse tab in the app — the "
        "\u201cCreate staging bays\u201d button — no SQL needed."
    )
for address in orphans:
    print(
        f"- **{address}** is a staging bay whose job code matches no job. It is "
        "in every picker and belongs to nobody. Either the job code was renamed "
        "without its bays, or the bay was created with the wrong rack."
    )

raise SystemExit(1)
PY
status=$?

cat "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >>"$GITHUB_STEP_SUMMARY"
fi
exit "$status"
