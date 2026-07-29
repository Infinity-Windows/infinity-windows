#!/usr/bin/env bash
# Tests for scripts/verify-function-secrets.sh.
#
# Every case stubs the Supabase CLI, so nothing here needs a token, a project or
# a network. The behaviours worth pinning down are the three verdicts:
# all-set, a genuinely missing secret, and could-not-tell — that last one has to
# fail rather than pass, for the same reason scripts/verify-functions.sh treats
# an unanswered probe as a failure.
#
#   scripts/verify-function-secrets.test.sh
#   scripts/verify-function-secrets.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/verify-function-secrets.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# The real secrets the repo's functions need, so the "all set" case does not
# have to be updated whenever a function gains a dependency.
REQUIRED="$(python3 scripts/function_secrets.py --names)"

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
}

# write_stub <exit code> <stdout...>
write_stub() {
  local rc="$1"
  shift
  {
    echo '#!/usr/bin/env bash'
    echo "cat <<'TABLE'"
    printf '%s\n' "$@"
    echo 'TABLE'
    echo "exit $rc"
  } >"$root/bin/supabase"
  chmod +x "$root/bin/supabase"
}

# A CLI table listing the given names plus the platform-provided ones that every
# project has.
write_stub_listing() {
  local lines=("        NAME        |            DIGEST" \
    "  ------------------|--------------------")
  local n
  for n in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY "$@"; do
    lines+=("   $n | abc123def456")
  done
  write_stub 0 "${lines[@]}"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    SUPABASE_BIN="$root/bin/supabase" \
    SUPABASE_ACCESS_TOKEN="${TOKEN_OVERRIDE-sbp_test}" \
    SUPABASE_PROJECT_REF="${REF_OVERRIDE-testref}" \
    bash "$SCRIPT" 2>&1)"
  RC=$?
  if [ "$VERBOSE" = 1 ]; then
    echo "--- $current (rc=$RC)"
    echo "$OUT"
  fi
}

ok() { passed=$((passed + 1)); }

bad() {
  failed=$((failed + 1))
  echo "FAIL: $current"
  echo "      $1"
}

assert_rc() {
  if [ "$RC" = "$1" ]; then ok; else bad "expected exit $1, got $RC (output: $OUT)"; fi
}

assert_has() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then
    ok
  else
    bad "output is missing '$1' (output: $OUT)"
  fi
}

assert_lacks() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then
    bad "output should not contain '$1'"
  else
    ok
  fi
}

# --- everything set --------------------------------------------------------

new_case "all required secrets present: passes"
# shellcheck disable=SC2086  # deliberate word splitting over the name list.
write_stub_listing $REQUIRED
run
assert_rc 0
assert_has "All required Edge Function secrets are set"
assert_has "testref"

new_case "a passing run still lists what it checked"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
run
assert_rc 0
assert_has "ANTHROPIC_API_KEY"
assert_has "set "

# --- a missing secret ------------------------------------------------------

new_case "a missing secret fails and names the function that needs it"
write_stub_listing OPENAI_API_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
run
assert_rc 1
assert_has "MISSING"
assert_has "ANTHROPIC_API_KEY"
assert_has "ask"
assert_has "500"

new_case "the failure tells you the exact command to fix it"
write_stub_listing OPENAI_API_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
run
assert_rc 1
assert_has "supabase secrets set ANTHROPIC_API_KEY --project-ref testref"

new_case "every missing secret is named, not just the first"
write_stub_listing OPENAI_API_KEY
run
assert_rc 1
assert_has "ANTHROPIC_API_KEY"
assert_has "VAPID_PUBLIC_KEY"
assert_has "VAPID_PRIVATE_KEY"

new_case "a set secret is not reported as missing"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
run
assert_rc 0
assert_lacks "MISSING"

# --- could not tell: must fail, not pass -----------------------------------

new_case "a failing CLI is a verification failure, not a missing secret"
write_stub 1 "Error: not logged in"
run
assert_rc 1
assert_has "VERIFICATION failure"
assert_has "not a missing secret"

new_case "an empty listing is refused rather than read as all-missing"
write_stub 0 ""
run
assert_rc 1
assert_has "named no secrets at all"

new_case "a listing of only a header is refused too"
write_stub 0 "        NAME        |     DIGEST" "  -----|-----"
run
assert_rc 1
assert_has "named no secrets at all"

# --- refusing to guess the project -----------------------------------------

new_case "no project ref: refuses rather than guessing"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
REF_OVERRIDE="" run
assert_rc 1
assert_has "SUPABASE_PROJECT_REF is not set"
assert_has "no default"

new_case "no access token: says nothing was measured"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
TOKEN_OVERRIDE="" run
assert_rc 1
assert_has "SUPABASE_ACCESS_TOKEN is not set"
assert_has "VERIFICATION failure"

# --- no secret value is ever printed ---------------------------------------

new_case "digests from the CLI are never echoed"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
run
assert_rc 0
assert_lacks "abc123def456"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
