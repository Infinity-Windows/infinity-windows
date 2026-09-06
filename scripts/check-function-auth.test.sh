#!/usr/bin/env bash
# Tests for scripts/check-function-auth.sh. Offline: throwaway functions in a
# temp directory, a throwaway allow-list, a throwaway config.
#
# What has to hold: a function that checks its caller passes; one on the
# system-actor list passes; one that does neither FAILS naming the file and
# saying what to do; a stale list entry fails; an open gateway
# (verify_jwt = false) off the list fails; and the real repo passes today.
#   scripts/check-function-auth.test.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/check-function-auth.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

mkfn() { # name body
  mkdir -p "$work/functions/$1"; printf '%s\n' "$2" > "$work/functions/$1/index.ts"
}
run() { # expected-exit, then env
  local want="$1"; shift
  OUT="$(env FUNCTIONS_DIR="$work/functions" ACTORS_FILE="$work/actors.md" CONFIG_FILE="$work/config.toml" "$@" bash "$SCRIPT" 2>&1)"; RC=$?
  [ "$RC" -eq "$want" ]
}

mkfn good 'import { requireCaller } from "../_shared/auth.ts"; const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); Deno.serve(async (req) => { const u = await requireCaller(req, {}); });'
mkfn sweep 'const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); Deno.serve(async () => {});'
mkfn plain 'Deno.serve(async () => new Response("hi"));'
printf '# actors\n- `sweep` — parameterless cron target, decides everything in SQL.\n' > "$work/actors.md"
printf '[functions.good]\nverify_jwt = true\n\n[functions.sweep]\n# cron\nverify_jwt = false\n' > "$work/config.toml"

if run 0; then ok "a checking function, a listed system actor and a plain function all pass"; else bad "healthy layout failed: $OUT"; fi
case "$OUT" in *"good: asks who is calling"*) ok "  and says the good one asks";; *) bad "no 'asks who is calling' line";; esac
case "$OUT" in *"sweep: system actor, reason recorded"*) ok "  and says the sweep is a recorded actor";; *) bad "no system-actor line";; esac

mkfn rogue 'const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); Deno.serve(async () => {});'
if run 1; then ok "a service-role function that never asks FAILS"; else bad "rogue passed (rc=$RC)"; fi
case "$OUT" in *"rogue/index.ts"*) ok "  and names the file";; *) bad "file not named: $OUT";; esac
case "$OUT" in *"Add a caller check"*"or list it as a system actor with a reason"*) ok "  and says what to do";; *) bad "no instruction";; esac
rm -rf "$work/functions/rogue"

mkfn checked_but_listed 'import { verifyCaller } from "../_shared/auth.ts"; const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); Deno.serve(async (req) => { await verifyCaller(req); });'
printf -- '- `checked_but_listed` — old reason.\n' >> "$work/actors.md"
if run 1; then ok "a listed function that now checks its caller FAILS as a stale entry"; else bad "stale entry passed"; fi
case "$OUT" in *"remove the stale entry"*) ok "  and says to remove it";; *) bad "no stale message";; esac
rm -rf "$work/functions/checked_but_listed"; drop_line() { grep -v "$1" "$work/actors.md" > "$work/actors.tmp"; mv "$work/actors.tmp" "$work/actors.md"; }; drop_line checked_but_listed

printf '[functions.plain]\nverify_jwt = false\n' >> "$work/config.toml"
if run 1; then ok "verify_jwt = false on an unlisted function FAILS"; else bad "open gateway passed"; fi
case "$OUT" in *"anyone can reach it"*) ok "  and explains why";; *) bad "no gateway message";; esac
printf '[functions.good]\nverify_jwt = true\n\n[functions.sweep]\nverify_jwt = false\n' > "$work/config.toml"

printf -- '- `ghost` — a function that was deleted.\n' >> "$work/actors.md"
if run 1; then ok "a listed function that no longer exists FAILS"; else bad "ghost entry passed"; fi
drop_line ghost

rm -rf "$work/functions"/*
if run 1; then ok "an empty functions directory is a failure, not a pass"; else bad "empty dir passed"; fi

OUT="$(bash "$SCRIPT" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then ok "the real repo passes today"; else bad "the real repo fails: $OUT"; fi

echo; echo "check-function-auth: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
