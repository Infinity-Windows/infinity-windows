#!/usr/bin/env bash
# Tests for scripts/verify-staging-bays.sh.
#
# A check nobody has proved can FAIL is not a check. These feed the script
# fixture answers through a stubbed scripts/pgq.sh (via the PGQ override), so
# they need no token, no project and no network, and they never touch a
# database. Container history, uniqueness, orphan and invalid-report failures
# stay loud; an intentionally inactive empty bay is valid.
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
             SUPABASE_PROJECT_REF=fixture-only \
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

healthy="$(stub '[{"report":{"version":2,"jobs":[{"job_code":"SYN-A","name":"Synthetic","bays":1,"active_bays":1},{"job_code":"SYN-B","name":"Retired empty bay","bays":2,"active_bays":0}],"orphans":[]}}]')"
run "one active bay or intentionally inactive bay history passes" 0 "$healthy"
expect_contains "  and describes the current model" "Container-bay relationships are consistent"

missing="$(stub '[{"report":{"version":2,"jobs":[{"job_code":"SYN-A","name":"Synthetic","bays":0,"active_bays":0}],"orphans":[]}}]')"
run "missing bay history fails" 1 "$missing"
expect_contains "  and names the job" "SYN-A"
expect_contains "  and avoids retired repair advice" "do not recreate legacy rack locations"

duplicate="$(stub '[{"report":{"version":2,"jobs":[{"job_code":"SYN-A","name":"Synthetic","bays":2,"active_bays":2}],"orphans":[]}}]')"
run "multiple active bays fail" 1 "$duplicate"
expect_contains "  and reports the duplicate count" "2 active container bays"

orphan="$(stub '[{"report":{"version":2,"jobs":[],"orphans":["synthetic-orphan-id"]}}]')"
run "active orphan bay fails" 1 "$orphan"
expect_contains "  and names its identity" "synthetic-orphan-id"

empty="$(stub '[{"report":{"version":2,"jobs":[],"orphans":[]}}]')"
run "an explicitly measured empty warehouse passes" 0 "$empty"

for body in '{"message":"permission denied"}' '[]' '[{}]' '[{"report":{}}]' '[{"report":{"jobs":[],"orphans":[]}}]' '[{"report":{"version":2,"jobs":null,"orphans":[]}}]' '[{"report":{"version":2,"jobs":[{"job_code":"X","name":"X","bays":1,"active_bays":2}],"orphans":[]}}]' '[{"report":{"version":2,"jobs":[{"job_code":"X","name":"X","bays":true,"active_bays":0}],"orphans":[]}}]' '[{"report":{"version":2,"jobs":[],"orphans":[null]}}]' 'not-json'; do
  run "invalid/obsolete response is a verification failure" 1 "$(stub "$body")"
  expect_contains "  and never claims warehouse health" "VERIFICATION failure"
done

# Ensure fixture execution also exercises the current SELECT, not the retired
# locations query. The stub never calls pgq or any network service.
sqlstub="$work/sql-check.sh"
cat >"$sqlstub" <<'SH'
#!/usr/bin/env bash
if ! grep -q 'from storage_containers' "$1" || ! grep -q 'c.project_id = p.id' "$1" || ! grep -q 'p.deleted_at is null' "$1" || grep -q 'from locations' "$1"; then
  echo 'wrong query shape' >&2; exit 1
fi
printf '%s\n' '[{"report":{"version":2,"jobs":[],"orphans":[]}}]'
SH
chmod +x "$sqlstub"
run "query uses container ownership, not retired J slots" 0 "$sqlstub"

badquery="$work/query-failed.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$badquery"
chmod +x "$badquery"
run "query transport failure is not a clean warehouse" 1 "$badquery"
expect_contains "  and explains verification failed" "VERIFICATION failure"

out="$(env -u SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF=fixture-only PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then
  echo "FAIL: no token should not pass"; fail=$((fail + 1))
else
  LAST_OUT="$out"; expect_contains "missing token fails for the intended reason" "SUPABASE_ACCESS_TOKEN is not set"
fi
# Options must precede assignments: otherwise env itself fails and falsely
# appears to prove the script's missing-project guard.
out="$(env -u SUPABASE_PROJECT_REF SUPABASE_ACCESS_TOKEN=sbp_test PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then
  echo "FAIL: unnamed project should not pass"; fail=$((fail + 1))
else
  LAST_OUT="$out"; expect_contains "unnamed project fails for the intended reason" "SUPABASE_PROJECT_REF is not set"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
