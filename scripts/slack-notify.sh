#!/usr/bin/env bash
# Post a workflow failure (or a non-blocking warning) to the Slack changelog
# channel.
#
# Why this exists: on 2026-07-29 the nightly Vault brain sync had been failing
# for about a week and nobody knew, because no workflow in this repo said
# anything when it broke. GitHub emails the commit author and nothing else, and
# nobody reads those. A pipeline whose failures are invisible is a pipeline the
# team stops trusting, and this project has already been burned by checks that
# reported success without verifying anything.
#
# Reads everything from the environment so the caller stays a one-liner and this
# stays testable without a network. See .github/workflows/notify-failure.yml for
# the reusable workflow that every other workflow calls.
#
#   SLACK_WEBHOOK    Incoming-webhook URL. ABSENT IS NOT AN ERROR: this logs and
#                    exits 0, so a fork or a repo without the secret is quiet
#                    rather than broken.
#   NOTIFY_KIND      failure (default) or warning. A warning is for something
#                    worth a human's attention that deliberately did NOT fail
#                    the job — the live-only schema objects in
#                    scripts/verify-schema.sh are the case this was added for.
#   WORKFLOW_NAME    e.g. "Deploy backend".
#   RUN_URL          Direct link to the failed run. The whole point of the post.
#   COMMIT_SHA       Full sha; trimmed to 7 for display.
#   COMMIT_MESSAGE   Optional. First line is used as the headline.
#   ACTOR            Who pushed / triggered it.
#   REPO             owner/name, for the fallback commit link.
#   BRANCH           Optional ref name.
#   DETAIL           Optional extra plain-English line(s).
#   CAUSE            Optional. The actual, specific, plain-English reason, in the
#                    words the reader uses. When set it becomes the FIRST line and
#                    the workflow name is demoted below it. "Ask Forge needs an
#                    API key" tells the owner what to do; "Deploy backend FAILED"
#                    tells him only to worry, and he is not an engineer. A caller
#                    that cannot compute a specific cause leaves this unset and
#                    gets the workflow-name header.
#
# Tuning (used by scripts/slack-notify.test.sh, rarely otherwise):
#   JQ_BIN           Name/path of the jq binary. The test suite points this at
#                    something absent to exercise the no-jq path deterministically
#                    on a machine that does have jq.
#
# THIS SCRIPT MUST NEVER FAIL. It runs in an `if: failure()` job, so a non-zero
# exit here would replace a useful red X with a confusing second one, and a
# notifier that breaks the build it is reporting on is worse than no notifier.
# Hence: no `set -e`, every failure path swallowed, and `exit 0` at the bottom.
set -u

kind="${NOTIFY_KIND:-failure}"
webhook="${SLACK_WEBHOOK:-}"

if [ -z "$webhook" ]; then
  echo "SLACK_CHANGELOG_WEBHOOK is not set; skipping the Slack notification."
  echo "This is not a failure — the workflow result is unchanged."
  exit 0
fi

workflow="${WORKFLOW_NAME:-a workflow}"
run_url="${RUN_URL:-}"
sha="${COMMIT_SHA:-}"
short_sha="$(printf '%s' "$sha" | cut -c1-7)"
actor="${ACTOR:-unknown}"
repo="${REPO:-}"
branch="${BRANCH:-}"
detail="${DETAIL:-}"
# First line only, in case a caller hands over a multi-line message.
cause="$(printf '%s' "${CAUSE:-}" | head -n 1)"

# First line only: a squash-merge commit body can be dozens of lines.
headline="$(printf '%s' "${COMMIT_MESSAGE:-}" | head -n 1)"

if [ -n "$cause" ]; then
  # Lead with what is actually wrong. The workflow name is bookkeeping and moves
  # down to the context line.
  if [ "$kind" = "warning" ]; then
    header=":warning: *$cause*"
  else
    header=":rotating_light: *$cause*"
  fi
elif [ "$kind" = "warning" ]; then
  header=":warning: *$workflow needs a look*"
else
  header=":rotating_light: *$workflow FAILED*"
fi

# Prefer the run link. Without it a reader has nothing actionable, so fall back
# to the commit, then to nothing rather than printing an empty line.
link="$run_url"
if [ -z "$link" ] && [ -n "$repo" ] && [ -n "$sha" ]; then
  link="https://github.com/$repo/commit/$sha"
fi

lines=("$header")
# With a cause up top, the workflow name still has to appear somewhere or nobody
# can tell which run to open.
[ -n "$cause" ] && lines+=("_from the $workflow workflow_")
[ -n "$headline" ] && lines+=("*$headline*")

commit_line=""
if [ -n "$short_sha" ]; then
  commit_line="commit \`$short_sha\`"
  [ -n "$branch" ] && commit_line="$commit_line on \`$branch\`"
fi
if [ -n "$commit_line" ]; then
  lines+=("$commit_line, pushed by $actor")
else
  lines+=("pushed by $actor")
fi

[ -n "$detail" ] && lines+=("$detail")

if [ "$kind" = "warning" ]; then
  lines+=("Nothing is broken for users. Details in the run:")
elif [ -n "$cause" ]; then
  # A specific cause means the caller knows what failed, so do not overclaim that
  # the whole run shipped nothing — parts of it may well have.
  lines+=("The full explanation and what to do is in the run:")
else
  lines+=("Nothing shipped from this run. Open it to see what broke:")
fi
[ -n "$link" ] && lines+=("$link")

text="$(printf '%s\n' "${lines[@]}")"
# Drop the trailing newline printf added after the last element.
text="${text%$'\n'}"

# jq builds the JSON so quotes, backticks and newlines in a commit message
# cannot produce an invalid payload. If jq is somehow missing, say so and stay
# green rather than posting garbage.
jq_bin="${JQ_BIN:-jq}"
if ! command -v "$jq_bin" >/dev/null 2>&1; then
  echo "jq is not available; skipping the Slack notification." >&2
  exit 0
fi

# shellcheck disable=SC2016  # '{text: $t}' is a jq program, not shell expansion.
payload="$("$jq_bin" -n --arg t "$text" '{text: $t}')" || {
  echo "could not build the Slack payload; skipping the notification." >&2
  exit 0
}

# Whether the POST was DELIVERED and whether Slack ACCEPTED it are different
# questions, and this used to ask only the first. `curl -sS` exits 0 for any
# completed transfer, including a 404 `no_service` or a 403 `invalid_token`
# from a webhook that has been revoked — so a dead webhook printed "Posted the
# failure notification to Slack" and the run went green.
#
# That is not hypothetical. Between 2026-07-18 and 2026-07-29 every failure
# notification and every changelog post reported success, and not one of them
# arrived in #infinity-app-changelog. Seven days of a silently failing nightly
# job, and a whole afternoon of failing deploys, went unseen behind a notifier
# that could not tell delivery from acceptance. A notifier nobody can trust is
# indistinguishable from no notifier, and it is worse, because it is believed.
#
# Slack's incoming webhooks answer a literal `ok` body with HTTP 200 on success
# and a short error body otherwise, so both are checked.
#
# --max-time so a hung webhook cannot hold a runner for six hours.
response="$(curl -sS -X POST -H 'Content-type: application/json' \
  --max-time 20 --data "$payload" -w '\n%{http_code}' "$webhook" 2>&1)"
curl_rc=$?
http_code="$(printf '%s' "$response" | tail -n 1)"
body="$(printf '%s' "$response" | sed '$d')"

if [ "$curl_rc" -ne 0 ]; then
  echo "Could not reach the Slack webhook; the notification was not posted." >&2
  echo "The workflow result is unchanged." >&2
  # An annotation puts this on the run page. Without one the only trace is a
  # line buried in a log nobody opens, which is how this went unnoticed.
  echo "::warning title=Slack notification not delivered::Could not reach the Slack webhook. The $kind notification for $workflow was NOT posted."
elif [ "$http_code" = "200" ] && [ "$body" = "ok" ]; then
  echo "Posted the $kind notification for $workflow to Slack."
else
  echo "Slack rejected the notification (HTTP $http_code: $body)." >&2
  echo "The notification was NOT posted. The workflow result is unchanged." >&2
  echo "::warning title=Slack notification rejected::Slack answered HTTP $http_code ($body), so the $kind notification for $workflow was NOT posted. The SLACK_CHANGELOG_WEBHOOK secret is probably revoked or points at a deleted channel — create a new incoming webhook and re-set it."
fi

exit 0
