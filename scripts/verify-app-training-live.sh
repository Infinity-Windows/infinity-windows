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

# The judging (parse, compare with the role floor, render the table) is
# scripts/verify_app_training_live.py, unit-tested offline in
# scripts/test_verify_app_training_live.py — this just hands it the two
# things it read above.
PUBLISHED="$published" python3 "$(dirname "$0")/verify_app_training_live.py" "$answers"
