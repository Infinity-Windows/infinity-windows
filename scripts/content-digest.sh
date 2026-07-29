#!/usr/bin/env bash
# Fingerprint the *contents* of a Supabase project, so a repair can be proved
# not to have changed anything.
#
# WHY THIS EXISTS
# Migration-history repair (scripts/cleanup-migration-phantoms.sh) deletes rows
# from supabase_migrations.schema_migrations. That table is bookkeeping, so the
# claim is that no application data and no schema object changes. "Should not"
# is not evidence. This prints a digest that is stable across runs when nothing
# moved, so before/after output can simply be diffed.
#
# WHAT IT MEASURES
#   * every table in every non-system schema: row count + md5 over all rows
#   * the catalog: tables, views, functions, policies, triggers, indexes,
#     constraints, enums, sequences — counted, and hashed as a sorted name list
#   * the auth roster: user count + md5 over id/email/role, no password hashes
#
# It deliberately reads pg_class / information_schema rather than the migration
# log, because the migration log is the thing under repair and a check that
# trusts its subject proves nothing.
#
# USAGE
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   scripts/content-digest.sh czprjcskmzzagdztqonm > before.txt
#   ...do the repair...
#   scripts/content-digest.sh czprjcskmzzagdztqonm > after.txt
#   diff before.txt after.txt && echo "nothing changed"
#
# Every statement is a SELECT. It never writes.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN to an sbp_ management token}"

REF="${1:-${SUPABASE_PROJECT_REF:-}}"
if [[ -z "$REF" ]]; then
  cat >&2 <<'EOF'
No project ref given, and there is no default.

  scripts/content-digest.sh czprjcskmzzagdztqonm

Guessing a ref once produced an audit of the wrong database
(docs/migration-drift-2026-07-29-production.md).
EOF
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Same transport as scripts/pgq.sh: curl with the payload in a file, because a
# Python urllib client is blocked by Cloudflare's WAF.
api_query() {
  python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' \
    "$1" >"$work/body.json"
  local code
  code="$(curl -sS -o "$work/out.json" -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$work/body.json")"
  if [[ "$code" != 2* ]]; then
    echo "Management API returned HTTP $code:" >&2
    cat "$work/out.json" >&2
    return 1
  fi
  cat "$work/out.json"
}

# query_to_xml lets one plain SELECT digest every table without a DO block, so
# this stays inside the read-only contract the audit helpers hold themselves to.
cat >"$work/tables.sql" <<'EOF'
select
  c.table_schema || '.' || c.table_name as rel,
  coalesce((xpath('/row/c/text()',
    query_to_xml(format('select count(*) as c from %I.%I', c.table_schema, c.table_name),
                 false, true, '')))[1]::text, '?') as n_rows,
  coalesce((xpath('/row/d/text()',
    query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as d from %I.%I x',
                        '|', 'empty', c.table_schema, c.table_name),
                 false, true, '')))[1]::text, '?') as digest
from information_schema.tables c
where c.table_type = 'BASE TABLE'
  and c.table_schema not in (
    'pg_catalog','information_schema','auth','storage','realtime','_realtime',
    'extensions','graphql','graphql_public','vault','pgsodium','pgsodium_masks',
    'supabase_functions','net','cron','pgbouncer'
  )
order by 1;
EOF

cat >"$work/catalog.sql" <<'EOF'
with rels as (
  select n.nspname || '.' || c.relname || ':' || c.relkind::text as item
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog','information_schema','pg_toast')
    and c.relkind in ('r','v','m','i','S','p')
),
funcs as (
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as item
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog','information_schema')
),
pols as (
  select schemaname || '.' || tablename || '.' || policyname as item from pg_policies
),
trigs as (
  select n.nspname || '.' || c.relname || '.' || t.tgname as item
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
),
cons as (
  select n.nspname || '.' || conname as item
  from pg_constraint co join pg_namespace n on n.oid = co.connamespace
  where n.nspname not in ('pg_catalog','information_schema')
),
enums as (
  select n.nspname || '.' || t.typname || '=' || e.enumlabel as item
  from pg_enum e join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
),
all_items as (
  select 'relation' as kind, item from rels
  union all select 'function', item from funcs
  union all select 'policy', item from pols
  union all select 'trigger', item from trigs
  union all select 'constraint', item from cons
  union all select 'enumlabel', item from enums
)
select kind, count(*) as n, md5(string_agg(item, '|' order by item)) as digest
from all_items group by kind order by kind;
EOF

cat >"$work/auth.sql" <<'EOF'
select
  count(*) as n_users,
  md5(coalesce(string_agg(
    id::text || ':' || coalesce(email, '') || ':' || coalesce(role, ''),
    '|' order by id::text), 'empty')) as digest
from auth.users;
EOF

emit() {
  local heading="$1" file="$2"
  echo "## $heading"
  api_query "$file" | python3 -c '
import json,sys
rows=json.load(sys.stdin)
if not isinstance(rows, list):
    sys.exit("unexpected API response: %s" % rows)
for r in rows:
    print("  " + "  ".join("{}={}".format(k, r[k]) for k in r))
'
  echo
}

echo "# content digest for $REF"
echo
emit "tables (row count + content md5)" "$work/tables.sql"
emit "catalog objects (count + name-list md5)" "$work/catalog.sql"
emit "auth roster" "$work/auth.sql"
