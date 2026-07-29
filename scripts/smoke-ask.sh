#!/usr/bin/env bash
# Ask the DEPLOYED `ask` function a real question and check a real answer comes
# back.
#
# Why this exists: every other check in this repo can pass while Ask Infinity
# answers nothing. scripts/verify-functions.sh proves the function ROUTES.
# scripts/verify-function-secrets.sh proves a secret EXISTS by name. Neither
# proves the feature WORKS, and the gap between those is where this project keeps
# losing weeks:
#
#   - `ask` was deployed and 500ing on every request for as long as it existed,
#     because ANTHROPIC_API_KEY had never been set. Green everywhere.
#   - A key that exists but is wrong — pasted from the wrong account, revoked,
#     or rotated at Anthropic and not here — looks IDENTICAL to a correct one to
#     every name-and-digest check. `secrets list` cannot tell you a key still
#     works. Only using it can.
#
# So this makes one real request end to end: through the platform gateway, into
# the function, out to Anthropic, and back with generated text. If that works,
# Ask Infinity works, and there is nothing left to be quietly wrong.
#
# THREE OUTCOMES, and the third is deliberately not a failure — the same
# distinction scripts/verify-functions.sh draws between "missing" and "could not
# tell", for the same reason. A check that goes red when Anthropic has a bad
# afternoon is a check the team learns to ignore, and then it protects nothing.
#
#   exit 0  ANSWERED. Generated text came back. The feature works.
#   exit 1  BROKEN, and it is ours to fix: Anthropic rejected our key, or the
#           function errored, or the key is still missing after every retry. Red.
#   exit 2  COULD NOT TELL. No answer, Anthropic was overloaded or rate-limited,
#           or this checker had no credentials. Nothing says we are
#           misconfigured. Warn.
#
# RETRIES, and why "the key is not set" is one of the retryable cases. Deploy
# backend pushes the secrets and then runs this seconds later. A secret that has
# just been written does not reach the already-running function workers
# instantly, so the first probe can legitimately see the old, keyless
# environment. Failing on that would make the very run that FIXED Ask Infinity
# report it as broken. A rejected key, by contrast, is a settled answer and is
# never retried.
#
# The question is chosen to need genuine generation while touching NO customer,
# job or crew data, because the answer is printed into a CI log that outlives the
# run. `ask` grounds its answers in live app data, so asking it about a job would
# put that job in the log.
#
# Usage:
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   export SUPABASE_SERVICE_ROLE_KEY=eyJ...            # or ASK_SMOKE_JWT
#   scripts/smoke-ask.sh
#
# The service-role key is used only as a caller identity: supabase/config.toml
# sets verify_jwt = true, and _shared/auth.ts admits a service_role JWT as a
# trusted server caller. Any valid user JWT works too, via ASK_SMOKE_JWT.
#
# Tuning (used by scripts/smoke-ask.test.sh, rarely otherwise):
#   ASK_SMOKE_URL          Override the endpoint entirely.
#   ASK_SMOKE_QUESTION     Override the question.
#   ASK_SMOKE_TIMEOUT      Seconds to wait for one answer (default 90).
#   ASK_SMOKE_ATTEMPTS     Probes before giving up (default 3).
#   ASK_SMOKE_RETRY_DELAY  Seconds between them (default 10).
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

if [ -z "${SUPABASE_PROJECT_REF:-}" ] && [ -z "${ASK_SMOKE_URL:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project whose Ask Infinity you mean to test, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/smoke-ask.sh
EOF
  exit 1
fi

REF="${SUPABASE_PROJECT_REF:-}"
URL="${ASK_SMOKE_URL:-https://$REF.supabase.co/functions/v1/ask}"
JWT="${ASK_SMOKE_JWT:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
TIMEOUT="${ASK_SMOKE_TIMEOUT:-90}"
ATTEMPTS="${ASK_SMOKE_ATTEMPTS:-3}"
RETRY_DELAY="${ASK_SMOKE_RETRY_DELAY:-10}"

# A real question about the trade. Needs the model to actually generate prose,
# and its answer contains nothing about anybody's job.
QUESTION="${ASK_SMOKE_QUESTION:-In one short sentence, what is a shim used for when installing a window?}"

if [ -z "$JWT" ]; then
  echo "Ask Infinity was not tested: no caller credentials are available here."
  echo
  echo "Set SUPABASE_SERVICE_ROLE_KEY (or ASK_SMOKE_JWT) to test it. Without one,"
  echo "the platform gateway rejects the request before the function runs, so a"
  echo "failure would say nothing about whether Ask Infinity works."
  echo
  echo "This is a VERIFICATION gap, not a broken feature. Nothing was measured."
  exit 2
fi

body="$(mktemp)" || exit 1
err="$(mktemp)" || exit 1
trap 'rm -f "$body" "$err"' EXIT

# Built with python3 so a quote in an overridden question cannot break the JSON,
# and piped to curl on stdin so it never appears in the process list.
payload="$(QUESTION="$QUESTION" python3 -c \
  'import json,os;print(json.dumps({"question":os.environ["QUESTION"]}))')" || {
  echo "FAIL: could not build the request body." >&2
  exit 2
}

verdict=""
retryable=0
code=""
detail=""
answer=""

probe() {
  : >"$body"
  : >"$err"

  # As in scripts/verify-functions.sh: the assignment and the exit status stay on
  # separate lines, because `code=$(curl ...)` reports the assignment's status
  # rather than curl's, and curl's status is the only thing that distinguishes
  # "no answer at all" from "answered, with an error".
  code="$(printf '%s' "$payload" | curl -sS -o "$body" -w '%{http_code}' \
    -X POST "$URL" \
    -H "Authorization: Bearer $JWT" \
    -H 'Content-Type: application/json' \
    --data-binary @- --max-time "$TIMEOUT" 2>"$err")"
  local rc=$?

  answer=""
  detail=""

  if [ "$rc" -ne 0 ] || [ "$code" = "000" ] || ! [[ "$code" =~ ^[0-9]{3}$ ]]; then
    detail="curl exit $rc, status '${code:-<none>}'"
    local msg
    msg="$(tr -d '\r' <"$err" | tr '\n' ' ')"
    msg="${msg#"${msg%%[![:space:]]*}"}"
    msg="${msg%"${msg##*[![:space:]]}"}"
    [ -n "$msg" ] && detail="$detail ($msg)"
    verdict="no_answer"
    retryable=1
    return
  fi

  # {"answer": "...", "sources": [...]} or {"error": "..."}. Parsed with python3
  # rather than grep so a brace in the prose cannot fool it.
  answer="$(python3 - "$body" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
if isinstance(data, dict) and isinstance(data.get("answer"), str):
    sys.stdout.write(data["answer"])
PY
  )"

  if [ "$code" = "200" ] && [ -n "${answer//[[:space:]]/}" ]; then
    verdict="answered"
    retryable=0
    return
  fi

  detail="$(tr -d '\r' <"$body" | tr '\n' ' ' | head -c 800)"
  local lower
  lower="$(printf '%s' "$detail" | tr '[:upper:]' '[:lower:]')"

  # A gateway 401 is THIS CHECKER failing to sign in. The function returns 401
  # only for an unauthenticated caller; an Anthropic 401 arrives wrapped in a
  # 500, so it cannot be confused with this. Tested before the rejected-key
  # patterns, which would otherwise match the digits in the status.
  if [ "$code" = "401" ]; then
    verdict="gateway_401"
    retryable=0
    return
  fi

  # Upstream capacity problems are not our configuration. Anthropic returns 429
  # (rate limit) and 529 (overloaded), and the function wraps both in a 500, so
  # the body is the only place the real cause appears.
  case "$lower" in
  *overloaded* | *rate_limit* | *rate\ limit* | *429* | *529* | *timeout* | *timed\ out*)
    verdict="busy"
    retryable=1
    return
    ;;
  esac

  # Retryable, because Deploy backend pushes this secret moments before running
  # this check and the running workers may not have it yet. Only a run that keeps
  # saying this is genuinely missing a key.
  if printf '%s' "$lower" | grep -qF 'anthropic_api_key secret is not set'; then
    verdict="not_set"
    retryable=1
    return
  fi

  if printf '%s' "$lower" | grep -qE 'invalid x-api-key|authentication_error|invalid_api_key|permission_error|401|403'; then
    verdict="rejected"
    retryable=0
    return
  fi

  verdict="error"
  retryable=0
}

attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  probe
  [ "$verdict" = "answered" ] && break
  [ "$retryable" -eq 0 ] && break
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_DELAY"
  fi
done

if [ "$verdict" = "answered" ]; then
  echo "Ask Infinity works: it answered a real question"
  echo
  echo "  project:  ${REF:-<from ASK_SMOKE_URL>}"
  echo "  question: $QUESTION"
  echo
  echo "  answer:"
  # Truncated: proof that real text came back does not need the whole essay in a
  # log, and a long answer buries the verdict.
  printf '%s\n' "$answer" | head -c 600 | sed 's/^/    /'
  echo
  echo
  echo "ANSWERED end to end: the function ran, the API key was accepted, and"
  echo "Claude generated that reply. Nothing here is deployed-but-broken."
  exit 0
fi

# --- the two "could not tell" outcomes: warn, never go red ------------------

if [ "$verdict" = "no_answer" ]; then
  {
    echo "Could not tell whether Ask Infinity works: it never answered"
    echo
    echo "$detail"
    echo
    echo "This is a VERIFICATION failure, not a broken feature. Nothing here says"
    echo "anything is misconfigured — $attempt attempt(s) got no answer at all."
    echo "Re-run it."
  } >&2
  exit 2
fi

if [ "$verdict" = "busy" ]; then
  {
    echo "Could not tell whether Ask Infinity works: the AI service was busy"
    echo
    echo "$detail"
    echo
    echo "This is a VERIFICATION failure, not a broken feature. The key was"
    echo "accepted; Anthropic was rate-limited or overloaded on all $attempt"
    echo "attempt(s). Re-run it."
  } >&2
  exit 2
fi

if [ "$verdict" = "gateway_401" ]; then
  {
    echo "Could not test Ask Infinity: this checker could not sign in"
    echo
    echo "The project rejected the credentials this test used, so the request"
    echo "never reached the function. That says nothing about whether Ask"
    echo "Infinity works. Check SUPABASE_SERVICE_ROLE_KEY belongs to $REF."
    echo
    echo "HTTP $code: $detail"
  } >&2
  exit 2
fi

# --- genuinely broken, and which one changes what a human must do ----------

case "$verdict" in
not_set)
  headline="Ask Infinity is not working: its API key has not been added"
  what="  The key ANTHROPIC_API_KEY is not set on this project, so every question
  fails. Deploy backend pushes it from the GitHub secret of the same name, so
  either that GitHub secret is missing or the push step did not run. This was
  still true after $attempt attempt(s), so it is not the secret taking a moment
  to reach the running functions."
  ;;
rejected)
  headline="Ask Infinity is not working: the AI provider rejected our API key"
  what="  The key IS set, and Anthropic refused it. It is the wrong key, it was
  revoked, or it belongs to an account without access. A name-and-digest check
  cannot see this — only a real request can, which is why this test exists.
  Fix: put a valid key in the GitHub secret ANTHROPIC_API_KEY and re-run
  Deploy backend."
  ;;
*)
  headline="Ask Infinity is not working: it returned an error instead of an answer"
  what="  The function was reached and did not produce an answer. The response is
  below. If it mentions a missing table or column the fix is a migration, not
  a key."
  ;;
esac

{
  echo "$headline"
  echo
  echo "WHAT THIS MEANS"
  echo
  echo "$what"
  echo
  echo "  Nothing in this run broke it. Ask Infinity has been failing this way on"
  echo "  every question already — this is the first check that can see it."
  echo
  echo "TECHNICAL DETAIL"
  echo
  echo "  project:  ${REF:-<from ASK_SMOKE_URL>}"
  echo "  HTTP $code from $URL"
  echo "  $detail"
} >&2

# The one-line cause, for the Slack post and the GitHub annotation — the same
# contract scripts/verify-function-secrets.sh and scripts/verify-push-key.sh have.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ask_smoke_headline=$headline" >>"$GITHUB_OUTPUT"
fi

exit 1
