#!/usr/bin/env bash
# Prove a test login still cannot touch a real job.
#
# Runs after `supabase db push` in .github/workflows/deploy-backend.yml, beside
# scripts/verify-schema.sh, and for the same reason: a push that exits 0 proves
# the CLI ran, not that the database is what the repo says it is.
#
# WHAT IT MEASURES. public.sandbox_guard_census() (added by
# 20260965000000_sandbox_guard_rearm.sql) lists every project-scoped table that
# does NOT carry guard_test_account_sandbox_only. Any row is a table a QA login
# can write on ANY job, so any row fails the deploy.
#
# WHY IT IS NOT ADVISORY, WHEN THE SCHEMA CHECK'S LIVE-ONLY HALF IS. The schema
# check tolerates undeclared objects because blocking on them would be red on
# every merge forever. This is the opposite: the healthy answer is zero rows,
# it has been zero rows by construction since 20260965000000 armed everything,
# and the static gate in scripts/test_sandbox_guard.py stops a new table from
# arriving unarmed. A row here means the fence came down between deploys, which
# is exactly the thing nobody noticed for five weeks.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   scripts/verify-sandbox-guard.sh
#
# SUPABASE_PROJECT_REF has no default for the same reason scripts/pgq.sh has
# none: an audit run against a guessed project once reported production clean
# while it was 31 tables short.
#
# Read-only. Every statement goes through scripts/pgq.sh, which refuses anything
# that is not a SELECT.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so the fence was not measured." >&2
  echo "This is a VERIFICATION failure, not a fence failure — nothing was measured." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project you mean to verify, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-sandbox-guard.sh

Guessing here once produced an audit of the wrong database.
EOF
  exit 1
fi

snapshot="$(mktemp)" || exit 1
trap 'rm -f "$snapshot"' EXIT

echo "==> reading the test-login fence on $SUPABASE_PROJECT_REF"
if ! scripts/pgq.sh scripts/sandbox_guard_census.sql >"$snapshot"; then
  echo "FAIL: could not read the fence from $SUPABASE_PROJECT_REF." >&2
  echo "This is a VERIFICATION failure. Nothing here says the fence is down." >&2
  exit 1
fi

report="$(mktemp)" || exit 1
trap 'rm -f "$snapshot" "$report"' EXIT

python3 scripts/sandbox_guard.py "$snapshot" >"$report" 2>&1
status=$?

# Markdown so it can go straight into the job summary, and to stdout so the
# plain log has it too.
cat "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  grep -v '^::result::' "$report" >>"$GITHUB_STEP_SUMMARY"
fi

exit "$status"
