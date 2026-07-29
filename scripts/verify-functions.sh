#!/usr/bin/env bash
# Check that every edge function in supabase/functions/ actually exists in the
# deployed project.
#
# Why this exists: on 2026-07-29 only 4 of 10 functions were live in production.
# `ask` had never been deployed, so Ask Infinity answered nothing, and no build
# ever went red about it. The README listed 4 functions to deploy and was never
# updated as 6 more were added, so following the setup instructions produced
# exactly the wrong result. Shipping the frontend without its backend is the
# failure mode this guards.
#
# No credentials needed. An unauthenticated POST distinguishes the cases we care
# about, because the platform routes before it authenticates. There are THREE
# outcomes, and the third one is not a pass:
#   404          -> MISSING, the function does not exist in the project
#   any other
#   HTTP status  -> deployed, the platform routed to it (401 without a JWT)
#   no status    -> UNDETERMINED. curl never got an answer: DNS failure, refused
#                   connection, timeout, no curl on PATH. This proves nothing
#                   either way, so under STRICT it fails rather than passes.
#
# That third case used to exit 0 even under STRICT, which made this script the
# fourth check this week capable of reporting success without having verified
# anything. A check that cannot tell "healthy" from "could not tell" is not a
# check.
#
# Usage:
#   scripts/verify-functions.sh                 # uses the pinned production ref
#   SUPABASE_PROJECT_REF=abc scripts/verify-functions.sh
#   STRICT=1 scripts/verify-functions.sh        # exit 1 if any function is
#                                               # missing OR undetermined
#
# Tuning (used by scripts/verify-functions.test.sh, rarely otherwise):
#   VERIFY_ATTEMPTS=3      probes per function before calling it undetermined
#   VERIFY_RETRY_DELAY=3   seconds between those probes
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

REF="${SUPABASE_PROJECT_REF:-czprjcskmzzagdztqonm}"
BASE="https://$REF.supabase.co/functions/v1"
STRICT="${STRICT:-0}"
ATTEMPTS="${VERIFY_ATTEMPTS:-3}"
RETRY_DELAY="${VERIFY_RETRY_DELAY:-3}"

err_file="$(mktemp)" || exit 1
trap 'rm -f "$err_file"' EXIT

names=()
for dir in supabase/functions/*/; do
  # An unmatched glob stays literal, so without this the script would "probe" a
  # directory named * and report a confident 404 about a function that does not
  # exist in the repo either.
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # _shared holds helper modules imported by the functions, not a function.
  [ "${name#_}" != "$name" ] && continue
  names+=("$name")
done

if [ "${#names[@]}" -eq 0 ]; then
  echo "FAIL: no functions found in supabase/functions/, so nothing was checked." >&2
  echo "Run this from a checkout of the repo. An empty tree proves nothing." >&2
  exit 1
fi

deployed=()
missing=()
undetermined=()

for name in "${names[@]}"; do
  code=""
  rc=0
  reason=""
  attempt=0

  # Retry transport failures: a blip is not evidence of anything. The loop runs
  # every attempt before giving up, and only a genuine HTTP status ends it
  # early.
  while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    : > "$err_file"

    # Keep the assignment and the exit status on separate lines: `code=$(curl)`
    # would report the assignment's status, not curl's, and curl's exit status
    # is the only thing that reliably distinguishes "no answer" from "answered
    # 404". Without --fail, curl exits 0 for any HTTP status it receives, so a
    # non-zero rc here always means transport-level trouble.
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/$name" \
      -H 'Content-Type: application/json' -d '{}' --max-time 20 2>"$err_file")"
    rc=$?

    if [ "$rc" -eq 0 ] && [ "$code" != "000" ] && [[ "$code" =~ ^[0-9]{3}$ ]]; then
      reason=""
      break
    fi

    # An empty or non-numeric code is just as indeterminate as 000. It used to
    # fall through to the catch-all and be counted as deployed, so a curl that
    # was missing from PATH reported every function healthy.
    reason="curl exit $rc, status '${code:-<none>}'"
    detail="$(tr -d '\r' <"$err_file" | tr '\n' ' ')"
    detail="${detail#"${detail%%[![:space:]]*}"}"
    detail="${detail%"${detail##*[![:space:]]}"}"
    [ -n "$detail" ] && reason="$reason ($detail)"

    if [ "$attempt" -lt "$ATTEMPTS" ]; then
      sleep "$RETRY_DELAY"
    fi
  done

  if [ -z "$reason" ]; then
    if [ "$code" = "404" ]; then
      missing+=("$name")
      printf '  MISSING       %-26s (404)\n' "$name"
    else
      deployed+=("$name")
      printf '  deployed      %-26s (%s)\n' "$name" "$code"
    fi
  else
    undetermined+=("$name")
    printf '  UNDETERMINED  %-26s (no answer in %s attempt(s): %s)\n' \
      "$name" "$ATTEMPTS" "$reason"
  fi
done

echo
echo "project:      $REF"
echo "deployed:     ${#deployed[@]}"
echo "missing:      ${#missing[@]}${missing[*]+ -> ${missing[*]}}"
echo "undetermined: ${#undetermined[@]}${undetermined[*]+ -> ${undetermined[*]}}"

status=0

if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$STRICT" = "1" ]; then
    echo "FAIL: ${#missing[@]} function(s) in the repo are not deployed: ${missing[*]}" >&2
    echo "This is a DEPLOYMENT failure. Those functions 404 in $REF right now." >&2
    status=1
  else
    echo "WARNING: ${#missing[@]} function(s) in the repo are not deployed."
  fi
fi

if [ "${#undetermined[@]}" -gt 0 ]; then
  if [ "$STRICT" = "1" ]; then
    {
      echo "FAIL: could not determine whether ${#undetermined[@]} function(s) are deployed: ${undetermined[*]}"
      echo
      echo "This is a VERIFICATION failure, not a deployment failure. Nothing here"
      echo "says those functions are missing — $ATTEMPTS attempt(s) each got no answer"
      echo "at all from $REF.supabase.co, so this run proves nothing about them."
      echo "Do not go hunting for a broken deploy on the strength of this. Re-run"
      echo "the job; if it keeps happening, the network path to Supabase or the"
      echo "project itself is the thing to look at."
    } >&2
    status=1
  else
    echo "WARNING: could not reach ${#undetermined[@]} function(s), so they were not verified."
  fi
fi

exit "$status"
