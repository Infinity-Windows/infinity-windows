#!/usr/bin/env bash
# Try a pull request's new migrations and RPCs on the REAL database, inside one
# transaction that is always rolled back — so a check constraint, a missing
# column or a grant that only production has is found before the merge, not by
# the crew after it.
#
# WHY. Twice a migration passed every local test and failed in production on a
# constraint the local copy never had (2026-09-06: #578's finalize hit
# movements_one_subject_ck, after a probe that had only counted objects and
# never CALLED the RPC). The rule since: every new migration is applied and
# every new RPC is called, as a real role on the sandbox job, inside a
# transaction that is then rolled back, before merge.
#
# HOW. ONE statement batch to the Management API's query endpoint:
#
#   begin;  ->  the harness  ->  the migrations, in order  ->  the probe
#           ->  do $$ raise exception 'DRY_RUN_RESULT:<json>' $$
#
# The forced error at the end is the guarantee. Postgres rolls the whole batch
# back whether or not anything before it misbehaved, and the error message is
# how the probe's results get out; scripts/db_dry_run.py builds the batch and
# reads that answer. If any statement fails first, THAT error is the result —
# the change is broken — and it was rolled back too. A migration that wraps
# itself in begin/commit has the wrapper set aside (the batch owns the
# transaction); anything else that could escape it — a commit in the middle,
# create index concurrently, vacuum — is refused before a byte is sent, and so
# is a probe that carries any transaction control of its own.
#
# Usage (needs the management token, which only GitHub holds — run it through
# .github/workflows/db-dry-run.yml; docs/db-dry-run.md has the commands):
#
#   SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
#   scripts/db-dry-run.sh --probe scripts/dry-run-probes/pr-640-clock-integrity.sql \
#       supabase/migrations/20261028000000_clock_integrity.sql [more, in order]
#
# Exit codes: 0 every check passed and nothing was kept; 1 the change is broken
# (a statement failed, a check failed, or the probe checked nothing); 2 refused
# or misused, nothing was sent; 3 could not tell (no answer, a timeout, a
# token or project problem, or a "dry run:" refusal that stopped the run
# while it set itself up, before the change was tried).
#
# The token is never printed and never put on a command line: curl reads it
# from a mode-600 config file that is deleted on exit, and everything printed
# passes through the judge's scrubber.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
helper="$here/db_dry_run.py"

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

probe=""
migrations=()
while [ $# -gt 0 ]; do
  case "$1" in
    --probe)
      [ $# -ge 2 ] || { echo "REFUSED: --probe needs a file. Nothing was sent." >&2; exit 2; }
      probe="$2"; shift 2 ;;
    --probe=*) probe="${1#--probe=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do migrations+=("$1"); shift; done ;;
    -*) echo "REFUSED: unknown option $1. Nothing was sent." >&2; usage >&2; exit 2 ;;
    *) migrations+=("$1"); shift ;;
  esac
done

if [ -z "$probe" ]; then
  echo "REFUSED: name the probe with --probe (scripts/dry-run-probes/TEMPLATE.sql shows the shape). Nothing was sent." >&2
  exit 2
fi
# bash 3.2 (macOS) trips on an empty array under set -u; this form is safe on both.
if [ "${#migrations[@]}" -eq 0 ]; then
  echo "REFUSED: name at least one migration file, in the order it applies. Nothing was sent." >&2
  exit 2
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
REFUSED: SUPABASE_ACCESS_TOKEN is not set, so nothing was sent.
No developer machine holds it; GitHub does. Run the practice run there:
  gh workflow run db-dry-run.yml -f ref=<branch> -f migrations="<files>" -f probe=<probe>
(docs/db-dry-run.md).
MSG
  exit 2
fi
if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<'MSG'
REFUSED: SUPABASE_PROJECT_REF is not set, and there is no default (scripts/pgq.sh says why:
a guessed project once produced an audit of the wrong database). Production is
czprjcskmzzagdztqonm. Nothing was sent.
MSG
  exit 2
fi

# Everything temporary is private to this process: the config file below holds
# the token.
umask 077
work="$(mktemp -d)" || exit 3
trap 'rm -rf "$work"' EXIT

# 1. The batch, or a refusal. The plan it prints names every file and what
#    was set aside, so the log says exactly what was tried.
if ! python3 "$helper" build --out "$work/batch.sql" --probe "$probe" "${migrations[@]}"; then
  exit 2
fi

# 2. One request. The token travels in curl's config file, never in argv.
python3 -c 'import json, sys
with open(sys.argv[1], encoding="utf-8") as src, open(sys.argv[2], "w", encoding="utf-8") as dst:
    json.dump({"query": src.read()}, dst)' "$work/batch.sql" "$work/body.json" || exit 3
printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN" >"$work/curl.cfg"

echo "Sending the batch to $SUPABASE_PROJECT_REF (one transaction; it ends in the forced error)..."
status="$(curl -sS -K "$work/curl.cfg" -X POST \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Content-Type: application/json" \
  --data @"$work/body.json" \
  --max-time "${DB_DRY_RUN_HTTP_TIMEOUT:-600}" \
  -o "$work/response" -w '%{http_code}' 2>"$work/curl.err")"
rc=$?
[ -f "$work/response" ] || : >"$work/response"

if [ "$rc" -ne 0 ]; then
  echo "COULD NOT TELL: curl exited $rc before an answer came back, so nothing was measured." >&2
  echo "If the request reached Postgres, the batch still ends in its forced error and is rolled back;" >&2
  echo "if it did not, nothing ran. Either way nothing was kept. curl said:" >&2
  # curl's own message never carries the header, and the scrub is belt and braces.
  python3 - "$work/curl.err" <<'PY' >&2
import os, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
if token:
    text = text.replace(token, "[token]")
sys.stdout.write("".join("    " + line for line in text.splitlines(True)))
PY
  exit 3
fi

# 3. The verdict. The judge scrubs the token and any email out of what it prints.
python3 "$helper" judge --status "$status" --body "$work/response" --project "$SUPABASE_PROJECT_REF"
