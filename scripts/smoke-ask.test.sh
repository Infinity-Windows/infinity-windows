#!/usr/bin/env bash
# Tests for scripts/smoke-ask.sh.
#
# The script's whole job is to tell three outcomes apart — answered, genuinely
# broken, and could-not-tell — and to put each real failure into words a
# non-engineer can act on. So these tests drive every branch with a fake `curl`
# first on PATH, and never touch the network, a project or a real key.
#
# The distinction that matters most is the LAST pair: a key that is missing and a
# key that Anthropic rejects both leave Ask Infinity answering nothing, but they
# need different things done about them, and no name-and-digest check can tell
# them apart at all.
#
#   scripts/smoke-ask.test.sh
#   scripts/smoke-ask.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/smoke-ask.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# A fake curl. Writes the case's canned body to wherever -o points and prints the
# case's status, so the script sees exactly what a real response looks like.
# FAKE_STATUS of "-" prints nothing, which is what a broken curl does.
write_fake_curl() {
  cat >"$root/bin/curl" <<'FAKE'
#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
done
# Drain stdin so the caller's pipe never blocks.
cat >/dev/null

# Count the calls, so a test can assert how many probes happened.
echo x >>"$FAKE_CALLS"
n="$(wc -l <"$FAKE_CALLS" | tr -d ' ')"

# From the second call on, use the *2 response if the case supplied one. That is
# what lets a test drive "missing on the first probe, present on the next".
body="$FAKE_BODY"
status="$FAKE_STATUS"
rc="${FAKE_RC:-0}"
if [ "$n" -ge 2 ] && [ -s "${FAKE_BODY2:-}" ]; then
  body="$FAKE_BODY2"
  status="${FAKE_STATUS2:-200}"
  rc=0
fi

[ -n "$out" ] && [ -f "$body" ] && cp "$body" "$out"
[ -n "${FAKE_STDERR:-}" ] && printf '%s\n' "$FAKE_STDERR" >&2
[ "$status" != "-" ] && printf '%s' "$status"
exit "$rc"
FAKE
  chmod +x "$root/bin/curl"
}

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
  write_fake_curl
  : >"$root/body"
  : >"$root/body2"
  : >"$root/calls"
}

# respond <status> <body>
respond() {
  FAKE_STATUS="$1"
  printf '%s' "$2" >"$root/body"
}

# then_respond <status> <body> — used from the SECOND probe onwards.
then_respond() {
  FAKE_STATUS2="$1"
  printf '%s' "$2" >"$root/body2"
}

# One attempt and no delay unless a case asks for more, so the suite stays fast.
run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    FAKE_BODY="$root/body" \
    FAKE_BODY2="$root/body2" \
    FAKE_CALLS="$root/calls" \
    FAKE_STATUS="${FAKE_STATUS:-200}" \
    FAKE_STATUS2="${FAKE_STATUS2:-200}" \
    FAKE_RC="${FAKE_RC:-0}" \
    FAKE_STDERR="${FAKE_STDERR:-}" \
    SUPABASE_PROJECT_REF="${REF_OVERRIDE-testref}" \
    SUPABASE_SERVICE_ROLE_KEY="${JWT_OVERRIDE-eyJfake}" \
    GITHUB_OUTPUT="$root/github_output" \
    ASK_SMOKE_TIMEOUT=5 \
    ASK_SMOKE_ATTEMPTS="${ATTEMPTS_OVERRIDE-1}" \
    ASK_SMOKE_RETRY_DELAY=0 \
    bash "$SCRIPT" 2>&1)"
  RC=$?
  if [ "$VERBOSE" = 1 ]; then
    echo "--- $current (rc=$RC)"
    echo "$OUT"
  fi
  unset FAKE_STATUS FAKE_STATUS2 FAKE_RC FAKE_STDERR
}

# assert_probes <n>
assert_probes() {
  local n
  n="$(wc -l <"$root/calls" | tr -d ' ')"
  if [ "$n" = "$1" ]; then
    ok
  else
    bad "expected $1 probe(s), got $n (output: $OUT)"
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

assert_first_line_has() {
  local first
  first="$(printf '%s\n' "$OUT" | head -n 1)"
  if printf '%s' "$first" | grep -qF -- "$1"; then
    ok
  else
    bad "first line should contain '$1' but was: $first"
  fi
}

assert_output_var() {
  if grep -qF -- "$1" "$root/github_output" 2>/dev/null; then
    ok
  else
    bad "GITHUB_OUTPUT should contain '$1' (got: $(cat "$root/github_output" 2>&1))"
  fi
}

# --- it answered: the only green outcome -----------------------------------

new_case "a real answer passes and is printed as proof"
respond 200 '{"answer":"A shim keeps the window square in the opening.","sources":[]}'
run
assert_rc 0
assert_has "ANSWERED end to end"
assert_has "A shim keeps the window square in the opening."
assert_first_line_has "Ask Infinity works"

new_case "a passing run writes no cause for Slack to lead with"
respond 200 '{"answer":"Real text."}'
run
assert_rc 0
if [ -s "$root/github_output" ]; then
  bad "a passing run should write no outputs (got: $(cat "$root/github_output"))"
else
  ok
fi

# A 200 whose answer is empty or absent is not an answer. Treating it as one
# would make this check as blind as the ones it exists to backstop.
new_case "a 200 with an empty answer is not a pass"
respond 200 '{"answer":"   "}'
run
assert_rc 1
assert_has "returned an error instead of an answer"

new_case "a 200 with no answer field at all is not a pass"
respond 200 '{"sources":[]}'
run
assert_rc 1
assert_has "instead of an answer"

# Prose containing JSON-ish punctuation must not confuse the parse.
new_case "an answer containing braces and quotes is still read correctly"
respond 200 '{"answer":"Use a {shim} and say \"square\" — 3\" gap."}'
run
assert_rc 0
assert_has 'Use a {shim} and say "square"'

# --- broken, and ours to fix: the key is not set ---------------------------

new_case "a missing key is red and says so in plain English"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
run
assert_rc 1
assert_first_line_has "Ask Infinity is not working"
assert_first_line_has "API key has not been added"
assert_has "Deploy backend"

new_case "a missing key does not lead with a variable name"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
run
first_line="$(printf '%s\n' "$OUT" | head -n 1)"
if printf '%s' "$first_line" | grep -q "ANTHROPIC_API_KEY"; then
  bad "the first line should not be a variable name: $first_line"
else
  ok
fi

new_case "a missing key hands the cause to the workflow for Slack"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
run
assert_rc 1
assert_output_var "ask_smoke_headline=Ask Infinity is not working"

# --- broken, and ours to fix: the key is REJECTED --------------------------
#
# The case no existing check in this repo can see. `secrets list` reports a name
# and a digest, so a revoked key, a key from the wrong Anthropic account and a
# perfectly good key are indistinguishable to it. This is the only check that
# can tell.

new_case "a key Anthropic rejects is red, and distinguished from a missing one"
respond 500 '{"error":"Error: Anthropic chat failed: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}"}'
run
assert_rc 1
assert_first_line_has "the AI provider rejected our API key"
assert_has "wrong key, it was"
assert_lacks "has not been added"

new_case "a rejected key explains that a digest check cannot see this"
respond 500 '{"error":"Error: Anthropic chat failed: 401 invalid x-api-key"}'
run
assert_rc 1
assert_has "only a real request can"

new_case "an Anthropic permission error is treated as a rejected key"
respond 500 '{"error":"Error: Anthropic chat failed: 403 {\"error\":{\"type\":\"permission_error\"}}"}'
run
assert_rc 1
assert_first_line_has "rejected our API key"

# --- could not tell: must warn, never go red ------------------------------
#
# Anthropic having a bad afternoon is not our misconfiguration. A check that goes
# red for it is one the team stops reading, and then it protects nothing.

new_case "an overloaded AI service is a warning, not a failure"
respond 500 '{"error":"Error: Anthropic chat failed: 529 {\"type\":\"overloaded_error\"}"}'
run
assert_rc 2
assert_has "Could not tell"
assert_has "was busy"
assert_has "The key was"

new_case "a rate limit is a warning, not a failure"
respond 500 '{"error":"Error: Anthropic chat failed: 429 rate_limit_error"}'
run
assert_rc 2
assert_has "Could not tell"

new_case "no answer at all is a warning that says nothing was measured"
FAKE_STATUS="-" FAKE_RC=6 FAKE_STDERR="could not resolve host" run
assert_rc 2
assert_has "never answered"
assert_has "VERIFICATION failure"
assert_has "could not resolve host"

new_case "a 000 status is treated as no answer"
FAKE_STATUS="000" run
assert_rc 2
assert_has "never answered"

# A gateway 401 means THIS TEST could not sign in. That is a gap in the test, not
# evidence about the feature, so it must not be reported as Ask Infinity failing.
new_case "a gateway 401 blames the checker, not the feature"
respond 401 '{"error":"unauthorized"}'
run
assert_rc 2
assert_has "could not sign in"
assert_lacks "Ask Infinity is not working"

new_case "no caller credentials: says nothing was measured"
JWT_OVERRIDE="" run
assert_rc 2
assert_has "no caller credentials"
assert_has "Nothing was measured"

# --- retries: the run that FIXES Ask Infinity must not report it broken ----
#
# Deploy backend pushes ANTHROPIC_API_KEY and then runs this seconds later. A
# just-written secret does not reach the already-running function workers
# instantly, so the first probe can legitimately see the old keyless
# environment. Without a retry, the very run that fixed the feature would go red.

new_case "a key that arrives between probes passes"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
then_respond 200 '{"answer":"A shim keeps the window square."}'
ATTEMPTS_OVERRIDE=3 run
assert_rc 0
assert_has "ANSWERED end to end"
assert_probes 2

new_case "a key that never arrives is still red, and says retrying did not help"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
ATTEMPTS_OVERRIDE=3 run
assert_rc 1
assert_probes 3
assert_has "after 3 attempt(s)"

new_case "a busy AI service is retried before warning"
respond 500 '{"error":"Error: Anthropic chat failed: 529 overloaded_error"}'
ATTEMPTS_OVERRIDE=3 run
assert_rc 2
assert_probes 3

new_case "no answer at all is retried before warning"
FAKE_STATUS="-" FAKE_RC=6 ATTEMPTS_OVERRIDE=3 run
assert_rc 2
assert_probes 3

# A rejected key is a settled answer. Retrying it would only slow the run down
# and make the log look uncertain about something that is not.
new_case "a rejected key is not retried"
respond 500 '{"error":"Error: Anthropic chat failed: 401 invalid x-api-key"}'
ATTEMPTS_OVERRIDE=3 run
assert_rc 1
assert_probes 1

new_case "a successful first probe is not repeated"
respond 200 '{"answer":"Real text."}'
ATTEMPTS_OVERRIDE=3 run
assert_rc 0
assert_probes 1

# --- refusing to guess the project ----------------------------------------

new_case "no project ref: refuses rather than guessing"
REF_OVERRIDE="" run
assert_rc 1
assert_has "SUPABASE_PROJECT_REF is not set"
assert_has "no default"

# --- the credential is never printed --------------------------------------

new_case "the caller credential never reaches the log"
respond 200 '{"answer":"Real text."}'
JWT_OVERRIDE="eyJsuper-secret-jwt" run
assert_rc 0
assert_lacks "eyJsuper-secret-jwt"

new_case "the credential is not printed on a failure either"
respond 500 '{"error":"Error: ANTHROPIC_API_KEY secret is not set"}'
JWT_OVERRIDE="eyJsuper-secret-jwt" run
assert_rc 1
assert_lacks "eyJsuper-secret-jwt"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
