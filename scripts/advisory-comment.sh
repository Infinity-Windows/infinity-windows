#!/usr/bin/env bash
# Put the advisory review on the pull request, in ONE comment, updated in place.
#
# WHY IN PLACE. This runs on every push to a branch. A review that posted a new
# comment each time would bury the conversation under its own history within a
# day, and people would stop reading the thread — which is where the human
# review happens. So the body carries a hidden marker, and every later run finds
# that comment and rewrites it. The pull request keeps exactly one, always
# showing the current commit.
#
# WHY A COMMENT AND NOT A REVIEW. A review can be REQUEST_CHANGES, and a
# REQUEST_CHANGES from a robot at 2 AM blocks an auto-merge on an answer nobody
# has read. An issue comment cannot block anything. That is the point.
#
# WHY IT NEVER FAILS. The comment is how a person hears about a finding, but a
# GitHub API hiccup must not turn a pull request red on its own. It says loudly
# what went wrong, in the job log, and exits 0.
#
# THE RUN COUNTER LIVES IN THE MARKER, and that is a deliberate choice about
# permissions rather than a clever trick. The agent half stops after five runs
# on one pull request in a day, so something has to count them. Asking the
# Actions API would mean granting this workflow `actions: read` on a PUBLIC
# repository for the sake of a number. The comment is already being read, so
# the count rides in the marker: `<!-- advisory-review runs=3 on=2026-09-06 -->`.
# A stamp from another day counts as zero, which is what "per day" means.
#
# Usage:
#   scripts/advisory-comment.sh --pr 123 --count           # today's run count
#   scripts/advisory-comment.sh --pr 123 --body-file b.md --runs 4
#
# Env: GH_BIN (the gh binary, stubbed by the tests), GH_REPO / --repo.
set -uo pipefail

MARKER_PREFIX='<!-- advisory-review'
GH_BIN="${GH_BIN:-gh}"
PR=""
BODY_FILE=""
REPO="${GH_REPO:-}"
RUNS=1
COUNT_ONLY=0
TODAY="${ADVISORY_TODAY:-$(date -u +%Y-%m-%d)}"

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-1}"; shift 2 ;;
    --count) COUNT_ONLY=1; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "advisory-comment: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$PR" ] || { echo "advisory-comment: --pr is required" >&2; exit 2; }
[ -n "$REPO" ] || { echo "advisory-comment: no repository; pass --repo or set GH_REPO" >&2; exit 2; }
if [ "$COUNT_ONLY" = 0 ]; then
  [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ] ||
    { echo "advisory-comment: --body-file must name a file that exists" >&2; exit 2; }
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The comment this workflow already left, if there is one.
#
# TWO CONDITIONS, AND THE SECOND ONE IS THE IMPORTANT ONE. The marker says
# which comment is ours; `.user.type == "Bot"` says it is ours at all. On a
# PUBLIC repository anybody can leave a comment, and this used to match on the
# marker alone — so a stranger could paste `<!-- advisory-review runs=9
# on=<today> -->` into a drive-by comment and two things would follow. The
# review would PATCH that person's comment, overwriting what they wrote, using
# a `pull-requests: write` token. And `--count` would read the run count out of
# it, so `runs=9` against a cap of five silently switched the reading half off
# for the day. Neither needs an account with any access to this repository.
#
# The author is still not pinned to one LOGIN — that really does differ between
# a GITHUB_TOKEN run, an app-token run and a re-run — but every one of those is
# a Bot, and a person is not. Worst case, an unexpected author means a second
# comment rather than a stolen one, which is the right way round to be wrong.
find_existing() {
  "$GH_BIN" api --paginate \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/issues/$PR/comments" \
    --jq "[.[] | select(.user.type == \"Bot\" and (.body | contains(\"$MARKER_PREFIX\")))] | first | (.id | tostring) + \"\\t\" + .body" \
    2>"$WORK/err"
}

if [ "$COUNT_ONLY" = 1 ]; then
  # A number, always, even when nothing can be read: an unknown count must not
  # stop the review, only an over-budget one.
  row="$(find_existing)" || { echo 0; exit 0; }
  case "$row" in ""|null*) echo 0; exit 0 ;; esac
  n="$(printf '%s' "$row" | sed -n "s/.*runs=\([0-9]\{1,\}\) on=$TODAY.*/\1/p" | head -1)"
  [ -n "$n" ] || n=0
  echo "$n"
  exit 0
fi

# GitHub refuses a comment body over 65536 characters. Losing the whole comment
# because one check was chatty would be the worst kind of failure — the findings
# that mattered are usually at the top — so it is cut with a line saying so.
LIMIT=65000
BODY="$(cat "$BODY_FILE")"
if [ "${#BODY}" -gt "$LIMIT" ]; then
  BODY="${BODY:0:$LIMIT}

_Cut here: the full review was longer than one GitHub comment can hold. The rest is in the workflow run's log._"
fi
BODY="$MARKER_PREFIX runs=$RUNS on=$TODAY -->
$BODY"
printf '%s\n' "$BODY" >"$WORK/body"

row="$(find_existing)"
rc=$?
existing="${row%%	*}"
if [ "$rc" -ne 0 ]; then
  echo "advisory-comment: could not read the existing comments, so nothing was posted." >&2
  sed 's/^/  /' "$WORK/err" >&2
  exit 0
fi
case "$existing" in ""|null) existing="" ;; esac

if [ -n "$existing" ]; then
  "$GH_BIN" api --method PATCH \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/issues/comments/$existing" \
    -F "body=@$WORK/body" >/dev/null 2>"$WORK/err" &&
    { echo "advisory-comment: updated comment $existing"; exit 0; }
  echo "advisory-comment: could not update comment $existing." >&2
else
  "$GH_BIN" api --method POST \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/issues/$PR/comments" \
    -F "body=@$WORK/body" >/dev/null 2>"$WORK/err" &&
    { echo "advisory-comment: posted a new comment on #$PR"; exit 0; }
  echo "advisory-comment: could not post a comment on #$PR." >&2
fi
sed 's/^/  /' "$WORK/err" >&2
exit 0
