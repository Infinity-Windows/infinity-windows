#!/usr/bin/env bash
# Plan a merge of one Supabase project into another. DRY RUN ONLY.
#
#   scripts/supabase-merge.sh --source <json> --target <json> [--limit N] [--out plan.txt]
#
# `--source` and `--target` are either inventory files from
# scripts/supabase-inventory.sh, or full-table backup JSON (as in
# docs/backups/) when you want to see the actual INSERT statements.
#
# This tool prints the statements a merge would run, in foreign-key dependency
# order, and stops. There is no --execute. Merging two databases that were
# populated independently is not a mechanical operation: the same window type
# exists in both under different UUIDs, both projects backfilled SLOT-000001
# onwards over different physical racks, and profiles rows point at auth.users
# ids that SQL cannot create. Every one of those needs a human decision that
# this script has no way to make.
#
# Read docs/supabase-merge-plan.md, read the dry run, then execute the reviewed
# statements yourself against a database you have just backed up.
set -euo pipefail

SOURCE=""
TARGET=""
LIMIT=5
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a file}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a file}"; shift 2 ;;
    --limit)  LIMIT="${2:?--limit needs a number}"; shift 2 ;;
    --out)    OUT="${2:?--out needs a file}"; shift 2 ;;
    --dry-run) shift ;;  # the only mode there is; accepted so it reads well
    --execute|--apply|--yes|--force)
      cat >&2 <<'EOF'
--execute is deliberately not implemented.

This tool plans a merge; it does not perform one. Running it unattended against
a live database is exactly the failure this repo already had once, when an audit
guessed a project ref and reported the wrong database as clean.

What to do instead:

  1. Run this script without --execute and read the whole dry run.
  2. Read docs/supabase-merge-plan.md, in particular the sections on UUID
     remapping, SLOT-/WIN- serial collisions and auth users.
  3. Take a fresh backup of the target project.
  4. Execute the reviewed statements yourself, one phase at a time, checking the
     verification queries in phase 5 between phases.

If you later decide this should be automated, the missing pieces are: real
transaction handling with a savepoint per phase, re-serialisation of
locations.serial and windows.serial, and the auth invite-and-remap flow. None of
them are stubbed out here, because a half-written mutation tool is worse than
none.
EOF
      exit 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SOURCE" || -z "$TARGET" ]]; then
  echo "both --source and --target are required; there is no default project" >&2
  echo "  scripts/supabase-merge.sh --source docs/inventory/<ref>.json --target docs/inventory/<ref>.json" >&2
  exit 2
fi

for f in "$SOURCE" "$TARGET"; do
  [[ -f "$f" ]] || { echo "no such file: $f" >&2; exit 2; }
done

args=(--source "$SOURCE" --target "$TARGET" --limit "$LIMIT")
[[ -n "$OUT" ]] && args+=(--out "$OUT")

exec python3 "$(dirname "$0")/supabase_merge_plan.py" "${args[@]}"
