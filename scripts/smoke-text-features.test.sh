#!/usr/bin/env bash
# Tests for scripts/smoke-text-features.sh.
#
# That script is the only check that can tell a writing feature which really
# reaches Claude from one which returns 200 and writes nothing. What matters here
# is that it keeps those apart, because they are indistinguishable from outside:
#
#   • a planset read as zero openings looks like a planset with no openings;
#   • a toolbox talk saved with no hazards and no steps looks like a saved talk;
#   • a spend cap and a busy provider look like a failure but prove nothing, and
#     a check that goes red for either is one the team stops reading;
#   • a feature that could not be exercised for want of data must be reported as
#     NOT TESTED and never counted as working.
#
# Every case drives a fake `curl` first on PATH. No network, no project, no key.
#
#   scripts/smoke-text-features.test.sh
#   scripts/smoke-text-features.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/smoke-text-features.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# A fake curl that answers per ENDPOINT, since this script talks to four
# functions and three tables in one run. It picks a fixture from the case
# directory by matching the URL, defaulting to 200 '{}' when a case did not care.
write_fake_curl() {
  cat >"$root/bin/curl" <<'FAKE'
#!/usr/bin/env bash
out=""
prev=""
url=""
method="GET"
for arg in "$@"; do
  case "$prev" in
  -o) out="$arg" ;;
  -X) method="$arg" ;;
  esac
  case "$arg" in
  http*) url="$arg" ;;
  esac
  prev="$arg"
done
cat >/dev/null

key=other
case "$url" in
*extract-schedule*) key=schedule ;;
*generate-toolbox-talk*) key=talk ;;
*generate-howto*) key=howto ;;
*synthesize-type-tips*) key=tips ;;
*safety_talks*) key=talkrow ;;
*window_types?golden*) key=goldentype ;;
*window_types*) key=tipsrow ;;
*install_events*) key=eventrow ;;
esac
[ "$method" = "DELETE" ] && key=delete

printf '%s %s\n' "$method" "$key" >>"$FAKE_DIR/calls"

body="$FAKE_DIR/$key.body"
status="$FAKE_DIR/$key.status"
[ -f "$body" ] || printf '{}' >"$body"
[ -n "$out" ] && cp "$body" "$out"
if [ -f "$status" ]; then
  printf '%s' "$(cat "$status")"
else
  printf '200'
fi
exit 0
FAKE
  chmod +x "$root/bin/curl"
}

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin" "$root/fake"
  write_fake_curl
  : >"$root/fake/calls"
  # Sensible defaults: everything answers well, so a case only states its own
  # deviation and the tests read as one idea each.
  respond schedule 200 '{"rows":[{"openingCode":"W1","qty":4},{"openingCode":"W2","qty":1},{"openingCode":"D1","qty":2}]}'
  respond talk 200 '{"ok":true,"talk_id":"t-1","title":"Ladders: three points of contact"}'
  respond talkrow 200 '[{"title":"Ladders: three points of contact","sections_json":{"key_hazards":["a","b","c"],"steps":["1","2","3","4"]}}]'
  respond goldentype 200 '[{"id":"wt-1","type_code":"SH-3060"}]'
  respond howto 200 '{"ok":true,"steps":7}'
  respond eventrow 200 '[{"window_type_id":"wt-2"}]'
  respond tips 200 '{"ok":true,"results":[{"type_code":"SH-3060","updated":true,"installs":6}]}'
  respond tipsrow 200 '[{"tips_json":["pre-drill the hinge side","dry-fit before sealing"],"watch_outs_json":["sill pan drains backwards"]}]'
}

# respond <key> <status> <body>
respond() {
  printf '%s' "$2" >"$root/fake/$1.status"
  printf '%s' "$3" >"$root/fake/$1.body"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    FAKE_DIR="$root/fake" \
    SUPABASE_PROJECT_REF=testref \
    SUPABASE_SERVICE_ROLE_KEY=test-jwt \
    TEXT_SMOKE_TIMEOUT=5 \
    "$@" \
    bash "$SCRIPT" 2>&1)"
  RC=$?
}

ok() {
  passed=$((passed + 1))
  [ "$VERBOSE" -eq 1 ] && echo "  ok: $1"
  return 0
}

bad() {
  failed=$((failed + 1))
  echo "FAIL: $current" >&2
  echo "      $1" >&2
  return 0
}

assert_rc() {
  [ "$RC" = "$1" ] && ok "rc $1" || bad "expected exit $1, got $RC. Output: $OUT"
}

assert_has() {
  case "$OUT" in
  *"$1"*) ok "contains '$1'" ;;
  *) bad "output is missing '$1'. Output: $OUT" ;;
  esac
}

assert_lacks() {
  case "$OUT" in
  *"$1"*) bad "output should not contain '$1'. Output: $OUT" ;;
  *) ok "lacks '$1'" ;;
  esac
}

assert_called() {
  if grep -q "$1" "$root/fake/calls"; then
    ok "called $1"
  else
    bad "expected a '$1' call. Calls: $(tr '\n' ';' <"$root/fake/calls")"
  fi
}

# --------------------------------------------------------------------------

new_case "everything answers: passes and prints the generated content"
run
assert_rc 0
assert_has "The writing features work"
assert_has "reading delivery schedules"
assert_has "3 schedule row(s)"
assert_has "toolbox talks"
assert_has "Ladders: three points of contact"
assert_has "how-to guides"
assert_has "7 step(s)"
assert_has "window-type tips"
assert_has "2 tip(s)"

new_case "the test toolbox talk is deleted again, so the Safety screen stays clean"
run
assert_rc 0
assert_called "DELETE delete"

new_case "a planset that reads as zero openings is a failure, not an empty planset"
respond schedule 200 '{"rows":[]}'
run
assert_rc 1
assert_has "reading delivery schedules is not working"
assert_has "no usable output"

new_case "a saved-but-empty toolbox talk is a failure, not a saved talk"
# The exact shape a broken strict-JSON path produces: the row saves, the title is
# there, and the content the crew would read is missing.
respond talkrow 200 '[{"title":"Ladder safety","sections_json":{"key_hazards":[],"steps":[]}}]'
run
assert_rc 1
assert_has "the talk is empty"
assert_has "broken JSON path"

new_case "tips that report success but save nothing is a failure"
respond tipsrow 200 '[{"tips_json":[],"watch_outs_json":[]}]'
run
assert_rc 1
assert_has "saved no tips"

new_case "a failure still shows what IS working, so the report is actionable"
respond schedule 200 '{"rows":[]}'
run
assert_rc 1
assert_has "Working, for contrast"
assert_has "toolbox talks"

new_case "no reference install: the how-to is reported NOT TESTED, never as a pass"
respond goldentype 200 '[]'
run
assert_rc 0
assert_has "NOT TESTED"
assert_has "no window type has a reference install recorded yet"

new_case "no install memos: the tips are reported NOT TESTED"
respond eventrow 200 '[]'
run
assert_rc 0
assert_has "no install has been recorded against a window type yet"

new_case "a spend limit warns and never goes red"
respond schedule 200 '{"rows":[],"limited":true,"limit_reason":"monthly_cap"}'
run
assert_rc 2
assert_has "an AI spend limit refused the call"
assert_lacks "is not working"

new_case "a busy AI service warns and never goes red"
respond talk 500 '{"error":"Anthropic chat failed: 529 overloaded_error"}'
run
assert_rc 2
assert_has "the AI service was busy"
assert_lacks "is not working"

new_case "a rejected key IS red, and says to replace the key"
respond talk 500 '{"error":"Anthropic JSON chat failed: 401 invalid x-api-key"}'
run
assert_rc 1
assert_has "toolbox talks is not working: an API key the provider refused"
assert_has "ANTHROPIC_API_KEY and re-run Deploy backend"

new_case "an unreadable answer says it is a code problem, not a key problem"
# The failure this whole migration risks: the provider answers, and the answer
# does not arrive in a shape the app can read.
respond talk 500 '{"error":"Anthropic returned no parseable JSON object"}'
run
assert_rc 1
assert_has "an answer the app could not read"
assert_has "anthropicJson.ts"
assert_lacks "ANTHROPIC_API_KEY and re-run"

new_case "nothing exercisable at all: warns rather than claiming anything"
respond schedule 200 '{"rows":[],"limited":true}'
respond talk 200 '{"limited":true}'
respond goldentype 200 '[]'
respond eventrow 200 '[]'
run
assert_rc 2
assert_has "none could be exercised"

new_case "no credentials: says nothing was measured"
OUT="$(env PATH="$root/bin:$PATH" FAKE_DIR="$root/fake" \
  SUPABASE_PROJECT_REF=testref bash "$SCRIPT" 2>&1)"
RC=$?
assert_rc 2
assert_has "no caller credentials"
assert_has "Nothing was measured"

new_case "no project ref: refuses rather than guessing which project"
OUT="$(env PATH="$root/bin:$PATH" FAKE_DIR="$root/fake" \
  SUPABASE_SERVICE_ROLE_KEY=test-jwt bash "$SCRIPT" 2>&1)"
RC=$?
assert_rc 1
assert_has "SUPABASE_PROJECT_REF is not set"

new_case "it scopes the tips run to one window type, never the whole catalog"
run
assert_rc 0
# Rewriting every window type's tips is not something a verification step may do.
if grep -q 'POST tips' "$root/fake/calls" &&
  [ "$(grep -c 'POST tips' "$root/fake/calls")" = "1" ]; then
  ok "one tips call"
else
  bad "expected exactly one synthesize-type-tips call"
fi

new_case "no customer data reaches the log: the planset text is invented here"
run
assert_rc 0
assert_has "test planset"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
