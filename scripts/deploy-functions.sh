#!/usr/bin/env bash
# Deploy every edge function in supabase/functions/, giving a function whose
# deploy blips a couple of quick retries before the workflow calls it broken.
#
# Why this exists: on 2026-09-23 Supabase returned
#   unexpected deploy status 500: {"message":"Function deploy failed due to
#   an internal error"}
# for a different, unchanged function on two separate merges — monday-sync,
# then extract-schedule. Nothing was wrong with either one: a manual rerun of
# the exact same command passed both times. But this workflow deployed each
# function exactly once, so a single five-hundred from Supabase's own API
# turned the whole deploy red and fired the Slack alert as though something
# had actually broken. This gives each function's deploy the same chance a
# person re-running the command by hand would give it, before a human is told
# to go look.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=... scripts/deploy-functions.sh
#
# Tuning (used by scripts/deploy-functions.test.sh, rarely otherwise):
#   SUPABASE_BIN          Name/path of the Supabase CLI binary.
#   DEPLOY_ATTEMPTS       Attempts per function before giving up (default 3).
#   DEPLOY_RETRY_DELAYS   Seconds to wait before each retry, space-separated,
#                         one entry fewer than DEPLOY_ATTEMPTS (default "10 30").
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

SUPABASE="${SUPABASE_BIN:-supabase}"
ATTEMPTS="${DEPLOY_ATTEMPTS:-3}"
read -r -a DELAYS <<<"${DEPLOY_RETRY_DELAYS:-10 30}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so nothing was deployed." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "FAIL: SUPABASE_PROJECT_REF is not set, and there is no default." >&2
  exit 1
fi

names=()
for dir in supabase/functions/*/; do
  # An unmatched glob stays literal, so without this guard a run over an empty
  # or missing supabase/functions/ would try to deploy a function literally
  # named * — the same shell quirk scripts/verify-functions.sh guards against.
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # _shared holds imported helpers, not a deployable function.
  [ "${name#_}" != "$name" ] && continue
  names+=("$name")
done

if [ "${#names[@]}" -eq 0 ]; then
  echo "::error title=Nothing was deployed::No function directories were found under supabase/functions/, so this run shipped nothing."
  echo "FAIL: no functions found in supabase/functions/, so nothing was deployed." >&2
  echo "Run this from a checkout of the repo. An empty tree proves nothing." >&2
  exit 1
fi

failed=()
deployed=0

for name in "${names[@]}"; do
  echo "::group::deploy $name"
  attempt=0
  ok=0
  while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    if "$SUPABASE" functions deploy "$name" \
      --project-ref "$SUPABASE_PROJECT_REF" --use-api; then
      ok=1
      break
    fi
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
      # A blip is not evidence the function is broken — see the header. Wait a
      # little longer each time, in case whatever Supabase was doing takes a
      # moment to clear, then give it another go before saying so out loud.
      delay="${DELAYS[$((attempt - 1))]:-10}"
      echo "retrying $name after a Supabase internal error, attempt $((attempt + 1)) of $ATTEMPTS"
      sleep "$delay"
    fi
  done
  if [ "$ok" -eq 1 ]; then
    echo "deployed $name"
    deployed=$((deployed + 1))
  else
    echo "::error title=Function deploy failed::$name"
    failed+=("$name")
  fi
  echo "::endgroup::"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed to deploy: ${failed[*]}" >&2
  exit 1
fi

echo "deployed $deployed function(s)"
