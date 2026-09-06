#!/usr/bin/env bash
# Tests for scripts/verify-invariants.sh — the plumbing around the judge.
#
# The judge's own cases live in scripts/test_verify_invariants.py. What this
# file proves is the wrapper: a missing token or an unnamed project is a
# failure and not a pass, a query helper that errors is a VERIFICATION failure,
# and a healthy fixture gets through to "OK". Stubs scripts/pgq.sh via the PGQ
# override; no token, no project, no network.
set -uo pipefail

cd "$(dirname "$0")/.."
script="scripts/verify-invariants.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0; fail=0

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

run() {
  local name="$1" want="$2" pgq="$3"
  shift 3
  local out
  out="$(env SUPABASE_ACCESS_TOKEN=sbp_test SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm PGQ="$pgq" "$@" bash "$script" 2>&1)"
  local got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name — exit $got, expected $want"; echo "$out" | sed 's/^/      /'; fail=$((fail + 1)); return
  fi
  LAST_OUT="$out"; echo "ok: $name"; pass=$((pass + 1))
}

expect_contains() {
  case "$LAST_OUT" in
    *"$2"*) echo "ok: $1"; pass=$((pass + 1)) ;;
    *) echo "FAIL: $1 — output did not contain: $2"; echo "$LAST_OUT" | sed 's/^/      /'; fail=$((fail + 1)) ;;
  esac
}

healthy_report='{"policies":[{"schema":"public","table":"packages","name":"p","cmd":"SELECT","roles":["authenticated"],"using":"(NOT is_partner_user())","check":""}],"profile_columns":[],"profile_truncate":{"anon":false,"authenticated":false},"fence_unguarded":[],"test_logins":2,"rls_off":[],"anon_definer_functions":[]}'
healthy="$(stub "[{\"report\":$healthy_report}]")"
run "a healthy database passes" 0 "$healthy"
expect_contains "  and says so in plain English" "OK: every security invariant holds"

broken_report='{"policies":[{"schema":"public","table":"time_shifts","name":"open","cmd":"SELECT","roles":["authenticated"],"using":"true","check":""}],"profile_columns":[],"profile_truncate":{"anon":false,"authenticated":false},"fence_unguarded":[],"test_logins":2,"rls_off":[],"anon_definer_functions":[]}'
broken="$(stub "[{\"report\":$broken_report}]")"
run "an unguarded crew table FAILS" 1 "$broken"
expect_contains "  and names the table" "time_shifts"

garbage="$(stub '{"message":"permission denied"}')"
run "an error from the database is a VERIFICATION failure, not a pass" 1 "$garbage"
expect_contains "  and says nothing was measured" "VERIFICATION failure"

dead="$work/pgq-dead.sh"; printf '#!/usr/bin/env bash\necho "curl: (6) could not resolve host" >&2\nexit 7\n' >"$dead"; chmod +x "$dead"
run "a query helper that exits non-zero is a VERIFICATION failure" 1 "$dead"
expect_contains "  and says why" "exited non-zero"

out="$(env -u SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF=x PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then echo "FAIL: no token should not be a pass"; fail=$((fail + 1)); else echo "ok: a missing token fails instead of silently passing"; pass=$((pass + 1)); fi

out="$(env SUPABASE_ACCESS_TOKEN=sbp_test -u SUPABASE_PROJECT_REF PGQ="$healthy" bash "$script" 2>&1)"
if [ $? -eq 0 ]; then echo "FAIL: no project ref should not be a pass"; fail=$((fail + 1)); else echo "ok: an unnamed project fails instead of guessing"; pass=$((pass + 1)); fi

# The SQL the wrapper sends must be a SELECT and nothing else, or pgq.sh would
# refuse it in production and every run would be a verification failure.
if grep -qiE '^[[:space:]]*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b' scripts/invariants.sql; then
  echo "FAIL: scripts/invariants.sql contains a non-SELECT statement"; fail=$((fail + 1))
else
  echo "ok: scripts/invariants.sql is SELECT-only"; pass=$((pass + 1))
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
