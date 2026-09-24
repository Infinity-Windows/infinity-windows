#!/usr/bin/env bash
# Tests for scripts/deploy-functions.sh.
#
# What matters is that a function whose deploy blips gets a couple of quick
# retries before it counts as broken, and that a function whose deploy is
# genuinely broken still fails loudly after those retries — telling "Supabase
# had a bad moment" apart from "the code is wrong" is the whole reason this
# script exists. Every case stubs the Supabase CLI (the same SUPABASE_BIN
# indirection scripts/sync-function-secrets.sh and scripts/verify-push-key.sh
# use), so nothing here needs a token, a project or a network, and no retry
# ever really sleeps.
#
#   scripts/deploy-functions.test.sh
#   scripts/deploy-functions.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/deploy-functions.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# --- harness -----------------------------------------------------------
#
# A fake `supabase` CLI. It works out which function is being deployed from
# the argv (the name right after "deploy"), counts how many times it has been
# asked to deploy that one, and replies with the n-th line of that function's
# script: "<exit code> [stderr message]". Ran out of lines? repeats the last
# one — the same convention scripts/verify-functions.test.sh uses for its
# fake curl.
write_fake_supabase() {
  cat >"$root/bin/supabase" <<'FAKE'
#!/usr/bin/env bash
name=""
prev=""
for arg in "$@"; do
  [ "$prev" = "deploy" ] && name="$arg"
  prev="$arg"
done
echo "$@" >>"$FAKE_ARGV"

echo "$name" >>"$FAKE_LOG"
attempt="$(grep -c "^$name\$" "$FAKE_LOG")"

spec="$FAKE_DIR/$name"
line="$(sed -n "${attempt}p" "$spec")"
[ -z "$line" ] && line="$(tail -n 1 "$spec")"

rc="${line%% *}"
msg="${line#* }"
[ "$msg" = "$rc" ] && msg=""

[ -n "$msg" ] && printf '%s\n' "$msg" >&2
exit "$rc"
FAKE
  chmod +x "$root/bin/supabase"
}

# new_case <description> <function name>...
new_case() {
  current="$1"
  shift
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/bin" "$root/fake" \
    "$root/supabase/functions/_shared"
  cp "$SCRIPT" "$root/scripts/deploy-functions.sh"
  chmod +x "$root/scripts/deploy-functions.sh"
  for name in "$@"; do
    mkdir -p "$root/supabase/functions/$name"
  done
  write_fake_supabase
  : >"$root/fake/calls.log"
  : >"$root/fake/argv.log"
}

# reply <function name> <line>...   e.g. reply monday-sync "1 boom" "0"
reply() {
  local name="$1"
  shift
  printf '%s\n' "$@" >"$root/fake/$name"
}

# run [VAR=value ...] — anything passed is exported for the script only.
run() {
  : >"$root/fake/calls.log"
  : >"$root/fake/argv.log"
  OUT="$(cd "$root" \
    && PATH="$root/bin:$PATH" \
       SUPABASE_BIN="$root/bin/supabase" \
       FAKE_DIR="$root/fake" \
       FAKE_LOG="$root/fake/calls.log" \
       FAKE_ARGV="$root/fake/argv.log" \
       SUPABASE_ACCESS_TOKEN="${TOKEN_OVERRIDE-sbp_test}" \
       SUPABASE_PROJECT_REF="${REF_OVERRIDE-testref}" \
       DEPLOY_RETRY_DELAYS="0 0" \
       "$@" \
       ./scripts/deploy-functions.sh 2>&1)"
  RC=$?
  [ "$VERBOSE" = "1" ] && printf '\n--- %s ---\n%s\n' "$current" "$OUT"
  return 0
}

calls_for() { grep -c "^$1\$" "$root/fake/calls.log" 2>/dev/null; }

ok()   { passed=$((passed + 1)); printf '  ok    %s\n' "$1"; }
bad()  { failed=$((failed + 1)); printf '  FAIL  %s\n' "$1"
         printf '        ---- output ----\n%s\n        ----------------\n' "$OUT"; }

expect_rc() {
  if [ "$RC" = "$1" ]; then ok "$2 (exit $1)"; else
    bad "$2 — expected exit $1, got $RC"
  fi
}
expect_out() {
  case "$OUT" in *"$1"*) ok "$2" ;; *) bad "$2 — output lacks \"$1\"" ;; esac
}
expect_no_out() {
  case "$OUT" in *"$1"*) bad "$2 — output should not contain \"$1\"" ;; *) ok "$2" ;; esac
}
expect_calls() {
  local got
  got="$(calls_for "$1")"
  if [ "$got" = "$2" ]; then ok "$3 ($2 attempt(s))"; else
    bad "$3 — expected $2 attempt(s) of $1, got $got"
  fi
}
expect_argv_has() {
  if grep -qF -- "$1" "$root/fake/argv.log" 2>/dev/null; then
    ok "the CLI was called with $1"
  else
    bad "the CLI was never called with $1 (argv: $(cat "$root/fake/argv.log" 2>&1))"
  fi
}

# --- cases ---------------------------------------------------------------

echo "success on the first try"
new_case "first-try" monday-sync
reply monday-sync "0"
run
expect_rc 0 "exits clean"
expect_out "deployed monday-sync" "reports it deployed"
expect_out "deployed 1 function(s)" "counts it"
expect_calls monday-sync 1 "a clean deploy is not retried"
expect_argv_has "--project-ref testref"
expect_argv_has "--use-api"

echo
echo "one transient failure then success"
new_case "transient" monday-sync
reply monday-sync "1 boom" "0"
run
expect_rc 0 "still exits clean overall"
expect_calls monday-sync 2 "retried exactly once, then stopped"
expect_out "retrying monday-sync after a Supabase internal error, attempt 2 of 3" \
  "logs the retry plainly, matching the incident's own wording"
expect_out "deployed monday-sync" "counted as deployed"
expect_no_out "::error" "a function that eventually succeeds is never annotated"

echo
echo "three failures in a row"
new_case "hard-failure" extract-schedule
reply extract-schedule "1 boom" "1 boom" "1 boom"
run
expect_rc 1 "fails after exhausting every retry"
expect_calls extract-schedule 3 "tried 3 times total, then gave up"
expect_out "retrying extract-schedule after a Supabase internal error, attempt 2 of 3" \
  "logs the first retry"
expect_out "retrying extract-schedule after a Supabase internal error, attempt 3 of 3" \
  "logs the second retry"
expect_out "::error title=Function deploy failed::extract-schedule" \
  "annotates the specific function"
expect_out "failed to deploy: extract-schedule" "names it in the summary"

echo
echo "_shared is never deployed"
new_case "shared" ask
reply ask "0"
run
expect_rc 0 "passes"
expect_no_out "_shared" "_shared never appears in the log"
expect_calls ask 1 "ask itself was still deployed"

echo
echo "one function fails, another succeeds"
new_case "mixed" ask monday-sync
reply ask "0"
reply monday-sync "1 boom" "1 boom" "1 boom"
run
expect_rc 1 "fails overall — one real failure is enough"
expect_out "deployed ask" "the healthy one still deployed"
expect_out "failed to deploy: monday-sync" "and the broken one is named"
expect_no_out "failed to deploy: ask" "the healthy one is never blamed"

echo
echo "nothing to deploy"
new_case "empty"
run
expect_rc 1 "fails when there are no functions to deploy"
expect_out "no functions found" "says so"
expect_out "empty tree proves nothing" "and says an empty tree is not success"
expect_out "::error title=Nothing was deployed::" "annotates it the same way the old inline step did"

echo
echo "no access token: refuses rather than deploying unauthenticated"
new_case "no-token" ask
reply ask "0"
TOKEN_OVERRIDE="" run
expect_rc 1 "refuses"
expect_out "SUPABASE_ACCESS_TOKEN is not set" "says which credential is missing"
expect_calls ask 0 "the CLI is never even invoked without a token"

echo
echo "no project ref: refuses rather than guessing"
new_case "no-ref" ask
reply ask "0"
REF_OVERRIDE="" run
expect_rc 1 "refuses"
expect_out "SUPABASE_PROJECT_REF is not set" "says which credential is missing"
expect_calls ask 0 "the CLI is never even invoked without a project ref"

echo
printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
