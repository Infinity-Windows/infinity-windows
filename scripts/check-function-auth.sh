#!/usr/bin/env bash
# Fail CI when an edge function reaches for the service role without asking
# who is calling.
#
# Every function under supabase/functions runs on the service-role key, which
# bypasses row security. That is the point of it — a sweep sends pushes no
# single user could — but it means the permission a client query would get
# from a policy has to be asked for explicitly, and forgetting is invisible:
# nothing in a green test suite notices a function that acts for anyone who
# reaches it. Horizon shipped exactly that once — a report-fill function that
# let anyone holding a report id write onto another crew's job.
#
# A function passes by either:
#   - importing _shared/auth.ts AND calling requireCaller( or verifyCaller(, or
#   - being listed in supabase/functions/_shared/SYSTEM_ACTORS.md, with the
#     reason it acts for the system rather than a person.
# The list is kept honest in both directions: a listed function that also
# checks its caller fails (stale entry), and a function marked
# `verify_jwt = false` in supabase/config.toml must be on the list.
#
# Usage:  scripts/check-function-auth.sh
# Env (for the test suite): FUNCTIONS_DIR, ACTORS_FILE, CONFIG_FILE.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
FUNCTIONS_DIR="${FUNCTIONS_DIR:-supabase/functions}"
ACTORS_FILE="${ACTORS_FILE:-supabase/functions/_shared/SYSTEM_ACTORS.md}"
CONFIG_FILE="${CONFIG_FILE:-supabase/config.toml}"

fail=0
checked=0
listed_names=""
if [ -f "$ACTORS_FILE" ]; then
  listed_names="$(grep -oE '^- `[a-z0-9_-]+`' "$ACTORS_FILE" | sed 's/^- `//; s/`$//')"
fi

is_listed() { printf '%s\n' "$listed_names" | grep -qx "$1"; }

# Functions whose config says verify_jwt = false: the gateway lets anyone in.
jwt_off="$(awk '
  /^\[functions\./ { name=$0; sub(/^\[functions\./, "", name); sub(/\]$/, "", name) }
  /^verify_jwt[[:space:]]*=[[:space:]]*false/ { print name }
' "$CONFIG_FILE" 2>/dev/null)"

for index in "$FUNCTIONS_DIR"/*/index.ts; do
  [ -f "$index" ] || continue
  name="$(basename "$(dirname "$index")")"
  case "$name" in _shared) continue ;; esac
  checked=$((checked + 1))
  uses_service_role=0; grep -q "SERVICE_ROLE" "$index" && uses_service_role=1
  imports_auth=0; grep -q "_shared/auth" "$index" && imports_auth=1
  calls_check=0; grep -qE "requireCaller\(|verifyCaller\(" "$index" && calls_check=1
  checks=0; [ "$imports_auth" -eq 1 ] && [ "$calls_check" -eq 1 ] && checks=1
  listed=0; is_listed "$name" && listed=1
  gateway_open=0; printf '%s\n' "$jwt_off" | grep -qx "$name" && gateway_open=1

  if [ "$checks" -eq 1 ] && [ "$listed" -eq 1 ]; then
    echo "FAIL  $name: listed as a system actor in $ACTORS_FILE but it checks its caller — remove the stale entry."
    fail=$((fail + 1))
  elif [ "$uses_service_role" -eq 1 ] && [ "$checks" -eq 0 ] && [ "$listed" -eq 0 ]; then
    echo "FAIL  $index: uses the service role and never asks who is calling. Add a caller check (requireCaller or verifyCaller from _shared/auth.ts) or list it as a system actor with a reason in $ACTORS_FILE."
    fail=$((fail + 1))
  elif [ "$gateway_open" -eq 1 ] && [ "$listed" -eq 0 ]; then
    echo "FAIL  $name: supabase/config.toml sets verify_jwt = false, so anyone can reach it, and it is not listed as a system actor in $ACTORS_FILE."
    fail=$((fail + 1))
  elif [ "$checks" -eq 1 ]; then
    echo "ok    $name: asks who is calling"
  elif [ "$listed" -eq 1 ]; then
    echo "ok    $name: system actor, reason recorded"
  else
    echo "ok    $name: does not use the service role"
  fi
done

# A listed function that no longer exists is a stale entry too.
for listed in $listed_names; do
  if [ ! -f "$FUNCTIONS_DIR/$listed/index.ts" ]; then
    echo "FAIL  $listed is listed in $ACTORS_FILE but there is no such function — remove the entry."
    fail=$((fail + 1))
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "FAIL  no functions found under $FUNCTIONS_DIR — nothing was checked, which is not a pass."
  exit 1
fi
if [ "$fail" -gt 0 ]; then
  echo "$fail problem(s) across $checked function(s)."
  exit 1
fi
echo "All $checked edge functions either ask who is calling or are listed as system actors with a reason."
