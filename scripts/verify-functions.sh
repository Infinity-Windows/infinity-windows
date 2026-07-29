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
# No credentials needed. An unauthenticated POST distinguishes the two cases we
# care about, because the platform routes before it authenticates:
#   401 -> the function is deployed and rejected us for having no JWT
#   404 -> the function does not exist in the project
#
# Usage:
#   scripts/verify-functions.sh                 # uses the pinned production ref
#   SUPABASE_PROJECT_REF=abc scripts/verify-functions.sh
#   STRICT=1 scripts/verify-functions.sh        # exit 1 when any are missing
set -uo pipefail

cd "$(dirname "$0")/.."

REF="${SUPABASE_PROJECT_REF:-czprjcskmzzagdztqonm}"
BASE="https://$REF.supabase.co/functions/v1"

missing=()
deployed=()
unknown=()

for dir in supabase/functions/*/; do
  name="$(basename "$dir")"
  # _shared holds helper modules imported by the functions, not a function.
  [ "${name#_}" != "$name" ] && continue

  code=""
  # Retry: a bare 000 means curl failed (transient network), not "missing".
  for _ in 1 2 3; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/$name" \
      -H 'Content-Type: application/json' -d '{}' --max-time 20 2>/dev/null)"
    [ "$code" != "000" ] && break
    sleep 3
  done

  case "$code" in
    404) missing+=("$name");  printf '  MISSING   %-26s (404)\n' "$name" ;;
    000) unknown+=("$name");  printf '  UNKNOWN   %-26s (no response)\n' "$name" ;;
    *)   deployed+=("$name"); printf '  deployed  %-26s (%s)\n' "$name" "$code" ;;
  esac
done

echo
echo "project:  $REF"
echo "deployed: ${#deployed[@]}"
echo "missing:  ${#missing[@]}${missing[*]+ -> ${missing[*]}}"
[ "${#unknown[@]}" -gt 0 ] && echo "unknown:  ${#unknown[@]} -> ${unknown[*]}"

if [ "${#missing[@]}" -gt 0 ]; then
  if [ "${STRICT:-0}" = "1" ]; then
    echo "FAIL: ${#missing[@]} function(s) in the repo are not deployed." >&2
    exit 1
  fi
  echo "WARNING: ${#missing[@]} function(s) in the repo are not deployed."
fi

exit 0
