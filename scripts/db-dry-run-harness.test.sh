#!/usr/bin/env bash
# The SQL half of the practice run, proved on a real PostgreSQL 16 in a
# disposable, network-isolated container (the same pattern as
# scripts/test-forge-permissions.sh). No credentials, no production data.
#
# scripts/test_db_dry_run.py proves the builder and the judge; this proves
# what they cannot: that the harness works INSIDE Postgres — a temp table a
# probe can write while it acts as `authenticated`, an RPC called under a
# simulated login, a refusal caught and recorded without aborting the batch,
# the results leaving in the forced error — and, above all, that when the
# batch is over the migration and every row it wrote are GONE.
#
# The batch is sent the way the Management API sends it: one string, one
# simple-query round trip (`psql -c`), so the transaction semantics are the
# ones production will see.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
FIX="$REPO/scripts/tests/db-dry-run"
CONTAINER="db-dry-run-$$-$RANDOM"
work="$(mktemp -d)"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is not on the PATH, so the harness was not proved on a real Postgres." >&2
  exit 1
fi

docker run --detach --name "$CONTAINER" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=disposable-fixture-password postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "Disposable PostgreSQL did not finish starting within 60 seconds." >&2
  exit 1
fi

pass=0
fail=0
ok()  { echo "ok: $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; fail=$((fail + 1)); }

# One simple-query round trip, like the Management API's. Stdout and stderr
# are kept apart: the results ride in the error, which is stderr.
send_batch() {
  local batch="$1" out="$2" err="$3"
  set +e
  docker exec -i "$CONTAINER" psql -X -U postgres -q -c "$(cat "$batch")" >"$out" 2>"$err"
  local rc=$?
  set -e
  return $rc
}
query() { docker exec -i "$CONTAINER" psql -X -U postgres -At -v ON_ERROR_STOP=1 -c "$1"; }

docker exec -i "$CONTAINER" psql -X -U postgres -q -v ON_ERROR_STOP=1 <"$FIX/setup.sql"

# --- 1. The happy path ---------------------------------------------------------
python3 "$REPO/scripts/db_dry_run.py" build --out "$work/batch.sql" --probe "$FIX/probe.sql" "$FIX/migration.sql" >"$work/plan"
grep -q "set aside" "$work/plan" && ok "the fixture migration's own begin/commit was set aside" || bad "the wrapper was not set aside"

if send_batch "$work/batch.sql" "$work/out" "$work/err"; then
  bad "the batch ended without an error — the forced error did not fire"
else
  ok "the batch ended in an error, as it must"
fi
grep -q "DRY_RUN_RESULT:" "$work/err" && ok "the results rode out in the error" || { bad "no results in the error"; cat "$work/err"; }

set +e
python3 "$REPO/scripts/db_dry_run.py" judge --status 400 --body "$work/err" --project "disposable" >"$work/verdict"
rc=$?
set -e
cat "$work/verdict"
[ "$rc" -eq 0 ] && ok "every check in the probe passed (exit 0)" || bad "the judge exited $rc"
for check in "pick: the QA installer comes first" \
             "pick: the QA foreman comes first, ahead of the real one" \
             "sandbox_job: PECAN14 first" \
             "job: BLACK22 by code" \
             "act_as: runs as the authenticated role with their id" \
             "act_as: a testing job is hidden from an installer" \
             "rpc: the installer's note is saved under their id" \
             "rpc: a body over twenty characters is refused" \
             "rls: the installer cannot read the table directly" \
             "system: both notes are on the job" \
             "system: back to no caller" \
             "sandbox_job: BLACK22 once PECAN14 is off the sandbox list" \
             "sandbox_job: then by code, past the trashed, unlisted, unflagged" \
             "sandbox_job: none left stops the run in plain words" \
             "pick: no QA installer stops the run, never a real installer" \
             "pick_real: the real installer, for a probe that means one" \
             "pick: no QA foreman stops the run, never a real foreman" \
             "pick: a role with no QA login still gets a real person" \
             "pick: a role nobody holds stops the run"; do
  grep -q "ok    $check" "$work/verdict" && ok "  $check" || bad "  missing or failed: $check"
done

# The guarantee. After the batch: no table, no function, no rows, no helpers.
after="$(query "select to_regclass('public.demo_notes') is null, to_regprocedure('public.demo_leave_note(uuid, text)') is null")"
[ "$after" = "t|t" ] && ok "after the batch the migration's table and RPC do not exist" || bad "something survived the rollback: $after"
temps="$(query "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname like 'pg_temp%' and c.relname = 'dry_run_results'")"
[ "$temps" = "0" ] && ok "no harness object survived the connection" || bad "a harness object survived: $temps"
# And the probe's own setup changes: a QA login's role, the sandbox list, a
# job's flag, a job in the trash.
state="$(query "select (select role from public.profiles where id = '00000000-0000-4000-8000-000000000001'),
                       (select role from public.profiles where id = '00000000-0000-4000-8000-000000000002'),
                       (select count(*) from public.sandbox_projects),
                       (select is_test from public.projects where job_code = 'BLACK22'),
                       (select deleted_at is null from public.projects where job_code = 'MADMOOSE')")"
[ "$state" = "installer|foreman|5|t|t" ] && ok "the probe's changes to roles, the sandbox list and the jobs were rolled back too" \
  || bad "the probe's setup changes survived: $state"

# --- 2. A migration that breaks on a constraint --------------------------------
python3 "$REPO/scripts/db_dry_run.py" build --out "$work/batch2.sql" --probe "$FIX/probe.sql" "$FIX/migration.sql" "$FIX/migration-broken.sql" >/dev/null
send_batch "$work/batch2.sql" "$work/out2" "$work/err2" || true
set +e
python3 "$REPO/scripts/db_dry_run.py" judge --status 400 --body "$work/err2" --project "disposable" >"$work/verdict2"
rc=$?
set -e
cat "$work/verdict2"
[ "$rc" -eq 1 ] && ok "a migration failing on a check constraint is exit 1" || bad "the judge exited $rc for a broken migration"
grep -q "demo_notes_body_short_ck" "$work/verdict2" && ok "  and the constraint is named" || bad "  the constraint was not named"
after="$(query "select to_regclass('public.demo_notes') is null")"
[ "$after" = "t" ] && ok "  and the first migration was rolled back with it" || bad "  the first migration survived: $after"

# --- 3. A probe with a false check ---------------------------------------------
python3 "$REPO/scripts/db_dry_run.py" build --out "$work/batch3.sql" --probe "$FIX/probe-failing.sql" "$FIX/migration.sql" >/dev/null
send_batch "$work/batch3.sql" "$work/out3" "$work/err3" || true
set +e
python3 "$REPO/scripts/db_dry_run.py" judge --status 400 --body "$work/err3" --project "disposable" >"$work/verdict3"
rc=$?
set -e
cat "$work/verdict3"
[ "$rc" -eq 1 ] && ok "a false check is exit 1" || bad "the judge exited $rc for a false check"
grep -q "FAIL  a check that is wrong on purpose" "$work/verdict3" && ok "  and it is named" || bad "  it was not named"

# --- 4. A QA login that lost its role (2026-09-23/24) ---------------------------
# The whole trip: the probe picks an installer the usual way while qa.installer
# is a foreman. It must stop in plain words, and the verdict must say the
# change was not tried — not act as the real installer and fail on the fence.
python3 "$REPO/scripts/db_dry_run.py" build --out "$work/batch4.sql" --probe "$FIX/probe-lost-qa-role.sql" "$FIX/migration.sql" >/dev/null
send_batch "$work/batch4.sql" "$work/out4" "$work/err4" || true
set +e
python3 "$REPO/scripts/db_dry_run.py" judge --status 400 --body "$work/err4" --project "disposable" >"$work/verdict4"
rc=$?
set -e
cat "$work/verdict4"
[ "$rc" -eq 3 ] && ok "a QA login that lost its role is exit 3: the change was not tried" || bad "the judge exited $rc for a QA login that lost its role"
grep -q "no QA login has the installer role" "$work/verdict4" && grep -q "set qa.installer" "$work/verdict4" \
  && ok "  and it names the login to fix" || bad "  it did not name the login to fix"
grep -q "the change is broken" "$work/verdict4" && bad "  and it says the change is broken" || ok "  and it does not say the change is broken"
grep -q "never reached" "$work/verdict4" && bad "  and the probe went on past the pick" || ok "  and the probe stopped at the pick"
role="$(query "select role from public.profiles where id = '00000000-0000-4000-8000-000000000001'")"
[ "$role" = "installer" ] && ok "  and the role change was rolled back with the batch" || bad "  the role change survived: $role"

echo
echo "$pass passed, $fail failed (disposable PostgreSQL 16)"
[ "$fail" -eq 0 ]
