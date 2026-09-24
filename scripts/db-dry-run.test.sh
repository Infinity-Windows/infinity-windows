#!/usr/bin/env bash
# Tests for scripts/db-dry-run.sh — the wrapper around the batch builder and
# the judge (their own cases are in scripts/test_db_dry_run.py).
#
# What this file proves is the whole trip, with curl stubbed: the batch that
# leaves is begin -> harness -> migrations -> probe -> the forced error; the
# results come back out of that error and are judged; an earlier SQL error is
# a failure; a failing check is a failure; a hostile migration or probe is
# refused before curl is ever called; a missing token or project is a refusal
# and not a pass; and the token never appears in argv or in anything printed.
# No token, no project, no network.
#
#   scripts/db-dry-run.test.sh
#   scripts/db-dry-run.test.sh -v     # print each case's output
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/files"
pass=0
fail=0
LAST_OUT=""
LAST_RC=0

TOKEN="sbp_TESTTOKEN_never_shown_0123456789abcdef"
MARK='DRY_RUN_RESULT:'
END=':DRY_RUN_END'

# A fake curl. It reads the token from the -K config file (proving the script
# put it there and nowhere else), copies the request body aside so a case can
# look at the batch that would have been sent, writes the case's canned
# response to the -o file, prints the case's status code the way -w would, and
# exits with the case's exit code. It also records that it was called at all.
cat >"$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
out=""; data=""; cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data) data="${2#@}"; shift 2 ;;
    -K) cfg="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "$*" >>"$FAKE_ARGV"
echo called >>"$FAKE_CALLS"
[ -n "$cfg" ] && cat "$cfg" >>"$FAKE_CFG"
[ -n "$data" ] && cp "$data" "$FAKE_BODY"
if [ -n "$out" ] && [ -f "$FAKE_RESPONSE" ]; then cp "$FAKE_RESPONSE" "$out"; fi
[ -f "$FAKE_STDERR" ] && cat "$FAKE_STDERR" >&2
printf '%s' "$(cat "$FAKE_STATUS")"
exit "$(cat "$FAKE_EXIT")"
FAKE
chmod +x "$work/bin/curl"

# reply <status> <exit code> <response body>   — what the next run's curl says
reply() {
  printf '%s' "$1" >"$work/status"
  printf '%s' "$2" >"$work/exit"
  printf '%s' "$3" >"$work/response"
  : >"$work/curl.stderr"
}

# run <name> <expected exit> [args…]   — runs the script with the stub on PATH
run() {
  local name="$1" want="$2"
  shift 2
  : >"$work/argv"; : >"$work/calls"; : >"$work/cfg"; rm -f "$work/body"
  LAST_OUT="$(env PATH="$work/bin:$PATH" \
      SUPABASE_ACCESS_TOKEN="$TOKEN" SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
      FAKE_ARGV="$work/argv" FAKE_CALLS="$work/calls" FAKE_CFG="$work/cfg" \
      FAKE_BODY="$work/body" FAKE_RESPONSE="$work/response" FAKE_STATUS="$work/status" \
      FAKE_EXIT="$work/exit" FAKE_STDERR="$work/curl.stderr" \
      bash scripts/db-dry-run.sh "$@" 2>&1)"
  LAST_RC=$?
  [ "$VERBOSE" = 1 ] && printf '\n--- %s ---\n%s\n' "$name" "$LAST_OUT"
  if [ "$LAST_RC" != "$want" ]; then
    echo "FAIL: $name — exit $LAST_RC, expected $want"
    echo "$LAST_OUT" | sed 's/^/      /'
    fail=$((fail + 1))
    return
  fi
  echo "ok: $name (exit $want)"
  pass=$((pass + 1))
  # Every run, whatever it did: the token is nowhere in what was printed.
  case "$LAST_OUT" in
    *"$TOKEN"*) echo "FAIL: $name — the token was printed"; fail=$((fail + 1)) ;;
  esac
}

expect() {
  local name="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) echo "ok: $name"; pass=$((pass + 1)) ;;
    *) echo "FAIL: $name — output lacked: $needle"; echo "$LAST_OUT" | sed 's/^/      /'; fail=$((fail + 1)) ;;
  esac
}
expect_not() {
  local name="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) echo "FAIL: $name — output contained: $needle"; echo "$LAST_OUT" | sed 's/^/      /'; fail=$((fail + 1)) ;;
    *) echo "ok: $name"; pass=$((pass + 1)) ;;
  esac
}
# grep -c prints 0 AND exits 1 on no match, so the count is read, not chained.
curl_calls() { local n; n="$(grep -c called "$work/calls" 2>/dev/null)"; echo "${n:-0}"; }
expect_curl_calls() {
  local got; got="$(curl_calls)"
  if [ "$got" = "$1" ]; then echo "ok: $2"; pass=$((pass + 1)); else echo "FAIL: $2 — curl was called $got time(s), expected $1"; fail=$((fail + 1)); fi
}
body_has() {
  local name="$1" needle="$2"
  if [ -f "$work/body" ] && grep -q -F -- "$needle" "$work/body"; then echo "ok: $name"; pass=$((pass + 1))
  else echo "FAIL: $name — the request body lacked: $needle"; fail=$((fail + 1)); fi
}

# --- the files -----------------------------------------------------------------
migration="$work/files/20261028000000_clock_integrity.sql"
cat >"$migration" <<'SQL'
-- A migration with a body worth recognising in the batch.
alter table public.time_shifts add column if not exists review_reason text;
create table if not exists public.time_clock_actions (client_id uuid primary key);
SQL
wrapped="$work/files/20261030000000_ai_daily_log_contributions.sql"
cat >"$wrapped" <<'SQL'
-- Wraps itself, like fourteen migrations on master do.
begin;
alter table public.daily_logs add column if not exists revision bigint not null default 1;
commit;
SQL
probe="$work/files/probe.sql"
cat >"$probe" <<'SQL'
select pg_temp.dry_run_check('a probe check', true, 'fine');
SQL
hostile="$work/files/hostile.sql"
printf 'create index concurrently i on public.t (a);\n' >"$hostile"
midcommit="$work/files/midcommit.sql"
printf 'create table t (a int);\ncommit;\ncreate table u (a int);\n' >"$midcommit"
badprobe="$work/files/badprobe.sql"
printf 'begin;\nselect pg_temp.dry_run_check(%s, true, null);\ncommit;\n' "'x'" >"$badprobe"

good_marker="${MARK}"'[{"check":"clock_in: the same id twice makes one shift","ok":true,"detail":"one row"},{"check":"ledger unreadable to installers","ok":true,"detail":"refused: 42501 permission denied for table time_clock_actions"}]'"${END}"
api_ok="{\"message\":\"failed to run sql query: ERROR:  ${good_marker}\\nCONTEXT: PL/pgSQL function inline_code_block line 8 at RAISE\"}"

# --- success: the results come back out of the forced error --------------------
echo "success"
reply 400 0 "$api_ok"
run "every check passing is exit 0" 0 --probe "$probe" "$migration" "$wrapped"
expect "  the table names the checks" "clock_in: the same id twice makes one shift"
expect "  and says everything was rolled back" "rolled back"
expect "  the plan names the migration" "migration 1: $migration"
expect "  and says the wrapper was set aside" "set aside"
expect_curl_calls 1 "  one request was sent"
body_has "  the batch starts the transaction" '"query": "begin;'
body_has "  the batch carries the first migration" "add column if not exists review_reason"
body_has "  the batch carries the second migration" "add column if not exists revision"
body_has "  the batch carries the probe" "a probe check"
body_has "  the batch ends in the forced error" "raise exception 'DRY_RUN_RESULT:%:DRY_RUN_END'"
body_has "  the batch carries the harness" "create function pg_temp.dry_run_act_as"
if grep -q "commit;" "$work/body" && ! grep -q "the file's own \`commit;\` was set aside" "$work/body"; then
  echo "FAIL: a commit survived into the batch"; fail=$((fail + 1))
else
  echo "ok: no commit survived into the batch"; pass=$((pass + 1))
fi

# --- the token: in the config file, never in argv, never printed ---------------
echo
echo "the token"
if grep -q "Bearer $TOKEN" "$work/cfg"; then echo "ok: curl read the token from its config file"; pass=$((pass + 1)); else echo "FAIL: the config file did not carry the token"; fail=$((fail + 1)); fi
if grep -q "$TOKEN" "$work/argv"; then echo "FAIL: the token was on curl's command line"; fail=$((fail + 1)); else echo "ok: the token was never on curl's command line"; pass=$((pass + 1)); fi

# --- an earlier statement failing: the change is broken ------------------------
echo
echo "a statement fails before the end"
reply 400 0 '{"message":"failed to run sql query: ERROR:  new row for relation \"movements\" violates check constraint \"movements_one_subject_ck\"\nDETAIL:  Failing row contains (…)."}'
run "an earlier SQL error is exit 1" 1 --probe "$probe" "$migration"
expect "  it says the change is broken" "the change is broken"
expect "  and names the constraint" "movements_one_subject_ck"
expect "  and says nothing was kept" "nothing was kept"

# --- a check reporting ok:false ------------------------------------------------
echo
echo "a check fails"
bad_marker="${MARK}"'[{"check":"clock_out twice leaves the time alone","ok":false,"detail":"clock_out_at moved by 31 seconds"},{"check":"fine","ok":true,"detail":null}]'"${END}"
reply 400 0 "{\"message\":\"failed to run sql query: ERROR:  ${bad_marker}\"}"
run "a probe check with ok=false is exit 1" 1 --probe "$probe" "$migration"
expect "  the failing check is named" "FAIL  clock_out twice leaves the time alone"
expect "  with its detail" "clock_out_at moved by 31 seconds"
expect "  and the count" "1 of 2 checks failed"

# --- refusals happen before any request ----------------------------------------
echo
echo "refusals"
reply 400 0 "$api_ok"
run "create index concurrently is refused" 2 --probe "$probe" "$hostile"
expect "  by name" "CONCURRENTLY"
expect "  and says nothing was sent" "Nothing was sent"
expect_curl_calls 0 "  curl was never called"
run "a commit in the middle of a migration is refused" 2 --probe "$probe" "$midcommit"
expect_curl_calls 0 "  curl was never called"
run "a probe with its own begin/commit is refused" 2 --probe "$badprobe" "$migration"
expect "  and told whose job the transaction is" "A probe never opens, commits or rolls back a transaction"
expect_curl_calls 0 "  curl was never called"
run "no probe is a refusal" 2 "$migration"
expect "  that points at the template" "TEMPLATE.sql"
run "no migration is a refusal" 2 --probe "$probe"
run "a missing migration file is a refusal" 2 --probe "$probe" "$work/files/20269999000000_nope.sql"
expect_curl_calls 0 "  curl was never called"

# --- a missing token or project is a refusal, not a pass ----------------------
# (a subshell with `unset`, because macOS's env has no -u)
echo
echo "missing credentials"
out="$(unset SUPABASE_ACCESS_TOKEN; env PATH="$work/bin:$PATH" SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
      FAKE_ARGV="$work/argv" FAKE_CALLS="$work/calls" FAKE_CFG="$work/cfg" FAKE_BODY="$work/body" \
      FAKE_RESPONSE="$work/response" FAKE_STATUS="$work/status" FAKE_EXIT="$work/exit" FAKE_STDERR="$work/curl.stderr" \
      bash scripts/db-dry-run.sh --probe "$probe" "$migration" 2>&1)"
rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "gh workflow run db-dry-run.yml"; then echo "ok: no token is a refusal that says where the token lives"; pass=$((pass + 1)); else echo "FAIL: no token — exit $rc"; echo "$out" | sed 's/^/      /'; fail=$((fail + 1)); fi
expect_curl_calls 0 "  curl was never called"
out="$(unset SUPABASE_PROJECT_REF; env PATH="$work/bin:$PATH" SUPABASE_ACCESS_TOKEN="$TOKEN" \
      FAKE_ARGV="$work/argv" FAKE_CALLS="$work/calls" FAKE_CFG="$work/cfg" FAKE_BODY="$work/body" \
      FAKE_RESPONSE="$work/response" FAKE_STATUS="$work/status" FAKE_EXIT="$work/exit" FAKE_STDERR="$work/curl.stderr" \
      bash scripts/db-dry-run.sh --probe "$probe" "$migration" 2>&1)"
rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "no default"; then echo "ok: no project ref is a refusal, not a guess"; pass=$((pass + 1)); else echo "FAIL: no project ref — exit $rc"; echo "$out" | sed 's/^/      /'; fail=$((fail + 1)); fi
expect_curl_calls 0 "  curl was never called"

# --- could not tell -------------------------------------------------------------
echo
echo "could not tell"
reply 000 6 ""
printf 'curl: (6) Could not resolve host: api.supabase.com\n' >"$work/curl.stderr"
run "a transport failure is exit 3" 3 --probe "$probe" "$migration"
expect "  and says nothing was measured" "nothing was measured"
expect "  and surfaces curl's reason" "Could not resolve host"
reply 201 0 '[]'
run "a 2xx with no forced error is exit 3" 3 --probe "$probe" "$migration"
expect "  and says so loudly" "WITHOUT its forced error"
reply 401 0 '{"message":"Unauthorized"}'
run "a refused token is exit 3" 3 --probe "$probe" "$migration"
expect "  and points at the token" "token"
reply 400 0 '{"message":"failed to run sql query: ERROR:  canceling statement due to lock timeout"}'
run "a lock timeout is exit 3, not a broken change" 3 --probe "$probe" "$migration"
expect_not "  it does not call the change broken" "the change is broken"

# --- what a probe prints is scrubbed ----------------------------------------------
echo
echo "scrubbing"
leaky="${MARK}"'[{"check":"who","ok":true,"detail":"qa.installer@crew.infinitywindows.app got '"$TOKEN"'"}]'"${END}"
reply 400 0 "{\"message\":\"ERROR:  ${leaky}\"}"
run "a detail carrying an email and the token is still exit 0" 0 --probe "$probe" "$migration"
expect_not "  the email is not printed" "qa.installer@"
expect "  it is replaced" "[email]"
expect "  and so is the token" "[token]"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
