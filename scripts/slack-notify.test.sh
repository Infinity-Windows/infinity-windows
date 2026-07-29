#!/usr/bin/env bash
# Tests for scripts/slack-notify.sh.
#
# The notifier's contract has two halves and both are easy to get wrong:
#   1. It says the useful things — workflow, commit, who pushed, run link.
#   2. It NEVER fails, whatever the environment does to it. It runs inside an
#      `if: failure()` job, so a non-zero exit would bury the real failure under
#      a second, more confusing one.
#
# Every case stubs `curl` (and sometimes removes `jq`) so nothing here touches
# the network or Slack.
#
#   scripts/slack-notify.test.sh
#   scripts/slack-notify.test.sh -v     # print each case's output
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/slack-notify.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0
PAYLOAD=""

# --- harness ---------------------------------------------------------------

# A fake curl that writes the POST body to a file so the test can read the exact
# JSON the real one would have sent. CURL_EXIT lets a case simulate an
# unreachable webhook.
write_fake_curl() {
  cat >"$root/bin/curl" <<'FAKE'
#!/usr/bin/env bash
body=""
next=0
for arg in "$@"; do
  if [ "$next" = 1 ]; then body="$arg"; next=0; fi
  [ "$arg" = "--data" ] && next=1
done
printf '%s' "$body" >"$CURL_LOG"
exit "${CURL_EXIT:-0}"
FAKE
  chmod +x "$root/bin/curl"
}

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
  write_fake_curl
  export CURL_LOG="$root/payload.json"
  export CURL_EXIT=0
  : >"$CURL_LOG"
}

# run <env assignments...> — invokes the script with bin/ first on PATH.
run() {
  OUT="$(env PATH="$root/bin:$PATH" "$@" bash "$SCRIPT" 2>&1)"
  RC=$?
  PAYLOAD="$(cat "$CURL_LOG" 2>/dev/null || true)"
  if [ "$VERBOSE" = 1 ]; then
    echo "--- $current"
    echo "$OUT"
    echo "payload: $PAYLOAD"
  fi
}

ok() {
  passed=$((passed + 1))
}

bad() {
  failed=$((failed + 1))
  echo "FAIL: $current"
  echo "      $1"
}

assert_rc() {
  if [ "$RC" = "$1" ]; then ok; else bad "expected exit $1, got $RC"; fi
}

# The payload is JSON, so assert against the decoded text where possible.
assert_payload_has() {
  if printf '%s' "$PAYLOAD" | grep -qF -- "$1"; then
    ok
  else
    bad "payload is missing '$1' (payload: $PAYLOAD)"
  fi
}

assert_payload_lacks() {
  if printf '%s' "$PAYLOAD" | grep -qF -- "$1"; then
    bad "payload should not contain '$1' (payload: $PAYLOAD)"
  else
    ok
  fi
}

assert_no_payload() {
  if [ -z "$PAYLOAD" ]; then ok; else bad "expected no POST, got: $PAYLOAD"; fi
}

assert_out_has() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then
    ok
  else
    bad "output is missing '$1' (output: $OUT)"
  fi
}

assert_valid_json() {
  if printf '%s' "$PAYLOAD" | jq -e . >/dev/null 2>&1; then
    ok
  else
    bad "payload is not valid JSON: $PAYLOAD"
  fi
}

# --- the happy path --------------------------------------------------------

new_case "a failure post names the workflow, commit, pusher and run"
run \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="Deploy backend" \
  RUN_URL="https://github.com/o/r/actions/runs/42" \
  COMMIT_SHA="0123456789abcdef" \
  COMMIT_MESSAGE="Ship the thing" \
  ACTOR="taylorhorizon" \
  REPO="o/r" \
  BRANCH="master"
assert_rc 0
assert_valid_json
assert_payload_has "Deploy backend"
assert_payload_has "FAILED"
assert_payload_has "Ship the thing"
assert_payload_has "0123456"
assert_payload_has "taylorhorizon"
assert_payload_has "master"
assert_payload_has "actions/runs/42"

new_case "only the first line of a squash-merge commit message is posted"
run \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="CI" \
  RUN_URL="https://example/run" \
  COMMIT_SHA="abc1234def" \
  COMMIT_MESSAGE="$(printf 'Headline here\n\nA long body\nwith several lines')" \
  ACTOR="someone"
assert_rc 0
assert_payload_has "Headline here"
assert_payload_lacks "A long body"

new_case "a warning is worded as not-broken and does not say FAILED"
run \
  NOTIFY_KIND="warning" \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="Deploy backend" \
  RUN_URL="https://example/run" \
  COMMIT_SHA="deadbeef" \
  ACTOR="someone" \
  DETAIL="2 live-only tables: project_marks, other_thing"
assert_rc 0
assert_payload_has "needs a look"
assert_payload_lacks "FAILED"
assert_payload_has "project_marks"
assert_payload_has "Nothing is broken for users"

new_case "with no run url it falls back to a commit link"
run \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="CI" \
  COMMIT_SHA="abcdef1234567890" \
  REPO="Infinity-Windows/infinity-windows" \
  ACTOR="someone"
assert_rc 0
assert_payload_has "Infinity-Windows/infinity-windows/commit/abcdef1234567890"

# --- quiet degradation -----------------------------------------------------

new_case "no webhook secret: quiet, green, and no POST attempted"
run \
  WORKFLOW_NAME="CI" \
  RUN_URL="https://example/run" \
  COMMIT_SHA="abc" \
  ACTOR="someone"
assert_rc 0
assert_no_payload
assert_out_has "not set"
assert_out_has "not a failure"

new_case "an empty webhook string is treated the same as an absent one"
run \
  SLACK_WEBHOOK="" \
  WORKFLOW_NAME="CI" \
  COMMIT_SHA="abc" \
  ACTOR="someone"
assert_rc 0
assert_no_payload

# --- it must never fail the build ------------------------------------------

new_case "an unreachable webhook still exits 0"
run \
  CURL_EXIT=7 \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="CI" \
  RUN_URL="https://example/run" \
  COMMIT_SHA="abc" \
  ACTOR="someone"
assert_rc 0
assert_out_has "not posted"

new_case "a totally empty environment still exits 0"
run
assert_rc 0

new_case "no jq available: exits 0 without posting a malformed payload"
run \
  JQ_BIN="jq-that-does-not-exist" \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="CI" \
  COMMIT_SHA="abc" \
  ACTOR="someone"
assert_rc 0
assert_no_payload
assert_out_has "jq is not available"

new_case "a commit message full of quotes and backticks stays valid JSON"
# shellcheck disable=SC2016  # The literal backticks are the point of the case.
run \
  SLACK_WEBHOOK="https://hooks.example/T/B/X" \
  WORKFLOW_NAME="CI" \
  RUN_URL="https://example/run" \
  COMMIT_SHA="abc1234" \
  COMMIT_MESSAGE='Fix "the" thing `now` \ and {stuff}: [x]' \
  ACTOR="someone"
assert_rc 0
assert_valid_json
assert_payload_has "the"

# --- summary ---------------------------------------------------------------

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
