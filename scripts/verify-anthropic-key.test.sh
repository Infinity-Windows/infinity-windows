#!/usr/bin/env bash
# Tests for scripts/verify-anthropic-key.sh.
#
# Every case stubs `curl`, so nothing here reaches Anthropic, needs a key, or
# spends a cent. The distinctions worth pinning down are the ones that decide
# whether a human is called out of bed:
#
#   a refused key      -> red, and it says which kind of refusal
#   an unpaid account  -> red, but the fix is billing, NOT a new key
#   a busy service     -> a warning, because that is not our fault
#   no key at all      -> a warning, because nothing was measured
#
#   scripts/verify-anthropic-key.test.sh
#   scripts/verify-anthropic-key.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/verify-anthropic-key.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

FAKE_KEY='sk-ant-fake-not-a-real-key'

# A fake curl. Writes the case's canned body wherever -o points, prints the
# case's status, and records its argv so a test can prove the key never appears
# on a command line.
write_fake_curl() {
  cat >"$root/bin/curl" <<'FAKE'
#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
done
printf '%s\n' "$@" >>"$FAKE_ARGV"
cat >/dev/null
[ -n "$out" ] && [ -f "$FAKE_BODY" ] && cp "$FAKE_BODY" "$out"
[ -n "${FAKE_STDERR:-}" ] && printf '%s\n' "$FAKE_STDERR" >&2
[ "$FAKE_STATUS" != "-" ] && printf '%s' "$FAKE_STATUS"
exit "${FAKE_RC:-0}"
FAKE
  chmod +x "$root/bin/curl"
}

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
  write_fake_curl
  : >"$root/body"
  : >"$root/argv"
}

# respond <status> <body>
respond() {
  FAKE_STATUS="$1"
  printf '%s' "$2" >"$root/body"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    FAKE_BODY="$root/body" \
    FAKE_ARGV="$root/argv" \
    FAKE_STATUS="${FAKE_STATUS:-200}" \
    FAKE_RC="${FAKE_RC:-0}" \
    FAKE_STDERR="${FAKE_STDERR:-}" \
    ANTHROPIC_API_KEY="${KEY_OVERRIDE-$FAKE_KEY}" \
    GITHUB_OUTPUT="$root/github_output" \
    ANTHROPIC_VERIFY_TIMEOUT=5 \
    bash "$SCRIPT" 2>&1)"
  RC=$?
  if [ "$VERBOSE" = 1 ]; then
    echo "--- $current (rc=$RC)"
    echo "$OUT"
  fi
  unset FAKE_STATUS FAKE_RC FAKE_STDERR
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

# --- accepted: the only green outcome --------------------------------------

new_case "a key Anthropic accepts passes, and the reply is shown as proof"
respond 200 '{"content":[{"type":"text","text":"A shim holds the window square and level in the opening."}]}'
run
assert_rc 0
assert_first_line_has "The AI key works"
assert_has "A shim holds the window square and level in the opening."
assert_has "ACCEPTED"

new_case "a passing run writes no cause for Slack to lead with"
respond 200 '{"content":[{"type":"text","text":"Real text."}]}'
run
assert_rc 0
if [ -s "$root/github_output" ]; then
  bad "a passing run should write no outputs (got: $(cat "$root/github_output"))"
else
  ok
fi

new_case "non-text blocks are ignored when reading the reply"
respond 200 '{"content":[{"type":"thinking","text":"hmm"},{"type":"text","text":"The real answer."}]}'
run
assert_rc 0
assert_has "The real answer."

new_case "a 200 with no text at all is not a pass"
respond 200 '{"content":[]}'
run
assert_rc 1
assert_has "returned an error"

# --- refused, and which kind changes what a human does ---------------------

new_case "a rejected key is red and says to replace the key"
respond 401 '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
run
assert_rc 1
assert_first_line_has "The AI key is not valid"
assert_has "console.anthropic.com"
assert_has "Deploy backend"

new_case "a rejected key hands the cause to the workflow for Slack"
respond 401 '{"type":"error","error":{"type":"authentication_error"}}'
run
assert_rc 1
assert_output_var "anthropic_key_headline=The AI key is not valid"

# A key that works on an account with no credit is NOT a key to replace, and
# telling somebody to make a new one would waste their afternoon.
new_case "an unpaid account is distinguished from a bad key"
respond 400 '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}'
run
assert_rc 1
assert_first_line_has "cannot be billed"
assert_has "does not need changing"
assert_lacks "is not valid"

new_case "a permission error is treated as a billing problem, not a bad key"
respond 403 '{"type":"error","error":{"type":"permission_error","message":"not allowed"}}'
run
assert_rc 1
assert_first_line_has "cannot be billed"

# A wrong model name is a code problem. Blaming the key would send somebody
# hunting for a credential that is perfectly fine.
new_case "an unknown model blames the model, not the key"
respond 404 '{"type":"error","error":{"type":"not_found_error","message":"model not found"}}'
run
assert_rc 1
assert_first_line_has "the model we ask for does not exist"
assert_has "key is fine"

# --- could not tell: warn, never go red -----------------------------------

new_case "an overloaded service is a warning, not a failure"
respond 529 '{"type":"error","error":{"type":"overloaded_error"}}'
run
assert_rc 2
assert_has "Anthropic was busy"
assert_has "not a bad key"

new_case "a rate limit is a warning, not a failure"
respond 429 '{"type":"error","error":{"type":"rate_limit_error"}}'
run
assert_rc 2
assert_has "Anthropic was busy"

new_case "no answer at all is a warning that says nothing was measured"
FAKE_STATUS="-" FAKE_RC=6 FAKE_STDERR="could not resolve host" run
assert_rc 2
assert_has "never answered"
assert_has "could not resolve host"

new_case "no key at all is a warning, not a failure"
KEY_OVERRIDE="" run
assert_rc 2
assert_has "no key here to test"
assert_lacks "not valid"

new_case "a whitespace-only key counts as no key"
KEY_OVERRIDE="   " run
assert_rc 2
assert_has "no key here to test"

# --- the key itself is never exposed --------------------------------------

new_case "the key never reaches the log"
respond 200 '{"content":[{"type":"text","text":"Real text."}]}'
run
assert_rc 0
assert_lacks "$FAKE_KEY"

# argv is visible to any other process on the machine via `ps`, so the key must
# travel in a header file rather than on the command line.
new_case "the key never reaches the command line"
respond 200 '{"content":[{"type":"text","text":"Real text."}]}'
run
assert_rc 0
if grep -qF -- "$FAKE_KEY" "$root/argv" 2>/dev/null; then
  bad "the key must not appear in curl's argv (argv: $(cat "$root/argv"))"
else
  ok
fi

new_case "the key is not printed on a failure either"
respond 401 '{"type":"error","error":{"type":"authentication_error"}}'
run
assert_rc 1
assert_lacks "$FAKE_KEY"

# A key pasted into GitHub's secrets box can carry a newline, which would
# otherwise fail here for a reason nobody would guess.
new_case "a key with a trailing newline is trimmed and still works"
respond 200 '{"content":[{"type":"text","text":"Real text."}]}'
KEY_OVERRIDE="$FAKE_KEY
" run
assert_rc 0
assert_has "ACCEPTED"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
