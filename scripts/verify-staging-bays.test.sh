#!/usr/bin/env bash
# Tests for scripts/verify-staging-bays.sh.
#
# A check nobody has proved can FAIL is not a check. These feed the script
# fixture answers through a stubbed scripts/pgq.sh (via the PGQ override), so
# they need no token, no project and no network, and they never touch a
# database. The important cases are the failing ones: a job short of a bay, and
# a bay belonging to no job.
set -uo pipefail

cd "$(dirname "$0")/.."
script="scripts/verify-staging-bays.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0

# Write a stub that prints $1 and exits 0, and echo its path.
stub() {
  local body="$1" path="$work/pgq-$RANDOM.sh"
  {
    echo '#!/usr/bin/env bash'
    printf 'cat <<%s\n' "'FIXTURE'"
    printf '%s\n' "$body"
    echo 'FIXTURE'
  } >"$path"
  chmod +x "$path"
  printf '%s' "$path"
}

# run <name> <expected-exit> <stub-path> [extra env assignments…]
run() {
  local name="$1" want="$2" pgq="$3"
  shift 3
  local out
  out="$(env SUPABASE_ACCESS_TOKEN=sbp_test \
             SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
             PGQ="$pgq" "$@" bash "$script" 2>&1)"
  local got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name — exit $got, expected $want"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
    return
  fi
  LAST_OUT="$out"
  echo "ok: $name"
  pass=$((pass + 1))
}

expect_contains() {
  local name="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) echo "ok: $name"; pass=$((pass + 1)) ;;
    *)
      echo "FAIL: $name — output did not contain: $needle"
      echo "$LAST_OUT" | sed 's/^/      /'
      fail=$((fail + 1))
      ;;
  esac
}

healthy="$(stub '[{"report":{"jobs":[{"job_code":"BLACK22","name":"Black Desert","bays":2},{"job_code":"OAKRIDGE","name":"Oakridge","bays":2}],"orphans":[]}}]')"
run "a warehouse where every job has both bays passes" 0 "$healthy"
expect_contains "  and says so in plain English" "Every active job has both of its staging bays"

nobays="$(stub '[{"report":{"jobs":[{"job_code":"BLACK22","name":"Black Desert","bays":0},{"job_code":"OAKRIDGE","name":"Oakridge","bays":2}],"orphans":[]}}]')"
run "a job with no bays FAILS the check" 1 "$nobays"
expect_contains "  and names the job" "BLACK22"
expect_contains "  and says how to fix it without SQL" "Warehouse tab"

onebay="$(stub '[{"report":{"jobs":[{"job_code":"PECAN14","name":"Pecan Valley","bays":1}],"orphans":[]}}]')"
run "a job with only one bay FAILS too" 1 "$onebay"
expect_contains "  and says which count it found" "1 of 2 staging bays"

orphan="$(stub '[{"report":{"jobs":[{"job_code":"BLACK22","name":"Black Desert","bays":2}],"orphans":["J-OLDJOB-A"]}}]')"
run "a bay belonging to no job FAILS the check" 1 "$orphan"
expect_contains "  and names the orphaned shelf" "J-OLDJOB-A"

garbage="$(stub '{"message":"permission denied"}')"
run "an error from the database is a VERIFICATION failure, not a pass" 1 "$garbage"
expect_contains "  and says nothing was measured" "VERIFICATION failure"

# A check that cannot tell "measured and clean" from "did not measure" is
# worthless, so the missing-credential paths must fail rather than pass.
out="$(env -u SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF=x PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then
  echo "FAIL: no token should not be a pass"; fail=$((fail + 1))
else
  echo "ok: a missing token fails instead of silently passing"; pass=$((pass + 1))
fi

out="$(env SUPABASE_ACCESS_TOKEN=sbp_test -u SUPABASE_PROJECT_REF PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then
  echo "FAIL: no project ref should not be a pass"; fail=$((fail + 1))
else
  echo "ok: an unnamed project fails instead of guessing"; pass=$((pass + 1))
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
