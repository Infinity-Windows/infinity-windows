#!/usr/bin/env bash
# Read-only query helper against the live Supabase database via the Management API.
#
# Usage:  scripts/pgq.sh path/to/query.sql
#         echo "select 1" | scripts/pgq.sh
#
# The Management API rejects anything that is not a plain statement batch, and a
# Python urllib client is blocked by Cloudflare's WAF, so this shells out to curl
# and passes the payload as a file to avoid quoting problems with SQL literals.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN to an sbp_ management token}"
REF="${SUPABASE_PROJECT_REF:-jvsyhtarnvmdilsgksdi}"

sql_file="${1:-/dev/stdin}"
sql="$(cat "$sql_file")"

# Guard: this helper is for auditing only, never for mutating the database.
if printf '%s' "$sql" | grep -qiE '^[[:space:]]*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b'; then
  echo "refusing to run a non-SELECT statement through the audit helper" >&2
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' <<<"$sql" >"$body"

curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data @"$body"
