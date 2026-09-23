#!/usr/bin/env bash
# Does each role see exactly the "Using Forge" walkthroughs it should — on the
# LIVE database, with real profiles, not a fixture?
#
# scripts/verify-app-training-videos.mjs proves the rule against the migration
# in a throwaway database. This asks production the same question after a
# publication: for EVERY person who can sign in today (STG partners too),
# which catalog rows and which private files would their own login be allowed
# to read? The answer comes from the live row security and storage policies,
# not from a copy of their logic, and is compared with what the floors say
# they should see: installer 0+, foreman 1+, leadership 2+ (docs/role-training-videos.md).
#
# READ-ONLY, and nobody's password. Each person is one statement batch through
# the Management API, which runs it as a single implicit transaction:
#   set transaction read only      -> any write in it is refused by Postgres
#   set_config(..., true)          -> the caller's identity, gone at the end
#   set local role authenticated   -> the policies apply, gone at the end
# The final row reports current_user, so a batch that did NOT run as the
# simulated login is caught and fails instead of passing on superuser reads.
# Only role names, head counts and video slugs are printed — never who.
#
# Usage (needs the management token, which only GitHub holds):
#   SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-app-training-live.sh
set -euo pipefail

if [ -z "${SUPABASE_PROJECT_REF:-}" ] || [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN must both be set (no default project, see scripts/pgq.sh)." >&2
  exit 2
fi

ask() {
  # $1 = the profile filter: an id from the database, checked as a uuid below.
  local who="$1" body
  body="$(mktemp)"
  python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' >"$body" <<SQL
set transaction read only;
select set_config('request.jwt.claims', coalesce((
  select json_build_object('sub', p.id::text, 'role', 'authenticated')::text
  from public.profiles p
  where ${who}
    and p.retired_at is null
    and p.access_revoked_at is null
  order by p.id
  limit 1), ''), true);
select set_config('app.training_role', coalesce((
  select case when coalesce(p.is_partner, false) then 'partner' else p.role end
  from public.profiles p
  where p.id::text = nullif(current_setting('request.jwt.claims', true), '')::json->>'sub'), ''), true);
set local role authenticated;
select json_build_object(
  'role', current_setting('app.training_role', true),
  'as_user', current_user,
  'catalog', (select coalesce(json_agg(slug order by slug), '[]'::json) from public.app_training_videos),
  'files', (select coalesce(json_agg(distinct split_part(name, '/', 1)), '[]'::json)
            from storage.objects where bucket_id = 'app-training')
) as result;
SQL
  curl -sS -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$body"
  rm -f "$body"
}

# What is published right now, read as the token's own role (no row security):
# the floors decide who should see which of these.
published_body="$(mktemp)"
python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' >"$published_body" <<'SQL'
select coalesce(json_agg(json_build_object('slug', slug, 'min_role', min_role) order by slug), '[]'::json) as result
from public.app_training_videos
where active and published_at is not null and published_at <= now();
SQL
published="$(curl -sS -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  --data @"$published_body")"
rm -f "$published_body"

# Everyone who can sign in today, partners included. Only ids leave the
# database, and only into this process: they are never printed.
people_body="$(mktemp)"
python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' >"$people_body" <<'SQL'
select coalesce(json_agg(p.id::text order by p.id), '[]'::json) as result
from public.profiles p
where p.retired_at is null and p.access_revoked_at is null;
SQL
people="$(curl -sS -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  --data @"$people_body")"
rm -f "$people_body"

answers="$(mktemp)"
trap 'rm -f "$answers"' EXIT
PEOPLE="$people" python3 -c '
import json, os
def find(o):
    if isinstance(o, dict):
        return o["result"] if "result" in o else next((r for v in o.values() for r in [find(v)] if r is not None), None)
    if isinstance(o, list):
        return next((r for v in o for r in [find(v)] if r is not None), None)
r = find(json.loads(os.environ["PEOPLE"]))
if r is None: raise SystemExit("could not list who to check: " + os.environ["PEOPLE"][:300])
for i in (json.loads(r) if isinstance(r, str) else r or []): print(i)
' | while read -r id; do
  # A database uuid, checked anyway before it goes into SQL text.
  [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "not a uuid" >&2; exit 1; }
  ask "p.id = '$id'" >>"$answers"
  echo >>"$answers"
done

PUBLISHED="$published" python3 - "$answers" <<'PY'
import json, os, sys

def rows(raw):
    """The Management API answers with the last statement's rows; accept a
    list of them or one object, and find the single `result` value."""
    data = json.loads(raw)
    found = []
    def walk(o):
        if isinstance(o, dict):
            if "result" in o:
                found.append(o["result"])
            else:
                for v in o.values():
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    if len(found) != 1:
        raise SystemExit(f"unexpected answer from the database: {raw[:300]}")
    r = found[0]
    return json.loads(r) if isinstance(r, str) else r

published = rows(os.environ["PUBLISHED"])
floor = {"installer": 0, "foreman": 1, "supervisor": 2}
rank = {"installer": 0, "foreman": 1, "lead": 1, "supervisor": 2, "admin": 2,
        "owner": 3, "big_boss": 3, "partner": -1}
fmt = lambda xs: ", ".join(xs) or "nothing"

by_role, bad = {}, 0
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    r = rows(line)
    role = r.get("role") or "unknown"
    if r.get("as_user") != "authenticated":
        raise SystemExit(f"FAILED: a check did not run as the login ({r.get('as_user')}); nothing proven")
    # A role this app does not recognise must see nothing (can_watch_app_training).
    should = sorted(p["slug"] for p in published if rank.get(role, -1) >= floor[p["min_role"]])
    sees = (tuple(sorted(r["catalog"])), tuple(sorted(r["files"])))
    g = by_role.setdefault(role, {"n": 0, "wrong": 0, "should": should})
    g["n"] += 1
    if sees != (tuple(should), tuple(should)):
        g["wrong"] += 1
        bad += 1

if not by_role:
    raise SystemExit("FAILED: nobody was checked, so nothing is proven")
print("### Using Forge walkthroughs: what each person can open (live)\n")
print("Published now: " + (", ".join(f"{p['slug']} ({p['min_role']}+)" for p in published) or "nothing") + "\n")
print("Every account that has not been removed was checked as itself, inside a read-only transaction.\n")
print("| Role | People checked | Should see | Result |")
print("|---|---|---|---|")
order = ["installer", "foreman", "lead", "supervisor", "admin", "owner", "big_boss", "partner"]
for role in sorted(by_role, key=lambda k: (order.index(k) if k in order else 99, k)):
    g = by_role[role]
    result = "all correct" if not g["wrong"] else f"WRONG for {g['wrong']}"
    print(f"| {role} | {g['n']} | {fmt(g['should'])} | {result} |")
sys.exit(1 if bad else 0)
PY
