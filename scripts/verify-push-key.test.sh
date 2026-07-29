#!/usr/bin/env bash
# Tests for scripts/verify-push-key.sh.
#
# Every case stubs the Supabase CLI, so nothing here needs a token, a project or
# a network. The behaviours worth pinning down: a matching pair passes, a
# mismatched pair fails in words a non-engineer can act on, and anything the
# script could not actually measure fails rather than passes — the same rule
# scripts/verify-functions.sh applies to an unanswered probe.
#
#   scripts/verify-push-key.test.sh
#   scripts/verify-push-key.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/verify-push-key.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# A real, well-formed VAPID public key (65-byte P-256 point, base64url). Public
# by design — the live one is readable in the published bundle — but this is a
# throwaway generated for the tests, not any project's.
KEY="BPd1cBqcTr9mfnDLWJC0dcyGCcOHnrbT7DbTX3z-e6WZOQFTsE7wD8SnnGaqNCzxJgLtDe1KE8kNiCB6nBw2Tqs"

# sha256sum on Linux, shasum on macOS.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}
KEY_DIGEST="$(sha256 "$KEY")"
OTHER_DIGEST="$(sha256 "${KEY}x")"

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

# write_stub_listing <digest for VAPID_PUBLIC_KEY>
# The same two-column table the real CLI prints, including the platform secrets
# every project has, so the parse is exercised against realistic output.
write_stub_listing() {
  write_stub 0 \
    "        NAME        |                             DIGEST" \
    "  ------------------|------------------------------------" \
    "   SUPABASE_URL | 1111111111111111111111111111111111111111111111111111111111111111" \
    "   VAPID_PRIVATE_KEY | 2222222222222222222222222222222222222222222222222222222222222222" \
    "   VAPID_PUBLIC_KEY | $1" \
    "   VAPID_SUBJECT | 3333333333333333333333333333333333333333333333333333333333333333"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    SUPABASE_BIN="$root/bin/supabase" \
    SUPABASE_ACCESS_TOKEN="${TOKEN_OVERRIDE-sbp_test}" \
    SUPABASE_PROJECT_REF="${REF_OVERRIDE-testref}" \
    VITE_VAPID_PUBLIC_KEY="${KEY_OVERRIDE-$KEY}" \
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

# The workflow lifts the first line into the GitHub error annotation and the
# Slack post, so what it says is a contract.
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

# --- the pair matches ------------------------------------------------------

new_case "the app key hashes to the project's digest: passes"
write_stub_listing "$KEY_DIGEST"
run
assert_rc 0
assert_has "matches"
assert_has "testref"

new_case "a passing run writes no cause for Slack to lead with"
write_stub_listing "$KEY_DIGEST"
run
assert_rc 0
if [ -s "$root/github_output" ]; then
  bad "a passing run should write no outputs (got: $(cat "$root/github_output"))"
else
  ok
fi

# The CLI is free to shorten the digest column. Comparing over the digest's own
# length keeps a shortened digest a narrower check rather than a false alarm.
new_case "a shortened digest still matches"
write_stub_listing "${KEY_DIGEST:0:20}"
run
assert_rc 0
assert_has "matches"

# --- the pair does not match -----------------------------------------------

new_case "a different key fails"
write_stub_listing "$OTHER_DIGEST"
run
assert_rc 1

new_case "the mismatch is explained without jargon, and leads with the consequence"
write_stub_listing "$OTHER_DIGEST"
run
assert_first_line_has "Notifications cannot reach anyone's phone"
# A variable name is not the sentence a non-engineer should read first.
first_line="$(printf '%s\n' "$OUT" | head -n 1)"
if printf '%s' "$first_line" | grep -q "VAPID"; then
  bad "the first line should not be a variable name: $first_line"
else
  ok
fi

new_case "the mismatch says nothing broke in this run"
write_stub_listing "$OTHER_DIGEST"
run
assert_has "Nothing broke in this run"

new_case "the mismatch says where to click, on both sides, and that a rebuild is needed"
write_stub_listing "$OTHER_DIGEST"
run
assert_has "https://supabase.com/dashboard"
assert_has "Project Settings -> Edge Functions -> Secrets"
assert_has "Settings -> Secrets and variables -> Actions"
assert_has "Deploy GitHub Pages"

# Anyone already subscribed signed up with the old key, so fixing the secrets is
# not enough on its own. Saying so is the difference between a fix that works and
# one that looks like it did.
new_case "the mismatch tells people to re-subscribe"
write_stub_listing "$OTHER_DIGEST"
run
assert_has "turn them off"

new_case "the plain-English cause is handed to the workflow for Slack"
write_stub_listing "$OTHER_DIGEST"
run
assert_rc 1
assert_output_var "push_key_headline=Notifications cannot reach anyone's phone"

# --- could not tell: must fail, not pass -----------------------------------

new_case "a failing CLI is a verification failure, not a mismatch"
write_stub 1 "Error: not logged in"
run
assert_rc 1
assert_has "VERIFICATION failure"
assert_has "not a mismatch"

new_case "no VAPID_PUBLIC_KEY on the project: fails and defers to the secret check"
write_stub 0 "        NAME        |     DIGEST" "  -----|-----" "   SUPABASE_URL | abc123abc123abc123"
run
assert_rc 1
assert_has "reports no VAPID_PUBLIC_KEY"
assert_has "verify-function-secrets.sh"

new_case "an unreadable digest is refused rather than read as a mismatch"
write_stub_listing "not-a-digest"
run
assert_rc 1
assert_has "changed CLI output format"

new_case "no project ref: refuses rather than guessing"
write_stub_listing "$KEY_DIGEST"
REF_OVERRIDE="" run
assert_rc 1
assert_has "SUPABASE_PROJECT_REF is not set"
assert_has "no default"

new_case "no access token: says nothing was compared"
write_stub_listing "$KEY_DIGEST"
TOKEN_OVERRIDE="" run
assert_rc 1
assert_has "SUPABASE_ACCESS_TOKEN is not set"
assert_has "VERIFICATION failure"

# --- no key and no digest is ever printed ----------------------------------

new_case "the key is never echoed, whichever way the check goes"
write_stub_listing "$KEY_DIGEST"
run
assert_rc 0
assert_lacks "$KEY"
assert_lacks "$KEY_DIGEST"

new_case "the key is not echoed on a mismatch either"
write_stub_listing "$OTHER_DIGEST"
run
assert_rc 1
assert_lacks "$KEY"
assert_lacks "$OTHER_DIGEST"

# --- no frontend key at all ------------------------------------------------
#
# An app built with no push key never subscribes a device, so nothing is
# mismatched. That is a real problem but a different one, and making this check
# red for it would put a second cause behind one headline.

new_case "no frontend key: says so plainly and passes"
write_stub_listing "$KEY_DIGEST"
KEY_OVERRIDE="" run
assert_rc 0
assert_has "nothing to compare"
assert_has "no phone"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
