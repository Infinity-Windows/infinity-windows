#!/usr/bin/env bash
# Tests for scripts/advisory-comment.sh.
#
# Every case stubs gh, so nothing here touches GitHub, a token, or a network.
# The stub records the method and the path it was called with, and answers the
# listing from a file the case writes.
#
# WHAT MATTERS, and so what is pinned here:
#
#   * ONE comment. The second run must UPDATE, not add. A review that posts a
#     new comment on every push buries the human conversation within a day.
#   * the marker travels in the body, so the update finds it again.
#   * it never fails. A GitHub hiccup says so in the log and exits 0, because
#     the comment is not worth turning a pull request red over.
#   * a body too long for GitHub is cut with a line saying it was cut, rather
#     than lost whole.
#
#   scripts/advisory-comment.test.sh
#   scripts/advisory-comment.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/advisory-comment.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
  echo "[]" >"$root/listing.json"
  printf 'Findings go here.\n' >"$root/body.md"
  LIST_RC=0
  WRITE_RC=0
}

# A gh that answers the listing from a file, records every call, and can be told
# to fail either half.
stub_gh() {
  cat >"$root/bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$root/calls.txt"
for a in "\$@"; do
  case "\$a" in
    --method) next=method ;;
    PATCH|POST) [ "\${next:-}" = method ] && echo "\$a" >>"$root/methods.txt"; next= ;;
    body=@*) cp "\${a#body=@}" "$root/posted-body.md" ;;
  esac
done
if printf '%s' "\$*" | grep -q -- '--method'; then
  [ "$WRITE_RC" -ne 0 ] && { echo "gh: write refused" >&2; exit $WRITE_RC; }
  echo '{"id":999}'
  exit 0
fi
[ "$LIST_RC" -ne 0 ] && { echo "gh: listing refused" >&2; exit $LIST_RC; }
if printf '%s' "\$*" | grep -q -- '--jq'; then
  python3 - "$root/listing.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
hit = next(
    (
        r
        for r in rows
        if r.get("user", {}).get("type") == "Bot"
        and "<!-- advisory-review" in r.get("body", "")
    ),
    None,
)
print(str(hit["id"]) + "\t" + hit["body"] if hit else "null")
PY
  exit 0
fi
cat "$root/listing.json"
exit 0
STUB
  chmod +x "$root/bin/gh"
}

count() {
  stub_gh
  OUT="$(env PATH="$root/bin:$PATH" GH_BIN=gh GH_REPO="Infinity-Windows/infinity-windows" \
    ADVISORY_TODAY="2026-09-06" bash "$SCRIPT" --pr 4242 --count 2>&1)"
  RC=$?
}

run() {
  stub_gh
  OUT="$(env PATH="$root/bin:$PATH" GH_BIN=gh GH_REPO="Infinity-Windows/infinity-windows" \
    ADVISORY_TODAY="2026-09-06" \
    bash "$SCRIPT" --pr 4242 --body-file "$root/body.md" --runs "${RUNS_OVERRIDE:-1}" 2>&1)"
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
  if [ "$RC" = "$1" ]; then ok; else bad "expected exit $1, got $RC. Output:
$OUT"; fi
}

assert_has() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then ok; else bad "expected to see \"$1\". Output:
$OUT"; fi
}

assert_lacks() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then bad "did not expect \"$1\". Output:
$OUT"; else ok; fi
}

assert_method() {
  if [ -f "$root/methods.txt" ] && grep -qxF -- "$1" "$root/methods.txt"; then ok
  else bad "expected a $1. Calls:
$(cat "$root/calls.txt" 2>/dev/null)"; fi
}

assert_no_method() {
  if [ -f "$root/methods.txt" ] && grep -qxF -- "$1" "$root/methods.txt"; then
    bad "did not expect a $1"
  else ok; fi
}

assert_body_has() {
  if [ -f "$root/posted-body.md" ] && grep -qF -- "$1" "$root/posted-body.md"; then ok
  else bad "expected the posted body to contain \"$1\""; fi
}

# ---------------------------------------------------------------------------
new_case "the first run posts one comment"
run
assert_rc 0
assert_method POST
assert_no_method PATCH
assert_has "posted a new comment on #4242"
assert_body_has "<!-- advisory-review runs="
assert_body_has "Findings go here."

new_case "the second run updates the comment the first one left"
cat >"$root/listing.json" <<'JSON'
[{"id": 11, "body": "Looks good to me"},
 {"id": 22, "user": {"type": "Bot"}, "body": "<!-- advisory-review -->\nAn earlier review"}]
JSON
printf 'A newer review.\n' >"$root/body.md"
run
assert_rc 0
assert_method PATCH
assert_no_method POST
assert_has "updated comment 22"
assert_body_has "A newer review."

new_case "somebody else's comment is never rewritten"
cat >"$root/listing.json" <<'JSON'
[{"id": 11, "user": {"type": "User"}, "body": "Please also fix the thing"},
 {"id": 12, "user": {"type": "User"}, "body": "advisory-review is a good idea"}]
JSON
run
assert_rc 0
assert_method POST
assert_no_method PATCH

new_case "a stranger who pastes the marker does not get their comment taken over"
# This repository is public: anybody can comment. Matching on the marker alone
# meant a drive-by comment containing `<!-- advisory-review -->` would be
# PATCHed — their words replaced by ours, with a pull-requests:write token.
cat >"$root/listing.json" <<'JSON'
[{"id": 99, "user": {"type": "User"}, "body": "drive-by <!-- advisory-review runs=9 on=2026-09-06 -->"},
 {"id": 100, "user": {"type": "Bot"}, "body": "<!-- advisory-review runs=1 on=2026-09-06 -->\nOurs"}]
JSON
run
assert_rc 0
assert_method PATCH
assert_has "updated comment 100"
assert_lacks "updated comment 99"

new_case "a stranger cannot spend the day's run allowance either"
# The cap rides in the marker, so a planted `runs=9` used to read as nine runs
# already spent and switch the reading half off for the day.
cat >"$root/listing.json" <<'JSON'
[{"id": 99, "user": {"type": "User"}, "body": "drive-by <!-- advisory-review runs=9 on=2026-09-06 -->"}]
JSON
count
assert_rc 0
assert_has "0"
assert_lacks "9"

new_case "with only a stranger's marker there, a fresh comment is posted"
cat >"$root/listing.json" <<'JSON'
[{"id": 99, "user": {"type": "User"}, "body": "drive-by <!-- advisory-review runs=9 on=2026-09-06 -->"}]
JSON
run
assert_rc 0
assert_method POST
assert_no_method PATCH

new_case "a GitHub that will not answer is a log line, not a red build"
LIST_RC=1
run
assert_rc 0
assert_has "could not read the existing comments"
assert_no_method POST

new_case "a GitHub that will not accept the comment is a log line, not a red build"
WRITE_RC=1
run
assert_rc 0
assert_has "could not post a comment"

new_case "a review too long for one comment is cut, and says it was cut"
awk 'BEGIN { for (i = 0; i < 4000; i++) print "a line of findings that goes on and on and on" }' \
  >"$root/body.md"
run
assert_rc 0
assert_method POST
assert_body_has "Cut here"
if [ "$(wc -c <"$root/posted-body.md")" -lt 66000 ]; then ok
else bad "the posted body was still over GitHub's limit"; fi

# ---------------------------------------------------------------------------
# The run counter, which is why the workflow needs no `actions: read`
# ---------------------------------------------------------------------------
new_case "with no comment yet, today's count is nought"
count
assert_rc 0
assert_has "0"

new_case "a stamp from today is the count"
cat >"$root/listing.json" <<'JSON'
[{"id": 22, "user": {"type": "Bot"}, "body": "<!-- advisory-review runs=3 on=2026-09-06 -->\nAn earlier review"}]
JSON
count
assert_rc 0
assert_has "3"

new_case "a stamp from yesterday counts as nought, because the cap is per day"
cat >"$root/listing.json" <<'JSON'
[{"id": 22, "user": {"type": "Bot"}, "body": "<!-- advisory-review runs=5 on=2026-09-05 -->\nYesterday's review"}]
JSON
count
assert_rc 0
assert_has "0"

new_case "a GitHub that will not answer still gives a number, so the review is not blocked"
LIST_RC=1
count
assert_rc 0
assert_has "0"

new_case "the count written back is the one it was told"
RUNS_OVERRIDE=4 run
unset RUNS_OVERRIDE
assert_rc 0
assert_body_has "runs=4 on=2026-09-06"

# ---------------------------------------------------------------------------
echo
if [ "$failed" -eq 0 ]; then
  echo "advisory-comment: $passed checks passed"
  exit 0
fi
echo "advisory-comment: $failed FAILED, $passed passed"
exit 1
