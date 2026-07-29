#!/usr/bin/env bash
# On-demand migration drift audit: compares every file in supabase/migrations/
# against the live database and reports which ones are not really applied.
#
# This exists because migrations here have often been applied by POSTing SQL to
# the Supabase Management API, which records nothing in
# supabase_migrations.schema_migrations. The recorded history therefore cannot
# be trusted, and the live catalog is the only source of truth.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...            # management API token
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm  # production
#   scripts/audit-migrations.sh
#
# SUPABASE_PROJECT_REF is REQUIRED and has no default. The 2026-07-28 audit
# reported production as clean while it was 31 tables short, purely because the
# variable was unset and the helper fell back to a different project. Name the
# database you mean.
#
# Read-only: every query is a SELECT and scripts/pgq.sh refuses anything else.
set -euo pipefail

cd "$(dirname "$0")/.."
out="${TMPDIR:-/tmp}/iw-migration-audit"
mkdir -p "$out"

echo "==> snapshotting live schema"
scripts/pgq.sh scripts/live_schema.sql    > "$out/live_schema.json"
scripts/pgq.sh scripts/live_functions.sql > "$out/live_functions.json"

echo
echo "==> object drift (tables, columns, indexes, constraints, policies, triggers)"
python3 scripts/migration_drift.py "$out/live_schema.json"

echo
echo "==> function body drift (catches a stale 'create or replace function')"
python3 scripts/function_drift.py "$out/live_functions.json"

echo
echo "snapshots kept in $out"
