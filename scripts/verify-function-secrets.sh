#!/usr/bin/env bash
# Check that every secret the edge functions need actually exists in the
# Supabase project.
#
# Why this exists: a deployed function and a WORKING function are different
# things. Runtime secrets live in Supabase, not GitHub, so `ask` can deploy
# cleanly, answer the platform's routing probe, pass
# scripts/verify-functions.sh, and still return 500 on every real request
# because ANTHROPIC_API_KEY was never set. Nothing in CI would say a word. That
# is the same shape as every other silent failure this repo has been bitten by.
#
# scripts/function_secrets.py works out what is needed by reading the function
# sources, so this cannot drift the way a hand-written list would.
#
# `supabase secrets list` prints NAMES and digests, never values, so nothing
# secret reaches the log. This script never prints a value either.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   scripts/verify-function-secrets.sh
#
# Like scripts/pgq.sh and scripts/verify-schema.sh, the project ref has no
# default: checking the secrets of a project nobody named is how an audit
# certified the wrong database once already.
#
# Tuning (used by scripts/verify-function-secrets.test.sh, rarely otherwise):
#   SUPABASE_BIN     Name/path of the Supabase CLI binary.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

SUPABASE="${SUPABASE_BIN:-supabase}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so no secret was checked." >&2
  echo "This is a VERIFICATION failure — nothing was measured either way." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project whose secrets you mean to check, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-function-secrets.sh
EOF
  exit 1
fi

REF="$SUPABASE_PROJECT_REF"

# One call, one pass over the sources: "VAR<tab>function,function" per line.
needs="$(python3 scripts/function_secrets.py --users)"
if [ -z "$needs" ]; then
  echo "FAIL: could not work out which secrets the functions need." >&2
  echo "Expected scripts/function_secrets.py to name at least one." >&2
  exit 1
fi

out="$(mktemp)" || exit 1
trap 'rm -f "$out"' EXIT

if ! "$SUPABASE" secrets list --project-ref "$REF" >"$out" 2>&1; then
  echo "FAIL: could not list the secrets of $REF." >&2
  sed 's/^/    /' "$out" >&2
  echo "This is a VERIFICATION failure, not a missing secret. Nothing here says" >&2
  echo "a secret is absent — the CLI never answered." >&2
  exit 1
fi

# The CLI prints a two-column table, NAME | DIGEST. Take the first column and
# keep only things shaped like an env var name, which drops the ---- rule
# without depending on its exact spelling. The header's own first column is the
# literal word NAME, which IS env-var-shaped, so it has to go explicitly —
# without that, a run that read nothing but the header looked like a project
# with one secret called NAME and reported every real secret missing.
present="$(
  cut -d'|' -f1 <"$out" \
    | tr -d ' \t' \
    | grep -E '^[A-Z][A-Z0-9_]*$' \
    | grep -vx 'NAME' \
    | sort -u
)"

# An empty list after a successful call is not "everything is missing": it far
# more likely means the output format changed under us. Refusing to guess is
# the lesson scripts/verify-functions.sh already learned.
if [ -z "$present" ]; then
  echo "FAIL: '$SUPABASE secrets list' succeeded but named no secrets at all." >&2
  echo "That is almost certainly a changed output format rather than an empty" >&2
  echo "project — every project has SUPABASE_URL and friends. Not treating this" >&2
  echo "as 'all secrets missing'. Raw output:" >&2
  sed 's/^/    /' "$out" >&2
  exit 1
fi

# Every Supabase project auto-populates SUPABASE_URL and friends, so seeing none
# of them means the parse is probably wrong rather than the project being bare.
# Said out loud, not failed: guessing wrong here would make the deploy red for a
# CLI formatting change, and a permanently red job is one nobody reads.
if ! printf '%s\n' "$present" | grep -qE '^SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)$'; then
  echo "WARNING: none of the platform secrets (SUPABASE_URL etc.) appeared in the" >&2
  echo "listing. If the verdict below looks wrong, suspect a changed CLI output" >&2
  echo "format before you suspect the project." >&2
fi

missing=()
missing_users=()

echo "project: $REF"
echo "required by the functions in this repo:"
while IFS=$'\t' read -r var users; do
  [ -z "$var" ] && continue
  if printf '%s\n' "$present" | grep -qx -- "$var"; then
    printf '  set      %-24s (%s)\n' "$var" "$users"
  else
    printf '  MISSING  %-24s (%s)\n' "$var" "$users"
    missing+=("$var")
    missing_users+=("$users")
  fi
done <<<"$needs"

if [ "${#missing[@]}" -eq 0 ]; then
  echo
  echo "All required Edge Function secrets are set in $REF."
  exit 0
fi

{
  echo
  echo "FAIL: ${#missing[@]} required Edge Function secret(s) are not set in $REF."
  echo
  for i in "${!missing[@]}"; do
    echo "  ${missing[$i]} is missing — ${missing_users[$i]} will return 500 at runtime."
  done
  echo
  echo "These functions are DEPLOYED and BROKEN: they route, they answer a probe,"
  echo "and they fail on every real request. Set each one (the command prompts for"
  echo "the value and does not echo it):"
  echo
  for var in "${missing[@]}"; do
    echo "  supabase secrets set $var --project-ref $REF"
  done
  echo
  echo "Full list and what each is for: README.md, 'Edge Function secrets'."
} >&2

exit 1
