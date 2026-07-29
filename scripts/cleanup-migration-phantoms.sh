#!/usr/bin/env bash
# Remove the phantom rows from supabase_migrations.schema_migrations.
#
# WHAT A PHANTOM IS
# A row in the migration history table whose `version` matches no file in
# supabase/migrations/. They come from the Supabase MCP `apply_migration` tool,
# which writes its own wall-clock timestamp as the version instead of the
# file's, and from older ad-hoc applies. They are known and pre-existing; the
# count grows whenever somebody applies SQL outside the migration files, so
# this script measures it on every run rather than asserting a number.
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
# WHAT STOPS IT
# Only two things, and neither has an override: a migration file with no
# applied row, and two files claiming one version. Phantoms are reported, not
# refused — see the block below the argument parsing for why.
#
# SUPABASE_PROJECT_REF is REQUIRED and has no default, for the same reason
# scripts/pgq.sh refuses to guess: an audit run against an unnamed project once
# reported production clean while it was 31 tables short.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- what stops this script, and what it merely reports ----------------------
# DIRECTION MATTERS HERE, exactly as it does in scripts/schema_verify.py.
#
#   a migration FILE with no applied row  ->  STOPS. Something is genuinely
#                                             wrong: a migration in the repo
#                                             never reached the database, so
#                                             production is behind the code.
#                                             There is no override.
#
#   two files sharing one version         ->  STOPS. The history table is keyed
#                                             by version and `db push` walks
#                                             versions, so one of the two can
#                                             never be represented. No override.
#
#   an applied ROW with no file (phantom) ->  REPORTED, never stops anything.
#                                             These are known, pre-existing and
#                                             documented in
#                                             docs/db-push-readiness.md. They
#                                             are what this script exists to
#                                             delete, so refusing to run because
#                                             there are some is circular.
#
# This used to be three equality assertions — EXPECT_LOCAL / EXPECT_REMOTE /
# EXPECT_PHANTOMS, committed as literals. They were wrong within hours of every
# time they were written, because every merged migration moves two of them and
# every MCP `apply_migration` moves the third. A check whose expected value
# drifts under ordinary team activity fails for reasons unrelated to what it
# guards, and the only way past it is to bump the literal — which trains
# everyone to bump it, which is how this repo lost three checks to being
# permanently red. The numbers are now measured, printed and explained on every
# run instead of asserted.
#
# The one place a number is still enforced is the guard inside the DELETE
# transaction, and it is DERIVED at runtime from the files actually on disk
# during that run. See section 4.
#
# EXPECT_PHANTOMS is still honoured if you deliberately export it, for an
# operator who wants to pin one careful run to a count they have just read with
# their own eyes. It is unset by default and nothing in the repo sets it.

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
from collections import defaultdict

remote_path, files_path, out_path = sys.argv[1:4]

payload = json.load(open(remote_path))
if not isinstance(payload, list):
    sys.exit(f"unexpected API response: {payload}")
remote = [(r["version"], r.get("name") or "") for r in payload]

pattern = re.compile(r"^([0-9]{14})_.*\.sql$")
files_by_version = defaultdict(list)
for path in open(files_path).read().split():
    m = pattern.match(os.path.basename(path))
    if m:
        files_by_version[m.group(1)].append(os.path.basename(path))
local_set = set(files_by_version)
n_files = sum(len(v) for v in files_by_version.values())

phantoms = [(v, n) for v, n in remote if v not in local_set]
missing = sorted(local_set - {v for v, _ in remote})
duplicates = sorted(v for v, names in files_by_version.items() if len(names) > 1)

# A phantom that sorts after every migration file is the live leak, not
# history: it can only have been stamped by something applying SQL outside the
# migration files, which is the habit docs/db-push-readiness.md asks people to
# stop. Splitting them this way needs no baseline and no committed number, and
# it answers the question that actually matters — "is this still happening?" —
# rather than "is the total still 37".
newest_file = max(local_set) if local_set else ""
ahead = [(v, n) for v, n in phantoms if v > newest_file]
historical = [(v, n) for v, n in phantoms if v <= newest_file]

print(f"    {n_files} migration files on disk ({len(local_set)} distinct versions)")
print(f"    {len(remote)} rows in schema_migrations")
print(f"    {len(phantoms)} phantom rows — an applied row matching no file")
print(f"      of which {len(ahead)} sort after every migration file")
print(f"    {len(missing)} migration files with no applied row")
print(f"    {len(duplicates)} version(s) claimed by more than one file")
print()

print("--- rows this script would delete ---")
for v, n in phantoms:
    print(f"    {v}  {n}")
print("-------------------------------------")
print()

if ahead:
    print("These phantoms are newer than every migration file, so they were")
    print("stamped by something applying SQL outside supabase/migrations/ —")
    print("usually the Supabase MCP apply_migration tool, which records its own")
    print("wall-clock time as the version. They are safe to delete and are not")
    print("a reason to stop; they are the sign that the habit in")
    print("docs/db-push-readiness.md \u201cKeeping it clean\u201d has slipped again:")
    for v, n in ahead:
        print(f"    {v}  {n}")
    print()

with open(out_path, "w") as fh:
    for v, _ in phantoms:
        fh.write(v + "\n")

with open(out_path + ".local", "w") as fh:
    for v in sorted(local_set):
        fh.write(v + "\n")

with open(out_path + ".dupes", "w") as fh:
    for v in duplicates:
        fh.write(f"{v} {' '.join(sorted(files_by_version[v]))}\n")

with open(out_path + ".counts", "w") as fh:
    fh.write(f"{len(local_set)} {len(remote)} {len(phantoms)} {len(missing)} {len(duplicates)}\n")
PY

read -r n_versions n_remote n_phantom n_missing n_dupes <"$work/phantoms.txt.counts"

# --- 3. stop only on the things that are genuinely wrong ---------------------
# Phantoms are not in this list. They are what the script deletes, and they are
# documented; refusing to run because there are some would be circular.
fail=0

if [[ "$n_missing" -ne 0 ]]; then
  cat >&2 <<EOF
STOPPING: the history table has no row at all for $n_missing of the migration
files. That is the opposite problem from a phantom and it is the serious one —
a migration that is in the repo never reached the database, so production is
behind the code. Find out why before deleting anything. There is no override.
EOF
  fail=1
fi

if [[ "$n_dupes" -ne 0 ]]; then
  echo "STOPPING: $n_dupes migration version(s) are claimed by more than one file:" >&2
  sed 's/^/    /' "$work/phantoms.txt.dupes" >&2
  cat >&2 <<'EOF'
The history table is keyed by version and `supabase db push` walks versions, so
only one of each pair can ever be recorded. Rename the later file to a fresh
timestamp. There is no override for this check either.
EOF
  fail=1
fi

# Optional, opt-in, and unset by default: pin one run to a phantom count you
# have just read with your own eyes. Nothing in the repo sets this.
if [[ -n "${EXPECT_PHANTOMS:-}" && "$n_phantom" != "$EXPECT_PHANTOMS" ]]; then
  echo "STOPPING: EXPECT_PHANTOMS=$EXPECT_PHANTOMS was exported, but there are $n_phantom." >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

if [[ "$n_phantom" -eq 0 ]]; then
  echo "Nothing to do: every row in the history table matches a migration file."
  exit 0
fi

if [[ "$execute" -ne 1 ]]; then
  cat <<EOF
Preview only. Nothing was written.

Read the list above — it is exactly what --execute would delete, and the only
thing that makes deleting it safe is that a human recognised every line.

Re-run with --execute to delete those $n_phantom rows, leaving $n_versions rows
— one per migration file. That figure is measured from the files on disk during
this run, not from a number committed in this script.
EOF
  exit 0
fi

# --- 4. delete, scoped to exactly the versions listed above ------------------
# An explicit IN list of the versions we just read, not a NOT IN over the
# filenames, so the statement can only ever touch rows this run has printed.
#
# The guard runs before COMMIT: if the result is not exactly one row per
# migration file, with every filename version intact, it raises and the whole
# thing rolls back. This is the one numeric assertion left in the script, and
# it is DERIVED — $n_versions was counted from the files on disk a moment ago
# in this same run, not committed as a literal. That is what makes it a real
# guard: it cannot go stale, and there is no reason for anyone to bump it.
echo "==> deleting $n_phantom phantom rows"
python3 - "$work/phantoms.txt" "$work/phantoms.txt.local" "$n_versions" >"$work/delete.sql" <<'PY'
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
python3 - "$work/after.json" "$work/phantoms.txt.local" "$n_versions" <<'PY'
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
