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
    GITHUB_OUTPUT="$root/github_output" \
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

# The workflow lifts the first line into the GitHub error annotation and the job
# summary heading, so what that line says is a contract, not a detail.
assert_first_line_has() {
  local first
  first="$(printf '%s\n' "$OUT" | head -n 1)"
  if printf '%s' "$first" | grep -qF -- "$1"; then
    ok
  else
    bad "first line should contain '$1' but was: $first"
  fi
}

# assert_count <expected> <pattern>
assert_count() {
  local n
  n="$(printf '%s\n' "$OUT" | grep -cF -- "$2")"
  if [ "$n" = "$1" ]; then
    ok
  else
    bad "expected $1 line(s) containing '$2', found $n (output: $OUT)"
  fi
}

assert_output_var() {
  if grep -qF -- "$1" "$root/github_output" 2>/dev/null; then
    ok
  else
    bad "GITHUB_OUTPUT should contain '$1' (got: $(cat "$root/github_output" 2>&1))"
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

# --- the real state of the live project, as of 2026-07-29 ------------------
#
# czprjcskmzzagdztqonm has OPENAI_API_KEY, all three VAPID keys and the
# platform-injected ones, and has never had ANTHROPIC_API_KEY. So the first real
# run of this check WILL be red, for exactly one true reason. These cases pin
# down that the resulting message is legible and singular, because a first run
# that cries wolf about five things when one is wrong is how a check loses its
# authority permanently — and the person reading it is not an engineer.

live_state() {
  write_stub_listing OPENAI_API_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY \
    VAPID_SUBJECT
}

new_case "only ANTHROPIC_API_KEY missing: leads with the feature, not the variable"
live_state
run
assert_rc 1
assert_first_line_has "Ask Infinity"
assert_first_line_has "need an API key that has not been added yet"
# The variable name belongs in the body, not in the sentence a non-engineer reads
# first.
first_line="$(printf '%s\n' "$OUT" | head -n 1)"
if printf '%s' "$first_line" | grep -q "ANTHROPIC_API_KEY"; then
  bad "the first line should not be a variable name: $first_line"
else
  ok
fi

new_case "only ANTHROPIC_API_KEY missing: exactly one thing is reported missing"
live_state
run
assert_rc 1
assert_count 1 "MISSING"

new_case "only ANTHROPIC_API_KEY missing: names the affected features in English"
live_state
run
assert_has "- Ask Infinity"
assert_has "- plan-set reading"
# Every writing feature runs on this one key now, so the headline names two of
# them and counts the rest. A bare count ("7 app features") would leave the
# owner unable to tell a small problem from a dead app.
# Wave P added extract-receipt as an ANTHROPIC_API_KEY consumer: the census
# in this sentence counts real functions, so it moves when they do.
assert_first_line_has "Ask Infinity, reading receipts and 7 other features need an API key"

new_case "only ANTHROPIC_API_KEY missing: says where to click, not just a command"
live_state
run
assert_has "https://supabase.com/dashboard"
assert_has "Project Settings -> Edge Functions -> Secrets"
assert_has "Re-run this workflow"

new_case "only ANTHROPIC_API_KEY missing: says nothing actually broke"
live_state
run
assert_has "This is not something that broke"

new_case "the plain-English cause is handed to the workflow for Slack"
live_state
run
assert_rc 1
assert_output_var "missing_headline=Ask Infinity"
assert_output_var "missing_count=1"

# The optional variables are the ones with a working default in code, so a
# missing one changes nothing at runtime. Reporting them would be crying wolf.
new_case "optional variables are never reported missing"
live_state
run
assert_lacks "ANTHROPIC_MODEL"
assert_lacks "MISSING  VAPID_SUBJECT"
assert_lacks "OPENAI_MODEL"

# Supabase injects these into every function. Asking a human to set them would
# be asking for something impossible.
new_case "platform-injected variables are never reported missing"
live_state
run
assert_lacks "MISSING  SUPABASE_URL"
assert_lacks "MISSING  SUPABASE_ANON_KEY"
assert_lacks "MISSING  SUPABASE_SERVICE_ROLE_KEY"
assert_lacks "SUPABASE_DB_URL"

new_case "a passing run writes no cause for Slack to lead with"
# shellcheck disable=SC2086
write_stub_listing $REQUIRED
run
assert_rc 0
if [ -s "$root/github_output" ]; then
  bad "a passing run should write no outputs (got: $(cat "$root/github_output"))"
else
  ok
fi

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
