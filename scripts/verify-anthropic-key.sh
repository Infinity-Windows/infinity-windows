#!/usr/bin/env bash
# Check that the Anthropic API key we hold is one Anthropic will actually accept.
#
# Why this exists, and why it is not the same as any check already here:
#
#   scripts/verify-function-secrets.sh   the secret EXISTS on the project
#   scripts/sync-function-secrets.sh     the value GitHub has is now on the project
#   scripts/smoke-ask.sh                 the whole Ask Infinity feature answers
#
# The first two are blind to whether the key is any good. `supabase secrets list`
# reports names and a digest, so a revoked key, a key from somebody else's
# Anthropic account, and a perfectly working key are indistinguishable to it.
# The third would catch it, but it can only run when a caller credential is
# available: `ask` requires a signed-in user, and a new-format Supabase secret
# key (`sb_secret_…`) cannot be used as one, because the function's auth expects
# a JWT. When that is the only credential CI has, the end-to-end test can say
# nothing at all.
#
# This closes that gap without needing any Supabase credential whatsoever. It
# asks Anthropic directly, with the same key that was just pushed to the project,
# so a key that is wrong is caught on the run that pushed it rather than by an
# installer tapping Ask Infinity and getting nothing.
#
# It is a real request and it generates real text, because a key can be
# well-formed, present, and still refused. Only using it settles the question.
#
# THREE OUTCOMES, the same discipline as scripts/smoke-ask.sh and
# scripts/verify-functions.sh. Anthropic being busy is not us being
# misconfigured, and a check that goes red for it is one the team stops reading:
#
#   exit 0  ACCEPTED. Anthropic took the key and generated text.
#   exit 1  REFUSED. The key is wrong, revoked, or out of credit. Red.
#   exit 2  COULD NOT TELL. No answer, or Anthropic was busy, or we hold no key
#           at all so there was nothing to test. Warn.
#
# THE KEY IS NEVER PRINTED, and never appears on a command line: it goes to curl
# in a header file on stdin. The model's reply IS printed, so the prompt is
# chosen to be about the trade and to pull in no customer, job or crew data.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   scripts/verify-anthropic-key.sh
#
# Tuning (used by scripts/verify-anthropic-key.test.sh, rarely otherwise):
#   ANTHROPIC_VERIFY_URL      Override the endpoint.
#   ANTHROPIC_VERIFY_TIMEOUT  Seconds to wait (default 60).
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

KEY="${ANTHROPIC_API_KEY:-}"
URL="${ANTHROPIC_VERIFY_URL:-https://api.anthropic.com/v1/messages}"
TIMEOUT="${ANTHROPIC_VERIFY_TIMEOUT:-60}"

# Trimmed for the same reason scripts/sync-function-secrets.sh trims: a newline
# picked up when pasting into the GitHub secrets box travels with the value and
# would make a good key fail here for a reason nobody would guess.
KEY="${KEY#"${KEY%%[![:space:]]*}"}"
KEY="${KEY%"${KEY##*[![:space:]]}"}"

if [ -z "$KEY" ]; then
  echo "The AI key was not tested: there is no key here to test."
  echo
  echo "Nothing is broken and nothing was measured. Set ANTHROPIC_API_KEY to test"
  echo "it. Whether the key is set on the Supabase project is a different"
  echo "question, and scripts/verify-function-secrets.sh is what answers it."
  exit 2
fi

# The model has to match what the functions actually use, or this would happily
# pass on a key that the real code cannot use. Same default as
# supabase/functions/_shared/anthropic.ts.
MODEL="${ANTHROPIC_MODEL:-claude-sonnet-5}"

body="$(mktemp)" || exit 1
err="$(mktemp)" || exit 1
hdr="$(mktemp)" || exit 1
trap 'rm -f "$body" "$err" "$hdr"' EXIT

# Headers via a file so the key is never in argv, where `ps` could see it. Made
# private before it exists.
umask 077
{
  printf 'x-api-key: %s\n' "$KEY"
  printf 'anthropic-version: 2023-06-01\n'
  printf 'content-type: application/json\n'
} >"$hdr"

QUESTION="In one short sentence, what is a shim used for when installing a window?"
payload="$(QUESTION="$QUESTION" MODEL="$MODEL" python3 -c '
import json, os
print(json.dumps({
    "model": os.environ["MODEL"],
    "max_tokens": 100,
    "messages": [{"role": "user", "content": os.environ["QUESTION"]}],
}))')" || {
  echo "FAIL: could not build the request body." >&2
  exit 2
}

# Assignment and exit status on separate lines, so curl's status is what is
# tested rather than the assignment's — as in scripts/verify-functions.sh.
code="$(printf '%s' "$payload" | curl -sS -o "$body" -w '%{http_code}' \
  -X POST "$URL" -H "@$hdr" --data-binary @- --max-time "$TIMEOUT" 2>"$err")"
rc=$?

if [ "$rc" -ne 0 ] || [ "$code" = "000" ] || ! [[ "$code" =~ ^[0-9]{3}$ ]]; then
  detail="$(tr -d '\r' <"$err" | tr '\n' ' ')"
  {
    echo "Could not tell whether the AI key works: Anthropic never answered"
    echo
    echo "curl exit $rc, status '${code:-<none>}'${detail:+ ($detail)}."
    echo
    echo "This is a VERIFICATION failure, not a bad key. Nothing here says the key"
    echo "is wrong — the request got no answer at all. Re-run it."
  } >&2
  exit 2
fi

text="$(python3 - "$body" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
blocks = data.get("content")
if isinstance(blocks, list):
    out = "".join(
        b.get("text", "") for b in blocks
        if isinstance(b, dict) and b.get("type") == "text"
    )
    sys.stdout.write(out.strip())
PY
)"

if [ "$code" = "200" ] && [ -n "${text//[[:space:]]/}" ]; then
  echo "The AI key works: Anthropic accepted it and answered"
  echo
  echo "  model:    $MODEL"
  echo "  question: $QUESTION"
  echo
  echo "  answer:"
  printf '%s\n' "$text" | head -c 600 | sed 's/^/    /'
  echo
  echo
  echo "ACCEPTED. This is the same key the Edge Functions now hold, so Ask"
  echo "Infinity and plan-set reading have a working key behind them."
  exit 0
fi

detail="$(tr -d '\r' <"$body" | tr '\n' ' ' | head -c 800)"
lower="$(printf '%s' "$detail" | tr '[:upper:]' '[:lower:]')"

# Anthropic's own capacity problems. Not our key, not our configuration.
case "$lower" in
*overloaded* | *rate_limit* | *rate\ limit* | *api_error* | *timeout*)
  {
    echo "Could not tell whether the AI key works: Anthropic was busy"
    echo
    echo "HTTP $code: $detail"
    echo
    echo "This is a VERIFICATION failure, not a bad key. Re-run it."
  } >&2
  exit 2
  ;;
esac

if printf '%s' "$lower" | grep -qE 'authentication_error|invalid x-api-key|invalid_api_key'; then
  headline="The AI key is not valid: Anthropic will not accept it"
  what="  Anthropic refused this key outright. It is the wrong key, it was typed or
  pasted incompletely, or it has been cancelled since it was issued. Nothing
  in the app can work around that.

  Fix: create a key at https://console.anthropic.com (API keys), put it in the
  GitHub secret ANTHROPIC_API_KEY, and re-run Deploy backend. That pushes it to
  the live project for you."
elif printf '%s' "$lower" | grep -qE 'permission_error|credit|billing|quota'; then
  headline="The AI key was refused: the Anthropic account cannot be billed"
  what="  The key itself was recognised, and the account behind it cannot pay for the
  request — usually no credit left, or spending disabled.

  Fix: top up or re-enable billing at https://console.anthropic.com. The key
  does not need changing."
elif [ "$code" = "404" ]; then
  headline="The AI key works, but the model we ask for does not exist"
  what="  Anthropic accepted the key and does not recognise the model '$MODEL'. The
  key is fine; the model name in supabase/functions/_shared/anthropic.ts (or
  the ANTHROPIC_MODEL secret) is what needs changing."
else
  headline="The AI key could not be used: Anthropic returned an error"
  what="  The request reached Anthropic and came back as an error that is neither a
  rejected key nor a busy service. The response is below."
fi

{
  echo "$headline"
  echo
  echo "WHAT THIS MEANS"
  echo
  echo "$what"
  echo
  echo "  Until this is fixed, Ask Infinity answers only from the built-in company"
  echo "  brain and reading specs off a planset does not work."
  echo
  echo "TECHNICAL DETAIL"
  echo
  echo "  HTTP $code from $URL"
  echo "  model: $MODEL"
  echo "  $detail"
} >&2

# The one-line cause for the Slack post and the GitHub annotation — the contract
# scripts/verify-function-secrets.sh, verify-push-key.sh and smoke-ask.sh share.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "anthropic_key_headline=$headline" >>"$GITHUB_OUTPUT"
fi

exit 1
