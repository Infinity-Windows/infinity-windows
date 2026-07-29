#!/usr/bin/env bash
# Push the Edge Function secrets this repo's functions need FROM the environment
# (GitHub Actions secrets) INTO the Supabase project.
#
# Why this exists: scripts/verify-function-secrets.sh can tell you a key is
# missing. It cannot put it there. So the pipeline's answer to "Ask Infinity is
# broken in production" was a red X plus a paragraph asking a non-technical
# owner to log into a dashboard and paste a key by hand. That step was never
# taken: ANTHROPIC_API_KEY had never been set on czprjcskmzzagdztqonm, so `ask`
# and `extract-specs` were deployed-and-broken for as long as they had existed.
#
# A secret that lives ONLY in the Supabase dashboard has no owner, no history
# and no backup. Nobody can tell whether it is still the right value, nothing
# notices when it is deleted, and a rebuilt project silently comes up without
# it. That is the same class of problem as a backend deployed by hand, and it
# gets the same fix: put it in the repo's pipeline and let every merge assert
# it. GitHub becomes the source of truth for any secret GitHub knows about.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
#   - It never unsets anything. `supabase secrets set` only adds or updates the
#     names it is given; removing one is a different subcommand
#     (`secrets unset`) which is not used here and must not be. So a secret that
#     lives only in Supabase — today OPENAI_API_KEY and the VAPID pair — is left
#     exactly as it is. This is additive, never a replace-the-whole-set.
#   - It never fails because a secret is absent from GitHub. Absent means "not
#     managed here yet", not "broken": the value may well already be set in
#     Supabase, which is what scripts/verify-function-secrets.sh checks straight
#     afterwards. Failing here would make every merge red for a state that is
#     merely incomplete, and a permanently red check is one nobody reads.
#   - It never renames. A GitHub secret is synced only to a Supabase secret of
#     the SAME name. In particular VITE_VAPID_PUBLIC_KEY is NOT copied into
#     VAPID_PUBLIC_KEY: those are two halves of a pair, and setting the public
#     half without the private half is precisely the silent mismatch
#     scripts/verify-push-key.sh exists to catch. Manage both halves from
#     GitHub, together, or neither.
#
# It is idempotent. Setting a secret to the value it already holds is a no-op as
# far as the running functions are concerned, so this is safe on every merge.
#
# Surrounding whitespace is trimmed off every value before it is pushed, and the
# trimming is reported. A newline picked up when pasting into the GitHub secrets
# box travels with the value and makes an otherwise-correct key invalid.
#
# NO VALUE IS EVER PRINTED. Values are handed to the CLI through a private
# temporary env file rather than on the command line, so they do not appear in
# the process list either. The file is created with a 077 umask and removed on
# exit. What this script prints is names and verdicts.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   export ANTHROPIC_API_KEY=...                       # whichever you have
#   scripts/sync-function-secrets.sh
#
# Like scripts/pgq.sh, scripts/verify-schema.sh and
# scripts/verify-function-secrets.sh, the project ref has no default: writing
# secrets into a project nobody named is a worse version of the mistake those
# scripts guard against, because this one writes.
#
# Tuning (used by scripts/sync-function-secrets.test.sh, rarely otherwise):
#   SUPABASE_BIN     Name/path of the Supabase CLI binary.
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

SUPABASE="${SUPABASE_BIN:-supabase}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FAIL: SUPABASE_ACCESS_TOKEN is not set, so no secret was pushed." >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project whose secrets you mean to write, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/sync-function-secrets.sh
EOF
  exit 1
fi

REF="$SUPABASE_PROJECT_REF"

# The same derived list scripts/verify-function-secrets.sh checks against, from
# the same source of truth, so the two can never disagree about what is needed.
# A hand-written list here would drift the moment a function gained a dependency.
names="$(python3 scripts/function_secrets.py --names)"
if [ -z "$names" ]; then
  echo "FAIL: could not work out which secrets the functions need." >&2
  echo "Expected scripts/function_secrets.py to name at least one." >&2
  exit 1
fi

present=()
absent=()

trimmed_names=()

for var in $names; do
  # Indirect expansion: the value of the variable NAMED by $var.
  value="${!var:-}"
  if [ -z "$value" ]; then
    absent+=("$var")
    continue
  fi

  # Drop surrounding whitespace. A newline picked up when pasting into the GitHub
  # secrets box travels with the value, and an API key with a trailing newline is
  # rejected as invalid by the provider — so this is not cosmetic. Same reasoning,
  # and the same say-it-out-loud rule, as readCredential() in
  # scripts/lib/supabase-key.mjs: silently repairing it would hide a real mistake
  # in the stored secret, and the next person to rotate it would repeat it.
  trimmed="${value#"${value%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [ "$trimmed" != "$value" ]; then
    trimmed_names+=("$var")
    value="$trimmed"
  fi

  # Nothing but whitespace is not a value. Treated as absent rather than pushed,
  # because writing it would replace a working secret with an empty one.
  if [ -z "$value" ]; then
    absent+=("$var")
    continue
  fi

  # Write the trimmed value back, so the env file below uses it.
  printf -v "$var" '%s' "$value"

  # A value containing a single quote or a newline cannot be written into the
  # env file below without reasoning about how the CLI's dotenv parser unescapes
  # it, and a secret that is silently mangled into a WRONG value is worse than
  # one that is missing: every check would pass and the feature would fail with
  # an authentication error nobody expects. No key this repo uses looks like
  # that, so refuse rather than guess. Nothing about the value is printed.
  case "$value" in
    *\'* | *$'\n'*)
      echo "FAIL: the value supplied for $var contains a quote or a newline." >&2
      echo "Refusing to push it rather than risk writing a mangled value." >&2
      echo "Nothing was pushed. Check how $var is stored in GitHub." >&2
      exit 1
      ;;
  esac
  present+=("$var")
done

echo "project: $REF"

if [ "${#present[@]}" -eq 0 ]; then
  echo "Nothing to push: none of the secrets the functions need are available here."
  printf '  not in GitHub  %s\n' "${absent[@]}"
  echo
  echo "This is not a failure. Whether those are set in $REF is a separate"
  echo "question, and scripts/verify-function-secrets.sh is what answers it."
  exit 0
fi

# umask BEFORE the file exists, so it is never briefly world-readable.
umask 077
envfile="$(mktemp)" || {
  echo "FAIL: could not create a temporary file to hold the values." >&2
  exit 1
}
trap 'rm -f "$envfile"' EXIT

# Single quotes so the CLI's dotenv parser does no interpolation: a value
# containing $ or # is taken literally. Values containing a single quote were
# already refused above, so this cannot produce a malformed line.
for var in "${present[@]}"; do
  printf "%s='%s'\n" "$var" "${!var}" >>"$envfile"
done

out="$(mktemp)" || exit 1
trap 'rm -f "$envfile" "$out"' EXIT

# `secrets set` is add-or-update for exactly the names in the file. Anything
# else already in the project is untouched.
if ! "$SUPABASE" secrets set --env-file "$envfile" --project-ref "$REF" \
  >"$out" 2>&1; then
  echo "FAIL: could not set secrets on $REF." >&2
  # The CLI echoes the names it was given, never the values, so this is safe to
  # print. Guard anyway: if a value ever did appear in an error, printing it
  # would put a live key in a log that outlives the run.
  for var in "${present[@]}"; do
    if grep -qF -- "${!var}" "$out" 2>/dev/null; then
      echo "    (CLI output withheld: it contained a secret value.)" >&2
      exit 1
    fi
  done
  sed 's/^/    /' "$out" >&2
  exit 1
fi

printf '  pushed         %s\n' "${present[@]}"
[ "${#absent[@]}" -gt 0 ] && printf '  not in GitHub  %s\n' "${absent[@]}"
echo
echo "${#present[@]} secret(s) pushed to $REF from the environment."

# Said out loud rather than fixed quietly: the stored secret really does have
# stray whitespace in it, and whoever rotates it next will paste it the same way.
if [ "${#trimmed_names[@]}" -gt 0 ]; then
  echo
  echo "NOTE: ${#trimmed_names[@]} value(s) had spaces or a newline around them and"
  echo "were trimmed before being pushed:"
  printf '    %s\n' "${trimmed_names[@]}"
  echo
  echo "The pushed value is correct. The one stored in GitHub still has the stray"
  echo "whitespace, almost certainly from pasting into the secrets box. Worth"
  echo "re-saving it there so this stops being a thing that needs fixing."
fi

if [ "${#absent[@]}" -gt 0 ]; then
  echo
  echo "${#absent[@]} secret(s) the functions need are not stored in GitHub, so"
  echo "they were left alone rather than cleared. If they work today they are set"
  echo "in Supabase only, which means nothing in this repo can restore them and"
  echo "nothing notices if they are deleted. Add them as GitHub Actions secrets"
  echo "of the SAME name to bring them under this workflow:"
  printf '    %s\n' "${absent[@]}"
fi

# Names only — the workflow puts this in the job summary.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "pushed_count=${#present[@]}"
    echo "pushed_names=${present[*]}"
    echo "unmanaged_count=${#absent[@]}"
    echo "unmanaged_names=${absent[*]}"
  } >>"$GITHUB_OUTPUT"
fi

exit 0
