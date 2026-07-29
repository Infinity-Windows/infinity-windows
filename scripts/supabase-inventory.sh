#!/usr/bin/env bash
# Inventory every Supabase project on the account, so a human can decide which
# one to keep before anything is merged.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh
#   SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh --project czprjcskmzzagdztqonm
#   SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh --out-dir docs/inventory
#
# Writes docs/inventory/<ref>.json per project and prints a readable summary.
# Feed the JSON files to scripts/supabase-compare.py.
#
# Two safety properties are inherited from scripts/pgq.sh and must stay:
#
#   1. Read-only. Every statement is checked against the same refusal regex, so
#      this tool cannot write to a database even if someone edits a query below.
#   2. No default project ref. This script either enumerates what the account
#      actually owns, or uses a ref you named explicitly. Guessing a ref once
#      produced an audit of the wrong database — see
#      docs/migration-drift-2026-07-29-production.md.
#
# Like pgq.sh this shells out to curl: a Python urllib client is blocked by
# Cloudflare's WAF in front of api.supabase.com.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN to an sbp_ management token}"

API="https://api.supabase.com/v1"
OUT_DIR="docs/inventory"
ONLY_REFS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ $# -ge 2 ]] || { echo "--project needs a project ref" >&2; exit 2; }
      ONLY_REFS+=("$2"); shift 2 ;;
    --out-dir)
      [[ $# -ge 2 ]] || { echo "--out-dir needs a path" >&2; exit 2; }
      OUT_DIR="$2"; shift 2 ;;
    -h|--help)
      awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT_DIR"

# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

api_get() {
  curl -sS -X GET "$API/$1" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json"
}

# run_query <ref> <sql> — POSTs a SELECT to the database/query endpoint.
# Refuses anything that could mutate, exactly as pgq.sh does.
run_query() {
  local ref="$1" sql="$2"

  if [[ -z "$ref" ]]; then
    echo "run_query called without a project ref; refusing to guess one" >&2
    return 2
  fi
  if printf '%s' "$sql" | grep -qiE '(^|;)[[:space:]]*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b'; then
    echo "refusing to run a non-SELECT statement through the inventory tool" >&2
    return 1
  fi

  local body; body="$work/body.json"
  python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' <<<"$sql" >"$body"
  curl -sS -X POST "$API/projects/$ref/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$body"
}

# --------------------------------------------------------------------------
# The queries. All SELECT, all read-only, all tolerant of a schema that does
# not exist yet — an empty project must inventory as "0 tables", not as an error.
# --------------------------------------------------------------------------

# Exact counts, not reltuples: reltuples is an estimate and reads 0 on a table
# that has never been analysed, which is precisely the "empty vs missing"
# confusion this whole exercise exists to prevent.
Q_TABLES=$(cat <<'SQL'
select
  t.table_name,
  (xpath(
    '/row/c/text()',
    query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')
  ))[1]::text::bigint as row_count
from information_schema.tables t
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
order by t.table_name
SQL
)

Q_COLUMNS=$(cat <<'SQL'
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position
SQL
)

Q_MIGRATIONS=$(cat <<'SQL'
select
  case when to_regclass('supabase_migrations.schema_migrations') is null then null
       else (select count(*) from supabase_migrations.schema_migrations) end as migration_count,
  case when to_regclass('supabase_migrations.schema_migrations') is null then null
       else (select max(version) from supabase_migrations.schema_migrations) end as latest_version
SQL
)

Q_AUTH=$(cat <<'SQL'
select
  case when to_regclass('auth.users') is null then null
       else (select count(*) from auth.users) end as user_count,
  case when to_regclass('auth.users') is null then null
       else (select count(*) from auth.users where last_sign_in_at is not null) end as signed_in_count
SQL
)

Q_STORAGE=$(cat <<'SQL'
select
  b.name as bucket,
  b.public,
  (select count(*) from storage.objects o where o.bucket_id = b.id) as objects
from storage.buckets b
order by b.name
SQL
)

# --------------------------------------------------------------------------
# Which projects?
# --------------------------------------------------------------------------

if [[ ${#ONLY_REFS[@]} -gt 0 ]]; then
  printf '%s\n' "${ONLY_REFS[@]}" >"$work/refs.txt"
  echo "[]" >"$work/projects.json"
  echo "Inventorying ${#ONLY_REFS[@]} explicitly named project(s)." >&2
else
  api_get "projects" >"$work/projects.json"
  if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d, list) else 1)' "$work/projects.json"; then
    echo "GET $API/projects did not return a project list. Response:" >&2
    cat "$work/projects.json" >&2
    echo >&2
    echo "Is SUPABASE_ACCESS_TOKEN a management token (sbp_...) with access to the org?" >&2
    exit 1
  fi
  python3 -c '
import json, sys
for p in json.load(open(sys.argv[1])):
    print(p["id"])
' "$work/projects.json" >"$work/refs.txt"
  echo "Found $(wc -l <"$work/refs.txt" | tr -d " ") project(s) on this account." >&2
fi

if [[ ! -s "$work/refs.txt" ]]; then
  echo "No projects to inventory." >&2
  exit 1
fi

# --------------------------------------------------------------------------
# Inventory each project
# --------------------------------------------------------------------------

written=()
while read -r ref; do
  [[ -n "$ref" ]] || continue
  echo >&2
  echo "=== $ref ===" >&2

  api_get "projects/$ref/functions" >"$work/functions.json" || echo "[]" >"$work/functions.json"
  run_query "$ref" "$Q_TABLES"     >"$work/tables.json"     || echo "[]" >"$work/tables.json"
  run_query "$ref" "$Q_COLUMNS"    >"$work/columns.json"    || echo "[]" >"$work/columns.json"
  run_query "$ref" "$Q_MIGRATIONS" >"$work/migrations.json" || echo "[]" >"$work/migrations.json"
  run_query "$ref" "$Q_AUTH"       >"$work/auth.json"       || echo "[]" >"$work/auth.json"
  run_query "$ref" "$Q_STORAGE"    >"$work/storage.json"    || echo "[]" >"$work/storage.json"

  out="$OUT_DIR/$ref.json"
  python3 "$(dirname "$0")/supabase_inventory_build.py" \
    --ref "$ref" \
    --projects "$work/projects.json" \
    --tables "$work/tables.json" \
    --columns "$work/columns.json" \
    --migrations "$work/migrations.json" \
    --auth "$work/auth.json" \
    --storage "$work/storage.json" \
    --functions "$work/functions.json" \
    --out "$out"
  written+=("$out")
done <"$work/refs.txt"

echo >&2
if [[ ${#written[@]} -eq 0 ]]; then
  echo "No inventory files were written." >&2
  exit 1
fi
echo "Wrote ${#written[@]} inventory file(s):" >&2
printf '  %s\n' "${written[@]}" >&2
echo >&2
if [[ ${#written[@]} -ge 2 ]]; then
  echo "Compare them with:" >&2
  echo "  python3 scripts/supabase-compare.py ${written[*]}" >&2
fi
