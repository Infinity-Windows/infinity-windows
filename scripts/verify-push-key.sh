#!/usr/bin/env bash
# Check that the push key the APP is built with is the same one the SERVER can
# sign with.
#
# Why this exists: web push needs a matching pair. The browser subscribes with
# the public half (`VITE_VAPID_PUBLIC_KEY`, a GitHub repo secret compiled into
# the bundle) and `send-push` signs with the private half (`VAPID_PRIVATE_KEY`,
# a Supabase Edge Function secret). If the app is built with a public key whose
# private half is not the one Supabase holds, then:
#
#   - every existing check in this repo still passes — send-push is deployed,
#     both VAPID secrets exist, the frontend has a key, nothing 500s;
#   - and every notification silently fails to arrive on a real phone.
#
# That is exactly the shape of failure this pipeline keeps getting bitten by,
# and it happened for real: a pair generated on 2026-07-20 against
# jvsyhtarnvmdilsgksdi was carried into a laptop `.env` that pointed at
# czprjcskmzzagdztqonm. Nothing said a word.
#
# How it can check without reading a secret. `supabase secrets list` prints
# names and a SHA-256 DIGEST of each value, never the value. So the frontend key
# — which is public by design and is already readable in the published bundle —
# is hashed here and compared against the digest the platform reports. Neither
# key nor digest is ever printed.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   export VITE_VAPID_PUBLIC_KEY=B...                  # the repo secret
#   scripts/verify-push-key.sh
#
# Like scripts/pgq.sh, scripts/verify-schema.sh and
# scripts/verify-function-secrets.sh, the project ref has no default: checking
# one project's keys while believing you checked another's is how this went
# wrong in the first place.
#
# Tuning (used by scripts/verify-push-key.test.sh, rarely otherwise):
#   SUPABASE_BIN     Name/path of the Supabase CLI binary.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

SUPABASE="${SUPABASE_BIN:-supabase}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so nothing was compared." >&2
  echo "This is a VERIFICATION failure — the keys may or may not match." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project whose push key you mean to check, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/verify-push-key.sh
EOF
  exit 1
fi

REF="$SUPABASE_PROJECT_REF"
FRONTEND_KEY="${VITE_VAPID_PUBLIC_KEY:-}"

# No frontend key is a different situation from a mismatched one, and it is not
# this script's to fail on: an app built without one simply never subscribes a
# device, which scripts/verify-function-secrets.sh cannot see either. Say so and
# pass, so the one thing that turns this red is a genuine mismatch.
if [ -z "$FRONTEND_KEY" ]; then
  echo "VITE_VAPID_PUBLIC_KEY is not set, so there is nothing to compare."
  echo
  echo "The published app has no push key compiled into it, which means no phone"
  echo "ever subscribes and no notification is ever delivered. Nothing is"
  echo "mismatched — there is simply no key. To fix, see README.md, 'Web push'."
  exit 0
fi

out="$(mktemp)" || exit 1
trap 'rm -f "$out"' EXIT

if ! "$SUPABASE" secrets list --project-ref "$REF" >"$out" 2>&1; then
  echo "FAIL: could not list the secrets of $REF." >&2
  sed 's/^/    /' "$out" >&2
  echo "This is a VERIFICATION failure, not a mismatch. Nothing here says the" >&2
  echo "keys disagree — the CLI never answered." >&2
  exit 1
fi

# NAME | DIGEST, same two-column table scripts/verify-function-secrets.sh parses.
digest="$(
  awk -F'|' '{
    gsub(/[ \t]/, "", $1); gsub(/[ \t]/, "", $2)
    if ($1 == "VAPID_PUBLIC_KEY") print tolower($2)
  }' <"$out" | head -n 1
)"

if [ -z "$digest" ]; then
  echo "FAIL: $REF reports no VAPID_PUBLIC_KEY, so nothing was compared." >&2
  echo "scripts/verify-function-secrets.sh is the check that owns that case." >&2
  exit 1
fi

# A digest that is not hex means the CLI's output format moved under us. Refusing
# to guess beats reporting a mismatch that is really a parsing bug — the lesson
# scripts/verify-functions.sh already learned about undetermined answers.
if ! printf '%s' "$digest" | grep -qE '^[0-9a-f]{16,}$'; then
  echo "FAIL: could not read a digest for VAPID_PUBLIC_KEY on $REF." >&2
  echo "Suspect a changed CLI output format before you suspect the key." >&2
  exit 1
fi

# sha256sum on Linux, shasum on macOS. Both print "<hex>  -".
if command -v sha256sum >/dev/null 2>&1; then
  expected="$(printf '%s' "$FRONTEND_KEY" | sha256sum | cut -d' ' -f1)"
else
  expected="$(printf '%s' "$FRONTEND_KEY" | shasum -a 256 | cut -d' ' -f1)"
fi
if [ -z "$expected" ]; then
  echo "FAIL: could not hash the frontend key, so nothing was compared." >&2
  exit 1
fi

# Compared over the digest's own length, so a CLI that ever prints a shortened
# digest narrows the check rather than breaking it.
if [ "${expected:0:${#digest}}" = "$digest" ]; then
  echo "project: $REF"
  echo "The app's push key matches the one $REF signs with. Push can be delivered."
  exit 0
fi

{
  echo "Notifications cannot reach anyone's phone: the app and the server hold different push keys"
  echo
  echo "WHAT THIS MEANS"
  echo
  echo "  The app asks a phone to sign up for notifications using one key, and"
  echo "  the server sends them using a different one. The phone rejects"
  echo "  everything the server sends, and nobody is told. Notifications look"
  echo "  switched on and simply never arrive."
  echo
  echo "  Nothing broke in this run. This is a setting that does not match, and"
  echo "  notifications have been failing that way already."
  echo
  echo "WHAT TO DO"
  echo
  echo "  The two halves of one pair have to be set together. Pick whichever"
  echo "  pair you still have BOTH halves of, or generate a new pair"
  echo "  (npx web-push generate-vapid-keys), then set all three:"
  echo
  echo "  1. Supabase dashboard: https://supabase.com/dashboard"
  echo "     Pick the project ($REF)."
  echo "     Project Settings -> Edge Functions -> Secrets."
  echo "     Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY from the SAME pair."
  echo "  2. GitHub: Settings -> Secrets and variables -> Actions."
  echo "     Set VITE_VAPID_PUBLIC_KEY to that same public half."
  echo "  3. Re-run: Actions -> Deploy GitHub Pages -> Run workflow. The public"
  echo "     key is compiled in at build time, so the app must be rebuilt."
  echo
  echo "  Everyone already signed up for notifications must then turn them off"
  echo "  and on again, because their phone signed up with the old key."
  echo
  echo "TECHNICAL DETAIL"
  echo
  echo "  project: $REF"
  echo "  SHA-256 of VITE_VAPID_PUBLIC_KEY does not match the digest"
  echo "  $REF reports for its VAPID_PUBLIC_KEY secret. Neither the key nor the"
  echo "  digest is printed here."
  echo
  echo "  Which key lives where, and why: README.md, 'Web push'."
} >&2

# Let the workflow lead its Slack post with the cause rather than a job name,
# the same contract scripts/verify-function-secrets.sh has.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "push_key_headline=Notifications cannot reach anyone's phone: the app and the server hold different push keys" >>"$GITHUB_OUTPUT"
fi

exit 1
