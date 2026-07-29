#!/usr/bin/env bash
# Make the DEPLOYED writing features actually write something, and read what
# came back.
#
# Why this exists: scripts/smoke-ask.sh proves Ask Infinity reaches Claude. It
# says nothing about the other five features that generate text, and those moved
# provider — from OpenAI to Claude — which is exactly the kind of change that
# deploys clean and fails on first real use. This repo has been bitten by that
# precise shape more than once: `ask` looked healthy for weeks while never
# contacting an AI at all, because it silently fell back to canned notes.
#
# The specific risk being checked. OpenAI had a setting that guaranteed a
# machine-readable answer; Claude has none, so the guarantee was rebuilt out of
# forced tool use (see supabase/functions/_shared/anthropicJson.ts). If that
# rebuild is subtly wrong, every one of these features returns an empty or
# half-filled result — a toolbox talk with no hazards, a planset that reads as
# zero openings — and nothing goes red, because "no rows" and "no rows found"
# look identical from outside. So this asks for output whose CONTENT can be
# checked, not merely a 200.
#
# FOUR FEATURES, each reported on its own:
#
#   reading delivery schedules  synthetic planset text in, rows out. No database
#                               write at all, and the expected rows are known, so
#                               this is the strongest single proof.
#   toolbox talks               a real topic in, a real talk out. This one SAVES,
#                               so the row it creates is deleted again below.
#   how-to guides               needs a window type with a reference install
#                               recorded. Reported as not-exercised when no such
#                               type exists, never as a pass.
#   window-type tips            needs a window type with install memos. Same.
#
# THREE OUTCOMES, the same contract as scripts/smoke-ask.sh, because a check that
# goes red when Anthropic has a bad afternoon is a check the team learns to
# ignore:
#
#   exit 0  Every feature that COULD be exercised produced real output.
#   exit 1  A feature was reached and did not produce output. Ours to fix. Red.
#   exit 2  Could not tell: no credentials, the AI service was busy, or a spend
#           limit refused the call. Warn, never red.
#
# A feature that could not be exercised for want of data is NOT a pass and NOT a
# failure. It is said out loud, in those words, so nobody reads this log as proof
# of something it never tested.
#
# Nothing customer-identifying is printed. The planset text is invented here, the
# talk topic is about ladders, and the how-to/tips probes print only the window
# type code and how many lines came back — never a job, an address or a name.
#
# Usage:
#   export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm   # REQUIRED, no default
#   export SUPABASE_SERVICE_ROLE_KEY=eyJ...            # or TEXT_SMOKE_JWT
#   scripts/smoke-text-features.sh
#
# Tuning (used by scripts/smoke-text-features.test.sh, rarely otherwise):
#   TEXT_SMOKE_BASE      Override the functions base URL.
#   TEXT_SMOKE_REST      Override the PostgREST base URL.
#   TEXT_SMOKE_TIMEOUT   Seconds to wait for one call (default 120).
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

if [ -z "${SUPABASE_PROJECT_REF:-}" ] && [ -z "${TEXT_SMOKE_BASE:-}" ]; then
  cat >&2 <<'EOF'
FAIL: SUPABASE_PROJECT_REF is not set, and there is no default.

Name the project whose writing features you mean to test, e.g. for production:

  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/smoke-text-features.sh
EOF
  exit 1
fi

REF="${SUPABASE_PROJECT_REF:-}"
BASE="${TEXT_SMOKE_BASE:-https://$REF.supabase.co/functions/v1}"
REST="${TEXT_SMOKE_REST:-https://$REF.supabase.co/rest/v1}"
JWT="${TEXT_SMOKE_JWT:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
TIMEOUT="${TEXT_SMOKE_TIMEOUT:-120}"

if [ -z "$JWT" ]; then
  echo "The writing features were not tested: no caller credentials here."
  echo
  echo "Set SUPABASE_SERVICE_ROLE_KEY (or TEXT_SMOKE_JWT). Without one the"
  echo "platform gateway rejects every request before the function runs, so a"
  echo "failure would say nothing about whether these features work."
  echo
  echo "This is a VERIFICATION gap, not a broken feature. Nothing was measured."
  exit 2
fi

body="$(mktemp)" || exit 1
err="$(mktemp)" || exit 1
trap 'rm -f "$body" "$err"' EXIT

# Verdicts collected per feature, printed together at the end so the report reads
# as one page rather than as four interleaved stories.
declare -a proved=()      # feature -> what came back
declare -a untested=()    # feature -> why it could not be exercised
declare -a broken=()      # feature -> what went wrong
soft_fail=0               # a busy provider or a spend cap: warn, never red

CODE=""
BODY=""

# POST json to a deployed function. Sets CODE and BODY.
call() {
  local name="$1" payload="$2"
  : >"$body"
  : >"$err"
  # Assignment and exit status on separate lines: `CODE=$(curl ...)` reports the
  # assignment's status, and curl's is the only thing that tells "no answer at
  # all" from "answered, with an error".
  CODE="$(printf '%s' "$payload" | curl -sS -o "$body" -w '%{http_code}' \
    -X POST "$BASE/$name" \
    -H "Authorization: Bearer $JWT" \
    -H "apikey: $JWT" \
    -H 'Content-Type: application/json' \
    --data-binary @- --max-time "$TIMEOUT" 2>"$err")"
  local rc=$?
  BODY="$(tr -d '\r' <"$body")"
  if [ "$rc" -ne 0 ] || ! [[ "$CODE" =~ ^[0-9]{3}$ ]]; then
    CODE="000"
    BODY="curl exit $rc: $(tr '\n' ' ' <"$err" | head -c 300)"
  fi
}

# GET from PostgREST. Sets CODE and BODY.
query() {
  local path="$1"
  : >"$body"
  CODE="$(curl -sS -o "$body" -w '%{http_code}' \
    "$REST/$path" \
    -H "Authorization: Bearer $JWT" \
    -H "apikey: $JWT" \
    --max-time 30 2>/dev/null)"
  [[ "$CODE" =~ ^[0-9]{3}$ ]] || CODE="000"
  BODY="$(tr -d '\r' <"$body")"
}

# Read one field out of BODY with python3 rather than grep, so a brace or a quote
# in generated prose cannot fool it. Prints nothing when absent.
field() {
  BODY="$BODY" python3 -c '
import json, os, sys
try:
    data = json.loads(os.environ["BODY"])
except Exception:
    sys.exit(0)
for key in sys.argv[1:]:
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        sys.exit(0)
    data = data.get(key)
if data is None:
    sys.exit(0)
if isinstance(data, (dict, list)):
    print(json.dumps(data)[:400])
else:
    print(" ".join(str(data).split())[:400])
' "$@"
}

# Is this response a spend refusal or a busy provider rather than a fault? Those
# say nothing about whether the feature works, so they must not go red.
soft_reason() {
  local lower
  lower="$(printf '%s' "$BODY" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$(field limited)" ]; then
    echo "an AI spend limit refused the call, so nothing was measured"
    return 0
  fi
  case "$lower" in
  *overloaded* | *rate_limit* | *rate\ limit* | *529* | *timed\ out* | *timeout*)
    echo "the AI service was busy (rate-limited or overloaded)"
    return 0
    ;;
  esac
  if [ "$CODE" = "000" ]; then
    echo "the request never completed: $BODY"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# 1. Reading delivery schedules. No database write; the answer is checkable.
# ---------------------------------------------------------------------------
# Invented planset text in the shape a real schedule table has. Three marks, one
# of them with a quantity of 4 — the quantity column is the field that used to be
# collapsed to 1, so it is the one worth proving.
SCHEDULE_TEXT='WINDOW SCHEDULE
MARK   TYPE          QTY   WIDTH   HEIGHT   COLOR
W1     SINGLE HUNG    4     36"     60"     WHITE
W2     FIXED PICTURE  1     72"     48"     WHITE
D1     SLIDING DOOR   2     96"     80"     BRONZE'

payload="$(TEXT="$SCHEDULE_TEXT" python3 -c '
import json, os
print(json.dumps({"pages": [{"pageNumber": 1, "text": os.environ["TEXT"]}],
                  "catalog": []}))')"
call extract-schedule "$payload"
rows="$(field rows)"
rowcount="$(BODY="$BODY" python3 -c '
import json, os
try:
    d = json.loads(os.environ["BODY"])
    print(len(d.get("rows") or []))
except Exception:
    print(0)')"

if [ "$CODE" = "200" ] && [ "${rowcount:-0}" -ge 2 ]; then
  proved+=("reading delivery schedules|$rowcount schedule row(s) read from a test planset: $rows")
elif reason="$(soft_reason)"; then
  untested+=("reading delivery schedules|$reason")
  soft_fail=1
else
  broken+=("reading delivery schedules|HTTP $CODE, $rowcount row(s): $(printf '%s' "$BODY" | head -c 400)")
fi

# ---------------------------------------------------------------------------
# 2. Toolbox talks. This one SAVES a row, so it is deleted again afterwards.
# ---------------------------------------------------------------------------
# with_images false on purpose: the diagrams are an OpenAI call and by far the
# most expensive part of the feature, and they prove nothing about the writing
# that just changed provider.
call generate-toolbox-talk \
  '{"topic":"Ladder safety when setting a second-storey window","with_images":false}'
talk_id="$(field talk_id)"
talk_title="$(field title)"

if [ "$CODE" = "200" ] && [ -n "$talk_id" ] && [ -n "$talk_title" ]; then
  # A 200 with a title is not enough. A talk whose sections came back empty is
  # exactly what a broken strict-JSON path produces, and it would still save.
  query "safety_talks?id=eq.$talk_id&select=title,sections_json"
  hazards="$(BODY="$BODY" python3 -c '
import json, os
try:
    rows = json.loads(os.environ["BODY"])
    s = (rows[0] if rows else {}).get("sections_json") or {}
    print(len(s.get("key_hazards") or []), len(s.get("steps") or []))
except Exception:
    print("0 0")')"
  read -r nhaz nsteps <<<"$hazards"
  if [ "${nhaz:-0}" -ge 1 ] && [ "${nsteps:-0}" -ge 1 ]; then
    proved+=("toolbox talks|\"$talk_title\" — $nhaz hazard(s), $nsteps step(s)")
  else
    broken+=("toolbox talks|saved \"$talk_title\" with $nhaz hazard(s) and $nsteps step(s): the talk is empty, which is what a broken JSON path looks like")
  fi

  # Clean up after ourselves. A stray test talk on the Safety screen is a small
  # thing, but it is crew-visible, and a verification step must not leave litter
  # in the app it is verifying.
  del="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    "$REST/safety_talks?id=eq.$talk_id" \
    -H "Authorization: Bearer $JWT" -H "apikey: $JWT" \
    --max-time 30 2>/dev/null)"
  case "$del" in
  2*) : ;;
  *) echo "NOTE: could not delete the test toolbox talk $talk_id (HTTP $del). Delete it on the Safety screen." >&2 ;;
  esac
elif reason="$(soft_reason)"; then
  untested+=("toolbox talks|$reason")
  soft_fail=1
else
  broken+=("toolbox talks|HTTP $CODE: $(printf '%s' "$BODY" | head -c 400)")
fi

# ---------------------------------------------------------------------------
# 3. How-to guides. Needs a window type with a reference ("golden") install.
# ---------------------------------------------------------------------------
query "window_types?golden_install_event_id=not.is.null&select=id,type_code&limit=1"
howto_id="$(field id)"
howto_code="$(field type_code)"

if [ -z "$howto_id" ]; then
  untested+=("how-to guides|no window type has a reference install recorded yet, so there is nothing for it to write about. NOT tested.")
else
  call generate-howto "{\"type_id\":\"$howto_id\"}"
  steps="$(field steps)"
  if [ "$CODE" = "200" ] && [ -n "$steps" ] && [ "$steps" != "0" ]; then
    proved+=("how-to guides|$steps step(s) written for window type $howto_code")
  elif [ -n "$(field skipped)" ]; then
    untested+=("how-to guides|the function skipped: $(field reason). NOT tested.")
  elif reason="$(soft_reason)"; then
    untested+=("how-to guides|$reason")
    soft_fail=1
  else
    broken+=("how-to guides|HTTP $CODE: $(printf '%s' "$BODY" | head -c 400)")
  fi
fi

# ---------------------------------------------------------------------------
# 4. Window-type tips. Needs a type with install memos behind it.
# ---------------------------------------------------------------------------
# Scoped to ONE type by id. Left unscoped it would rewrite the tips of every
# window type in the catalog, which is not a thing a verification step should do.
query "install_events?window_type_id=not.is.null&select=window_type_id&limit=1"
tips_id="$(field window_type_id)"

if [ -z "$tips_id" ]; then
  untested+=("window-type tips|no install has been recorded against a window type yet, so there are no memos to learn from. NOT tested.")
else
  call synthesize-type-tips "{\"type_id\":\"$tips_id\",\"min_installs\":1}"
  updated="$(BODY="$BODY" python3 -c '
import json, os
try:
    d = json.loads(os.environ["BODY"])
    r = (d.get("results") or [{}])[0]
    print("1" if r.get("updated") else "0", r.get("type_code") or "?")
except Exception:
    print("0 ?")')"
  read -r didupdate tips_code <<<"$updated"
  if [ "$CODE" = "200" ] && [ "$didupdate" = "1" ]; then
    query "window_types?id=eq.$tips_id&select=tips_json,watch_outs_json"
    counts="$(BODY="$BODY" python3 -c '
import json, os
try:
    rows = json.loads(os.environ["BODY"])
    r = rows[0] if rows else {}
    print(len(r.get("tips_json") or []), len(r.get("watch_outs_json") or []))
except Exception:
    print("0 0")')"
    read -r ntips nwatch <<<"$counts"
    if [ "${ntips:-0}" -ge 1 ]; then
      proved+=("window-type tips|$ntips tip(s) and $nwatch watch-out(s) written for $tips_code")
    else
      broken+=("window-type tips|reported success for $tips_code but saved no tips, which is what a broken JSON path looks like")
    fi
  elif [ "$CODE" = "200" ]; then
    untested+=("window-type tips|that window type has too few install memos to synthesise from. NOT tested.")
  elif reason="$(soft_reason)"; then
    untested+=("window-type tips|$reason")
    soft_fail=1
  else
    broken+=("window-type tips|HTTP $CODE: $(printf '%s' "$BODY" | head -c 400)")
  fi
fi

# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------
# Takes the entries as arguments rather than by name: `local -n` needs bash 4.3,
# and this has to stay runnable on a stock macOS shell as well as in CI.
print_list() {
  local item
  for item in "$@"; do
    printf '    %s\n      %s\n' "${item%%|*}" "${item#*|}"
  done
}

if [ "${#broken[@]-0}" -gt 0 ]; then
  # A refused key and an unreadable answer both show up as "no usable output",
  # and they need completely different things done about them — replace a key, or
  # fix the code. Saying which is the difference between a report the owner can
  # act on and one he has to forward to somebody.
  all_broken="$(printf '%s\n' "${broken[@]+"${broken[@]}"}" | tr '[:upper:]' '[:lower:]')"
  case "$all_broken" in
  *invalid\ x-api-key* | *authentication_error* | *invalid_api_key* | *permission_error* | *401* | *403*)
    cause="an API key the provider refused"
    guidance="  The AI provider rejected our key: it is the wrong one, it was revoked, or
  it belongs to an account without access. Put a valid key in the GitHub secret
  ANTHROPIC_API_KEY and re-run Deploy backend. A name-and-digest check cannot
  see this — only a real request can."
    ;;
  *parseable\ json* | *no\ parseable* | *broken\ json\ path*)
    cause="an answer the app could not read"
    guidance="  The provider answered and the answer did not arrive in a shape the app can
  read. That is a code problem, not a key problem: see
  supabase/functions/_shared/anthropicJson.ts, which is what forces a
  machine-readable answer now that the old provider's setting is gone."
    ;;
  *)
    cause="no usable output"
    guidance="  These features were reached and wrote nothing usable. They all generate text
  with Claude, so suspect the API key or the shape of the answer first. The
  response from each is below."
    ;;
  esac

  if [ "${#broken[@]-0}" -eq 1 ]; then
    headline="${broken[0]%%|*} is not working: $cause"
  else
    headline="${#broken[@]-0} writing features are not working: $cause"
  fi

  {
    echo "$headline"
    echo
    echo "WHAT THIS MEANS"
    echo
    echo "$guidance"
    echo
    echo "  Nothing in this run broke them — this is the first check that can see it."
    echo
    echo "  NOT WORKING:"
    print_list "${broken[@]+"${broken[@]}"}"
    if [ "${#proved[@]-0}" -gt 0 ]; then
      echo
      echo "  Working, for contrast:"
      print_list "${proved[@]+"${proved[@]}"}"
    fi
    echo
    echo "  project: ${REF:-<from TEXT_SMOKE_BASE>}"
  } >&2
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "text_smoke_headline=$headline" >>"$GITHUB_OUTPUT"
  fi
  exit 1
fi

if [ "${#proved[@]-0}" -eq 0 ]; then
  {
    echo "Could not tell whether the writing features work: none could be exercised"
    echo
    if [ "${#untested[@]-0}" -gt 0 ]; then
      print_list "${untested[@]+"${untested[@]}"}"
      echo
    fi
    echo "This is a VERIFICATION failure, not a broken feature. Nothing here says"
    echo "anything is misconfigured. Re-run it."
  } >&2
  exit 2
fi

echo "The writing features work: ${#proved[@]-0} of them produced real output"
echo
echo "  project: ${REF:-<from TEXT_SMOKE_BASE>}"
echo
echo "  PROVED — real output came back from Claude:"
print_list "${proved[@]+"${proved[@]}"}"
if [ "${#untested[@]-0}" -gt 0 ]; then
  echo
  echo "  NOT TESTED — read nothing into these either way:"
  print_list "${untested[@]+"${untested[@]}"}"
fi
echo
echo "Each line above is generated content, not a status code. These features"
echo "are not deployed-but-broken."

[ "$soft_fail" -eq 1 ] && exit 2
exit 0
