#!/usr/bin/env bash
# Prove the live schema matches what supabase/migrations/ declares.
#
# Runs after `supabase db push` in .github/workflows/deploy-backend.yml. A push
# that exits 0 only proves the CLI ran; on 2026-07-29 production was 26 declared
# tables short with every build green. This is the migration equivalent of what
# scripts/verify-functions.sh does for edge functions.
#
# The comparison is DIRECTIONAL and the reasoning is in scripts/schema_verify.py:
# something declared and absent fails the deploy; something live and undeclared
# is reported and does not. `project_marks` is the live-only case that made the
# distinction necessary.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   scripts/verify-schema.sh
#
# SUPABASE_PROJECT_REF has no default here for the same reason scripts/pgq.sh
# has none: the 2026-07-28 audit reported production clean while it was 31
# tables short, purely because the variable was unset and the helper fell back
# to a different project. A check that might be measuring the wrong database is
# not a check. See docs/migration-drift-2026-07-29-production.md.
#
# Read-only. Every statement goes through scripts/pgq.sh, which refuses anything
# that is not a SELECT.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so the schema was not verified." >&2
  echo "This is a VERIFICATION failure, not a schema failure — nothing was measured." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project you mean to verify, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-schema.sh

Guessing here once produced an audit of the wrong database.
EOF
  exit 1
fi

snapshot="$(mktemp)" || exit 1
trap 'rm -f "$snapshot"' EXIT

echo "==> snapshotting the live schema of $SUPABASE_PROJECT_REF"
if ! scripts/pgq.sh scripts/live_schema.sql >"$snapshot"; then
  echo "FAIL: could not read the live schema from $SUPABASE_PROJECT_REF." >&2
  echo "This is a VERIFICATION failure. Nothing here says the schema is wrong." >&2
  exit 1
fi

echo "==> comparing it with supabase/migrations/"
report="$(mktemp)" || exit 1
trap 'rm -f "$snapshot" "$report"' EXIT

python3 scripts/schema_verify.py "$snapshot" >"$report" 2>&1
status=$?

# The report is written as markdown so it can go straight into the job summary,
# and to stdout so it is also in the plain log.
cat "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  grep -v '^::result::' "$report" >>"$GITHUB_STEP_SUMMARY"
fi

# Hand the live-only counts to the workflow so it can raise a Slack warning
# about undeclared objects WITHOUT failing this job.
result="$(grep '^::result::' "$report" | tail -n 1)"
if [ -n "${GITHUB_OUTPUT:-}" ] && [ -n "$result" ]; then
  live_only="$(printf '%s' "$result" | sed -n 's/.*live_only_tables=\([0-9]*\).*/\1/p')"
  names="$(printf '%s' "$result" | sed -n 's/.*tables=\(.*\)$/\1/p')"
  {
    echo "live_only_tables=${live_only:-0}"
    echo "live_only_table_names=${names:--}"
  } >>"$GITHUB_OUTPUT"
fi

exit "$status"
