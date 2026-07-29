#!/usr/bin/env bash
# Remove the phantom rows from supabase_migrations.schema_migrations.
#
# WHAT A PHANTOM IS
# A row in the migration history table whose `version` matches no file in
# supabase/migrations/. As of 2026-07-29 production holds 107 rows for 70
# files: 26 stamped by the Supabase MCP `apply_migration` tool (which writes
# its own wall-clock timestamp as the version) and 11 older ad-hoc rows.
# See docs/migration-repair-2026-07-29-production.md.
#
# WHY THEY MUST GO
# `supabase db push` compares versions. Any remote version with no local file
# makes it abort with "Remote migration versions not found in local migrations
# directory." — before applying anything, and `--include-all` does not help.
# Until these rows are gone the backend deploy workflow fails on every merge.
# See docs/db-push-readiness.md.
#
# USAGE
#   export SUPABASE_ACCESS_TOKEN=sbp_...              # management API token
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm  # production
#   scripts/cleanup-migration-phantoms.sh             # preview only, no writes
#   scripts/cleanup-migration-phantoms.sh --execute   # actually delete
#
# Preview is the default. Nothing is written without --execute.
#
# SUPABASE_PROJECT_REF is REQUIRED and has no default, for the same reason
# scripts/pgq.sh refuses to guess: an audit run against an unnamed project once
# reported production clean while it was 31 tables short.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- expectations -----------------------------------------------------------
# The script refuses to touch anything unless the database looks exactly like
# the state these numbers describe. Override only if you know why the state
# has legitimately moved on since 2026-07-29.
# These move whenever anyone adds a migration, so re-measure before trusting
# them: they were last read against production on 2026-07-29 at 21:20 UTC.
# 20260729220000_staging_bays_guaranteed.sql accounts for exactly one of the
# files and one of the rows; the phantom count rose from 37 to 40 because other
# work stamped three more rows through the MCP apply_migration tool, which
# writes its own wall-clock version.
EXPECT_LOCAL="${EXPECT_LOCAL:-73}"      # migration files on disk
EXPECT_REMOTE="${EXPECT_REMOTE:-113}"   # rows in schema_migrations before cleanup
EXPECT_PHANTOMS="${EXPECT_PHANTOMS:-40}" # rows to delete

execute=0
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) execute=1; shift ;;
    --project-ref) SUPABASE_PROJECT_REF="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN to an sbp_ management token}"

if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
  cat >&2 <<'EOF'
SUPABASE_PROJECT_REF is not set, and there is no default.

Set it explicitly to the project whose migration history you mean to clean:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/cleanup-migration-phantoms.sh

Guessing here once produced an audit of the wrong database.
EOF
  exit 2
fi
REF="$SUPABASE_PROJECT_REF"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# POST a statement batch to the Management API. Same transport as
# scripts/pgq.sh (curl, payload in a file) because a Python urllib client is
# blocked by Cloudflare's WAF and the API rejects anything but plain SQL.
api_query() {
  local sql_file="$1" out="$work/response.json"
  python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' \
    "$sql_file" >"$work/body.json"
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$work/body.json")"
  if [[ "$code" != "2"* ]]; then
    echo "Management API returned HTTP $code:" >&2
    cat "$out" >&2
    echo >&2
    return 1
  fi
  cat "$out"
}

# --- 1. read the current history table --------------------------------------
echo "==> project $REF"
echo "==> reading supabase_migrations.schema_migrations"
cat >"$work/read.sql" <<'EOF'
select version, coalesce(name, '') as name
from supabase_migrations.schema_migrations
order by version;
EOF
api_query "$work/read.sql" >"$work/remote.json"

# --- 2. compare against the files on disk ------------------------------------
# Local versions come from the filenames, never from a hard-coded list, so this
# cannot drift from the repo.
ls supabase/migrations/*.sql >"$work/files.txt" 2>/dev/null || {
  echo "no migration files found in supabase/migrations/ — wrong directory?" >&2
  exit 1
}

python3 - "$work/remote.json" "$work/files.txt" "$work/phantoms.txt" <<'PY'
import json, os, re, sys

remote_path, files_path, out_path = sys.argv[1:4]

payload = json.load(open(remote_path))
if not isinstance(payload, list):
    sys.exit(f"unexpected API response: {payload}")
remote = [(r["version"], r.get("name") or "") for r in payload]

pattern = re.compile(r"^([0-9]{14})_.*\.sql$")
local = []
for path in open(files_path).read().split():
    m = pattern.match(os.path.basename(path))
    if m:
        local.append(m.group(1))
local_set = set(local)

phantoms = [(v, n) for v, n in remote if v not in local_set]
missing = sorted(local_set - {v for v, _ in remote})

print(f"    {len(local)} migration files on disk")
print(f"    {len(remote)} rows in schema_migrations")
print(f"    {len(phantoms)} phantom rows (version matches no file)")
print(f"    {len(missing)} filename versions absent from the history table")
print()
print("--- rows this script would delete ---")
for v, n in phantoms:
    print(f"    {v}  {n}")
print("-------------------------------------")
print()

with open(out_path, "w") as fh:
    for v, _ in phantoms:
        fh.write(v + "\n")

with open(out_path + ".local", "w") as fh:
    for v in sorted(local_set):
        fh.write(v + "\n")

with open(out_path + ".counts", "w") as fh:
    fh.write(f"{len(local)} {len(remote)} {len(phantoms)} {len(missing)}\n")
PY

read -r n_local n_remote n_phantom n_missing <"$work/phantoms.txt.counts"

# --- 3. refuse unless the pre-state is exactly what we expect ----------------
fail=0
check() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    echo "REFUSING: $label is $got, expected $want" >&2
    fail=1
  fi
}
check "migration files on disk"          "$n_local"   "$EXPECT_LOCAL"
check "rows in schema_migrations"        "$n_remote"  "$EXPECT_REMOTE"
check "phantom rows"                     "$n_phantom" "$EXPECT_PHANTOMS"
check "filename versions missing remote" "$n_missing" "0"

if [[ "$fail" -ne 0 ]]; then
  echo >&2
  echo "The database is not in the state this cleanup was written for" >&2
  echo "(docs/migration-repair-2026-07-29-production.md), so it will not run." >&2
  if [[ "$n_missing" -ne 0 ]]; then
    cat >&2 <<EOF

The history table has no row at all for $n_missing of the migration files. That
is a different problem from phantoms and this script will not paper over it:
find out why before deleting anything. There is no override for this check.
EOF
  else
    cat >&2 <<EOF

Re-read the numbers above. If the difference is legitimate — someone added a
migration, or part of the cleanup already ran — set the expectations
explicitly and re-run, e.g.

  EXPECT_LOCAL=$n_local EXPECT_REMOTE=$n_remote EXPECT_PHANTOMS=$n_phantom \\
    SUPABASE_PROJECT_REF=$REF scripts/cleanup-migration-phantoms.sh

Never widen the expectations just to make the command go through.
EOF
  fi
  exit 1
fi

if [[ "$execute" -ne 1 ]]; then
  cat <<EOF
Preview only. Nothing was written.

Re-run with --execute to delete the $n_phantom rows listed above, leaving
$EXPECT_LOCAL rows — one per migration file.
EOF
  exit 0
fi

# --- 4. delete, scoped to exactly the versions listed above ------------------
# An explicit IN list of the versions we just read, not a NOT IN over the
# filenames, so the statement can only ever touch rows this run has printed.
# The guard runs before COMMIT: if the result is not exactly EXPECT_LOCAL rows
# with every filename version intact, it raises and the whole thing rolls back.
echo "==> deleting $n_phantom phantom rows"
python3 - "$work/phantoms.txt" "$work/phantoms.txt.local" "$EXPECT_LOCAL" >"$work/delete.sql" <<'PY'
import sys

phantoms = open(sys.argv[1]).read().split()
locals_ = open(sys.argv[2]).read().split()
expect = int(sys.argv[3])

def quoted(values):
    return ",\n    ".join(
        ", ".join(f"'{v}'" for v in values[i:i + 6]) for i in range(0, len(values), 6)
    )

print("begin;")
print("delete from supabase_migrations.schema_migrations")
print("where version in (")
print("    " + quoted(phantoms))
print(");")
print("""
do $$
declare
  remaining int;
  lost int;
begin
  select count(*) into remaining from supabase_migrations.schema_migrations;
  if remaining <> %d then
    raise exception 'expected %d rows after cleanup, found %%', remaining;
  end if;
  select count(*) into lost from (values
    %s
  ) as f(version)
  where not exists (
    select 1 from supabase_migrations.schema_migrations m where m.version = f.version
  );
  if lost <> 0 then
    raise exception '%% filename versions would be lost', lost;
  end if;
end $$;
""" % (expect, expect, ",\n    ".join(f"('{v}')" for v in locals_)))
print("commit;")
PY

api_query "$work/delete.sql" >/dev/null
echo "    delete committed"

# --- 5. verify the post-state independently ----------------------------------
echo "==> verifying"
api_query "$work/read.sql" >"$work/after.json"
python3 - "$work/after.json" "$work/phantoms.txt.local" "$EXPECT_LOCAL" <<'PY'
import json, sys

rows = json.load(open(sys.argv[1]))
locals_ = set(open(sys.argv[2]).read().split())
expect = int(sys.argv[3])

versions = {r["version"] for r in rows}
problems = []
if len(rows) != expect:
    problems.append(f"{len(rows)} rows remain, expected {expect}")
missing = sorted(locals_ - versions)
if missing:
    problems.append(f"{len(missing)} filename versions are gone: {', '.join(missing)}")
extra = sorted(versions - locals_)
if extra:
    problems.append(f"{len(extra)} phantom rows survived: {', '.join(extra)}")

if problems:
    for p in problems:
        print("    FAILED: " + p, file=sys.stderr)
    sys.exit(1)

print(f"    {len(rows)} rows, one per migration file, nothing missing")
PY

cat <<'EOF'

Done. `supabase db push --dry-run` should now report "Remote database is up to
date." Run it before merging anything else.
EOF
