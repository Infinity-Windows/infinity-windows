#!/usr/bin/env bash
# Tests for scripts/sync-function-secrets.sh.
#
# Every case stubs the Supabase CLI, so nothing here needs a token, a project or
# a network, and no real secret is ever involved. The stub records the arguments
# it was called with and a copy of the env file it was handed, which is what lets
# these tests assert the two properties that actually matter:
#
#   1. it pushes the names it was given, and
#   2. it NEVER unsets, replaces or renames anything.
#
# That second one is the whole safety case for running this on every merge, so it
# is pinned down here rather than left to a careful reading of the script.
#
#   scripts/sync-function-secrets.test.sh
#   scripts/sync-function-secrets.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/sync-function-secrets.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# A value that would break a naive env-file writer: a dollar sign, a hash, a
# space and an equals sign. Fake, but shaped like the awkward end of real keys.
AWKWARD='sk-ant-fake$notavar#nocomment a=b'

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin"
  write_stub 0
}

# write_stub <exit code> [stdout line...]
write_stub() {
  local rc="$1"
  shift
  {
    echo '#!/usr/bin/env bash'
    # Record argv one per line, and the env file's contents if one was passed.
    echo "printf '%s\\n' \"\$@\" >>'$root/argv'"
    echo 'prev=""'
    echo 'for a in "$@"; do'
    echo "  [ \"\$prev\" = '--env-file' ] && cp \"\$a\" '$root/envfile'"
    echo '  prev="$a"'
    echo 'done'
    if [ "$#" -gt 0 ]; then
      echo "cat <<'CLIOUT'"
      printf '%s\n' "$@"
      echo 'CLIOUT'
    fi
    echo "exit $rc"
  } >"$root/bin/supabase"
  chmod +x "$root/bin/supabase"
}

# run [VAR=value ...] — anything passed is exported for the script only.
run() {
  OUT="$(env -i PATH="$root/bin:$PATH" HOME="$HOME" \
    SUPABASE_BIN="$root/bin/supabase" \
    SUPABASE_ACCESS_TOKEN="${TOKEN_OVERRIDE-sbp_test}" \
    SUPABASE_PROJECT_REF="${REF_OVERRIDE-testref}" \
    GITHUB_OUTPUT="$root/github_output" \
    "$@" \
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

# assert_argv_has <string> — the CLI was called with this argument.
assert_argv_has() {
  if grep -qxF -- "$1" "$root/argv" 2>/dev/null; then
    ok
  else
    bad "the CLI was never called with '$1' (argv: $(cat "$root/argv" 2>&1))"
  fi
}

assert_argv_lacks() {
  if grep -qF -- "$1" "$root/argv" 2>/dev/null; then
    bad "the CLI must never be called with '$1' (argv: $(cat "$root/argv"))"
  else
    ok
  fi
}

assert_not_called() {
  if [ -e "$root/argv" ]; then
    bad "the CLI should not have been called at all (argv: $(cat "$root/argv"))"
  else
    ok
  fi
}

# assert_envfile_has <string> — the env file handed to the CLI contained this.
assert_envfile_has() {
  if grep -qF -- "$1" "$root/envfile" 2>/dev/null; then
    ok
  else
    bad "the env file is missing '$1' (got: $(cat "$root/envfile" 2>&1))"
  fi
}

assert_envfile_lacks() {
  if grep -qF -- "$1" "$root/envfile" 2>/dev/null; then
    bad "the env file should not mention '$1' (got: $(cat "$root/envfile"))"
  else
    ok
  fi
}

assert_output_var() {
  if grep -qF -- "$1" "$root/github_output" 2>/dev/null; then
    ok
  else
    bad "GITHUB_OUTPUT should contain '$1' (got: $(cat "$root/github_output" 2>&1))"
  fi
}

# --- the case this was written for -----------------------------------------
#
# ANTHROPIC_API_KEY is in GitHub and nothing else is. That is the live state as
# of 2026-07-29, and the run has to push the one it has, leave the others alone,
# and go green.

new_case "the one secret GitHub has is pushed"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 0
assert_argv_has "secrets"
assert_argv_has "set"
assert_argv_has "--project-ref"
assert_argv_has "testref"
assert_envfile_has "ANTHROPIC_API_KEY"
assert_has "pushed         ANTHROPIC_API_KEY"

new_case "secrets GitHub does not have are skipped, not cleared"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 0
assert_has "not in GitHub  OPENAI_API_KEY"
assert_envfile_lacks "OPENAI_API_KEY"
assert_has "left alone rather than cleared"

new_case "a missing secret is a warning, never a red X"
run
assert_rc 0
assert_has "Nothing to push"
assert_has "not a failure"
assert_not_called

# --- never destructive -----------------------------------------------------
#
# The safety case for running this unattended on every merge. `secrets unset`
# would silently switch a feature off in production, and `secrets set` given the
# whole set would be a replace. Neither may ever appear.

new_case "never unsets anything"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 0
assert_argv_lacks "unset"

new_case "never touches a name the functions do not require"
run ANTHROPIC_API_KEY=sk-ant-fake SLACK_CHANGELOG_WEBHOOK=https://example.invalid
assert_rc 0
assert_envfile_lacks "SLACK_CHANGELOG_WEBHOOK"

# The public half of the push pair is a GitHub secret under a DIFFERENT name
# (VITE_VAPID_PUBLIC_KEY). Copying it into VAPID_PUBLIC_KEY would make
# scripts/verify-push-key.sh go green while push stayed broken, because the
# private half in Supabase would be from another pair. It must not be renamed.
new_case "never renames VITE_VAPID_PUBLIC_KEY onto the server's VAPID_PUBLIC_KEY"
run ANTHROPIC_API_KEY=sk-ant-fake VITE_VAPID_PUBLIC_KEY=BFakePublicKey
assert_rc 0
assert_envfile_lacks "BFakePublicKey"
assert_envfile_lacks "VAPID_PUBLIC_KEY"
assert_has "not in GitHub  VAPID_PUBLIC_KEY"

# --- no value is ever printed ----------------------------------------------

new_case "the value never reaches the log"
run ANTHROPIC_API_KEY="$AWKWARD"
assert_rc 0
assert_lacks "$AWKWARD"

new_case "the value never reaches the command line either"
run ANTHROPIC_API_KEY="$AWKWARD"
assert_rc 0
assert_argv_lacks "$AWKWARD"

# A CLI that echoed a value back would put a live key in a log that outlives the
# run, so a failure whose output contains one is withheld.
new_case "a CLI failure that echoes a value is withheld"
write_stub 1 "Error: rejected sk-ant-leaky"
run ANTHROPIC_API_KEY=sk-ant-leaky
assert_rc 1
assert_lacks "sk-ant-leaky"
assert_has "withheld"

new_case "a CLI failure that echoes no value is reported in full"
write_stub 1 "Error: project not found"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 1
assert_has "could not set secrets on testref"
assert_has "project not found"

# --- awkward values are written intact -------------------------------------
#
# A value mangled into a WRONG one is worse than a missing one: every check goes
# green and the feature fails with an authentication error nobody expects.

new_case "a value containing \$ and # is written literally"
run ANTHROPIC_API_KEY="$AWKWARD"
assert_rc 0
assert_envfile_has "'$AWKWARD'"

new_case "a value containing a quote is refused rather than mangled"
run ANTHROPIC_API_KEY="sk-ant-it's-quoted"
assert_rc 1
assert_has "contains a quote or a newline"
assert_has "Nothing was pushed"
assert_not_called
assert_lacks "it's-quoted"

# --- stray whitespace from the GitHub secrets box --------------------------
#
# A newline picked up when pasting travels with the value and makes an
# otherwise-correct key invalid. Same reasoning as readCredential() in
# scripts/lib/supabase-key.mjs, and the same rule: trim it, but say so, because
# the stored secret really is wrong and the next person will paste it the same way.

new_case "a trailing newline is trimmed off before the value is pushed"
run ANTHROPIC_API_KEY="sk-ant-fake
"
assert_rc 0
assert_envfile_has "ANTHROPIC_API_KEY='sk-ant-fake'"

new_case "surrounding spaces are trimmed too"
run ANTHROPIC_API_KEY="   sk-ant-fake  "
assert_rc 0
assert_envfile_has "ANTHROPIC_API_KEY='sk-ant-fake'"

new_case "trimming is reported rather than done silently"
run ANTHROPIC_API_KEY="sk-ant-fake
"
assert_rc 0
assert_has "had spaces or a newline around them"
assert_has "ANTHROPIC_API_KEY"
assert_has "re-saving it"

new_case "a value that needed no trimming says nothing about trimming"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 0
assert_lacks "were trimmed"

# All whitespace is not a value. Pushing it would replace a working secret with
# an empty one, which is the one way this script could break a live feature.
new_case "a whitespace-only value is treated as absent, not pushed"
run ANTHROPIC_API_KEY="   "
assert_rc 0
assert_has "not in GitHub  ANTHROPIC_API_KEY"
assert_not_called

# --- refusing to guess the project -----------------------------------------

new_case "no project ref: refuses rather than guessing"
REF_OVERRIDE="" run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 1
assert_has "SUPABASE_PROJECT_REF is not set"
assert_has "no default"
assert_not_called

new_case "no access token: pushes nothing"
TOKEN_OVERRIDE="" run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 1
assert_has "SUPABASE_ACCESS_TOKEN is not set"
assert_not_called

# --- what the workflow reads ------------------------------------------------

new_case "the workflow is told what was pushed and what is unmanaged"
run ANTHROPIC_API_KEY=sk-ant-fake
assert_rc 0
assert_output_var "pushed_count=1"
assert_output_var "pushed_names=ANTHROPIC_API_KEY"
assert_output_var "unmanaged_names=OPENAI_API_KEY"

echo
echo "passed: $passed"
echo "failed: $failed"
[ "$failed" -eq 0 ] || exit 1
