#!/usr/bin/env bash
# Tests for scripts/verify-functions.sh.
#
# The script's whole job is to tell three outcomes apart — deployed, missing,
# and could-not-determine — so these tests drive all three without touching the
# network. Each case builds a throwaway repo (a scripts/ dir, a
# supabase/functions/ tree) and puts a fake `curl` first on PATH that returns
# whatever status, exit code and stderr the case asks for, attempt by attempt.
#
#   scripts/verify-functions.test.sh
#   scripts/verify-functions.test.sh -v     # print each case's output
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/verify-functions.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# --- harness ---------------------------------------------------------------

# A fake curl. It works out which function is being probed from the URL, counts
# how many times it has been asked about that one, and replies with the n-th
# line of the case's script for it: "<status> <exit code> [stderr text]".
# A status of "-" means print nothing at all, which is what a curl that is
# broken or absent effectively does.
write_fake_curl() {
  cat >"$root/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in https://*) url="$arg" ;; esac
done
name="${url##*/}"

echo "$name" >>"$FAKE_LOG"
attempt="$(grep -c "^$name\$" "$FAKE_LOG")"

spec="$FAKE_DIR/$name"
[ -f "$spec" ] || spec="$FAKE_DIR/default"
line="$(sed -n "${attempt}p" "$spec")"
[ -z "$line" ] && line="$(tail -n 1 "$spec")"

status="${line%% *}"
rest="${line#* }"
rc="${rest%% *}"
msg="${rest#* }"
[ "$msg" = "$rc" ] && msg=""

[ -n "$msg" ] && printf '%s\n' "$msg" >&2
[ "$status" != "-" ] && printf '%s' "$status"
exit "$rc"
FAKE
  chmod +x "$root/bin/curl"
}

# new_case <description> <function name>...
new_case() {
  current="$1"
  shift
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/bin" "$root/fake" \
    "$root/supabase/functions/_shared"
  cp "$SCRIPT" "$root/scripts/verify-functions.sh"
  chmod +x "$root/scripts/verify-functions.sh"
  for name in "$@"; do
    mkdir -p "$root/supabase/functions/$name"
  done
  write_fake_curl
  : >"$root/fake/calls.log"
}

# reply <function name|default> <line>...   e.g. reply ask "401 0"
reply() {
  local name="$1"
  shift
  printf '%s\n' "$@" >"$root/fake/$name"
}

# run <STRICT value>
run() {
  : >"$root/fake/calls.log"
  OUT="$(cd "$root" \
    && PATH="$root/bin:$PATH" \
       FAKE_DIR="$root/fake" \
       FAKE_LOG="$root/fake/calls.log" \
       STRICT="$1" \
       VERIFY_RETRY_DELAY=0 \
       SUPABASE_PROJECT_REF=testref \
       ./scripts/verify-functions.sh 2>&1)"
  RC=$?
  [ "$VERBOSE" = "1" ] && printf '\n--- %s (STRICT=%s) ---\n%s\n' "$current" "$1" "$OUT"
  return 0
}

calls_for() { grep -c "^$1\$" "$root/fake/calls.log"; }

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
  if [ "$got" = "$2" ]; then ok "$3 ($2 probe(s))"; else
    bad "$3 — expected $2 probe(s) of $1, got $got"
  fi
}

# --- cases -----------------------------------------------------------------

echo "everything deployed"
new_case "deployed" ask send-push
reply default "401 0"
run 1; expect_rc 0 "strict passes when every function answers 401"
expect_out "deployed      ask" "reports ask as deployed"
expect_out "undetermined: 0" "nothing undetermined"
run 0; expect_rc 0 "non-strict passes too"
expect_calls ask 1 "a clean answer is not retried"

echo
echo "a function is missing (404)"
new_case "missing" ask send-push
reply default "401 0"
reply send-push "404 0"
run 1
expect_rc 1 "strict fails on a 404"
expect_out "DEPLOYMENT failure" "names it a deployment failure"
expect_out "not deployed: send-push" "names the missing function"
run 0
expect_rc 0 "non-strict only warns on a 404"
expect_out "WARNING" "warns"
expect_calls send-push 1 "a 404 is a real answer, so it is not retried"

echo
echo "cannot reach the project at all (000 / DNS failure)"
new_case "undetermined" ask send-push
reply default "000 6 curl: (6) Could not resolve host: testref.supabase.co"
run 1
expect_rc 1 "STRICT now FAILS when nothing could be determined"
expect_out "VERIFICATION failure" "calls it a verification failure"
expect_out "could not determine whether 2 function(s)" "counts them"
expect_out "ask send-push" "names both functions"
expect_out "Could not resolve host" "surfaces curl's own reason"
expect_no_out "DEPLOYMENT failure" "does not blame the deploy"
expect_calls ask 3 "retries are exhausted before giving up"
run 0
expect_rc 0 "non-strict still only warns, so master stays green"
expect_out "WARNING: could not reach 2 function(s)" "warns instead"

echo
echo "curl is broken or absent: no output at all"
new_case "no-output" ask
reply default "- 127 bash: curl: command not found"
run 1
expect_rc 1 "strict fails when curl prints nothing"
expect_no_out "deployed      ask" "an empty status is NOT counted as deployed"
expect_out "UNDETERMINED" "counted as undetermined"
run 0; expect_rc 0 "non-strict warns"

echo
echo "curl prints 000 but exits 0"
new_case "zero-code" ask
reply default "000 0"
run 1; expect_rc 1 "strict fails on a 000 regardless of exit code"

echo
echo "curl exits non-zero while printing a plausible status"
new_case "rc-only" ask
reply default "404 28 curl: (28) Operation timed out"
run 1
expect_rc 1 "a transport failure is undetermined even if it printed 404"
expect_out "VERIFICATION failure" "not reported as a missing function"
expect_no_out "MISSING" "does not claim the function is missing"

echo
echo "one missing and one unreachable at the same time"
new_case "mixed" ask send-push vault-config
reply ask "401 0"
reply send-push "404 0"
reply vault-config "000 7 curl: (7) Failed to connect"
run 1
expect_rc 1 "strict fails"
expect_out "not deployed: send-push" "reports the missing one"
expect_out "could not determine whether 1 function(s) are deployed: vault-config" \
  "and the unreachable one separately"

echo
echo "a blip that clears on retry"
new_case "transient" ask
reply ask "000 6 curl: (6) transient" "401 0"
run 1
expect_rc 0 "strict passes once a retry gets an answer"
expect_calls ask 2 "stopped retrying as soon as it got one"
expect_out "deployed      ask" "counted as deployed"

echo
echo "nothing to check"
new_case "empty"
run 1; expect_rc 1 "strict fails when there are no functions to probe"
expect_out "nothing was checked" "says so"
run 0; expect_rc 1 "non-strict fails too: an empty tree proves nothing"

echo
echo "_shared is not a function"
new_case "shared" ask
reply default "401 0"
run 1
expect_rc 0 "passes"
expect_no_out "_shared" "_shared is never probed"

echo
printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
