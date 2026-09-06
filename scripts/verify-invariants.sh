#!/usr/bin/env bash
# Prove the live database still has the security shape the migrations say it has.
#
# The partner wall, the money doors, the profiles credential columns and the
# test-login fence each have a static check in CI that replays the migration
# FILES. This runs the same questions against the DATABASE, on every pull
# request and every night, because the two drift apart in exactly the ways
# nobody notices: a policy edited in the dashboard, a migration applied by hand
# and never committed. July 2026 had twelve of the second kind.
#
# WHY SHAPE AND NOT ROWS. scripts/verify-staging-bays.sh checks rows and runs
# on a schedule only, on purpose — its header says why: rows drift with no
# deploy in sight and should not block an unrelated fix. Everything here is
# shape (grants, policies, triggers), which is what a migration changes, so it
# belongs on the pull request that carries the migration.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   scripts/verify-invariants.sh
#
# SUPABASE_PROJECT_REF has no default for the same reason scripts/pgq.sh has
# none: an audit run against a guessed project once reported production clean
# while it was 31 tables short.
#
# Read-only. The one statement it runs goes through scripts/pgq.sh, which
# refuses anything that is not a SELECT. The judgement is
# scripts/verify_invariants.py.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

# Overridable so the test suite can feed it a fixture instead of a database.
PGQ="${PGQ:-scripts/pgq.sh}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so nothing was checked." >&2
  echo "This is a VERIFICATION failure, not a security failure — nothing was measured." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'MSG'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project you mean to check, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-invariants.sh

Guessing here once produced an audit of the wrong database.
MSG
  exit 1
fi

out="$(mktemp)" || exit 1
trap 'rm -f "$out"' EXIT

if ! "$PGQ" scripts/invariants.sql >"$out" 2>&1; then
  echo "FAIL: the query helper exited non-zero; nothing was measured." >&2
  echo "This is a VERIFICATION failure, not a security failure." >&2
  sed 's/^/    /' "$out" >&2
  exit 1
fi

python3 scripts/verify_invariants.py "$out"
