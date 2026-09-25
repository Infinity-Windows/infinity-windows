#!/usr/bin/env bash
# Check that the app just deployed to GitHub Pages can be STARTED by a phone
# that has it installed — a phone on the previous build as much as one on this.
#
# Why this exists: on 2026-09-25 a deploy went green everywhere and turned
# every installed phone and laptop black. The build was fine on its own. What
# broke was between builds: a phone whose service worker still held the
# previous build loaded that build's entry from the worker's copy, and the
# entry asked the network for one file the worker had never saved — a file
# the new deploy no longer had. The app could not start, so it could not
# notice the new build and update itself either. Rolled back within the hour.
# Nothing in the pipeline looked at the live site the way a phone does.
#
# Three questions, asked of the live site:
#   1. Is it THIS deploy? version.json must name the build just shipped
#      (EXPECT_BUILD_ID). Retried for a while, because a deploy is reported
#      live a little before every edge has it.
#   2. Can a phone start it with no signal? Every file index.html loads before
#      the first screen — the module script and each modulepreload — must be
#      in the service worker's precache list (sw.js). One was not, once.
#   3. Can a phone on the PREVIOUS build still start it? Every file under
#      app/public/assets/ is one an older build's entry asks the network for
#      (scripts/check-kept-assets.mjs in app/ says which and until when); each
#      must come back 200 with the exact bytes the repo holds.
#
# Every request carries a fresh query string. GitHub's CDN keeps its own copy
# of each file for up to ten minutes, and a query it has never seen has to
# come from the origin — the same trick the app's own version check uses.
#
# An answer it could not get is a VERIFICATION failure, not a pass: the same
# rule scripts/verify-functions.sh learned about an unanswered probe.
#
# Usage:
#   PAGES_URL=https://app.forgewd.com/ EXPECT_BUILD_ID=<sha> scripts/verify-pages.sh
#
# Env:
#   PAGES_URL           REQUIRED. The site root, with or without a trailing slash.
#   EXPECT_BUILD_ID     The commit the deploy was built from. The workflow
#                       always passes it; by hand it may be left off, and then
#                       question 1 only reads the build id out.
#   KEPT_DIR            Where the kept files live (default app/public/assets).
#
# Tuning (used by scripts/verify-pages.test.sh, rarely otherwise):
#   VERIFY_ATTEMPTS=6      probes for question 1 before giving up
#   VERIFY_RETRY_DELAY=10  seconds between those probes
#   CURL_BIN               name/path of curl
set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "FAIL: could not enter the repository root from $0." >&2
  exit 1
}

CURL="${CURL_BIN:-curl}"
URL="${PAGES_URL:-}"
EXPECT="${EXPECT_BUILD_ID:-}"
KEPT_DIR="${KEPT_DIR:-app/public/assets}"
ATTEMPTS="${VERIFY_ATTEMPTS:-6}"
RETRY_DELAY="${VERIFY_RETRY_DELAY:-10}"

if [ -z "$URL" ]; then
  cat >&2 <<'EOF'
FAIL: PAGES_URL is not set, so nothing was checked.

Name the site to check, e.g. for production:

  PAGES_URL=https://app.forgewd.com/ scripts/verify-pages.sh
EOF
  exit 1
fi
URL="${URL%/}/"
BUST="verify=$(date +%s)$$"

tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT

# fetch <path under the site root> <file to save to>
# Prints the HTTP status, or nothing when curl never got one.
fetch() {
  local status
  status="$("$CURL" -sS -L --max-time 30 -o "$2" -w '%{http_code}' "${URL}$1?${BUST}" 2>>"$tmp/curl.err")" || status=""
  printf '%s' "$status"
}

# sha256sum on Linux, shasum on macOS. Both print "<hex>  <file>".
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Every failure leads with one plain-English line, so the workflow can put it
# where a person will read it — the same contract scripts/verify-push-key.sh
# keeps. Details follow it.
fail() {
  local headline="$1"
  shift
  {
    echo "$headline"
    echo
    for line in "$@"; do echo "  $line"; done
    if [ -s "$tmp/curl.err" ]; then
      echo
      echo "  curl said:"
      sed 's/^/    /' "$tmp/curl.err"
    fi
  } >&2
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "pages_headline=$headline" >>"$GITHUB_OUTPUT"
  fi
  exit 1
}

# --- 1. Is it this deploy? --------------------------------------------------
live_build=""
status=""
attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  status="$(fetch version.json "$tmp/version.json")"
  if [ "$status" = "200" ]; then
    live_build="$(sed -nE 's/.*"buildId"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$tmp/version.json" | head -n 1)"
    if [ -z "$EXPECT" ] || [ "$live_build" = "$EXPECT" ]; then
      break
    fi
  fi
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$RETRY_DELAY"
done

if [ -z "$status" ]; then
  fail "Could not reach $URL to check the deploy, so nothing was verified" \
    "This is a VERIFICATION failure: the site may be fine. curl never got an answer" \
    "for ${URL}version.json in $ATTEMPTS attempts."
fi
if [ "$status" != "200" ] || [ -z "$live_build" ]; then
  fail "The site at $URL is not serving the app: version.json answered $status" \
    "Every deploy writes version.json beside the bundle (vite.config.ts). Without it" \
    "no phone can tell a new build exists, and this check cannot tell what is live."
fi
if [ -n "$EXPECT" ] && [ "$live_build" != "$EXPECT" ]; then
  fail "The site still serves the previous build, not the one just deployed" \
    "live:     $live_build" \
    "expected: $EXPECT" \
    "after $ATTEMPTS attempts, $RETRY_DELAY s apart. Either the deploy has not reached" \
    "the origin yet (re-run this workflow) or it deployed something else."
fi

# --- 2. Can a phone start it with no signal? --------------------------------
status="$(fetch "" "$tmp/index.html")"
[ "$status" = "200" ] || fail "The site at $URL did not answer for index.html ($status), so nothing was verified" \
  "This is a VERIFICATION failure if curl never answered, and a broken site if it did."
status="$(fetch sw.js "$tmp/sw.js")"
[ "$status" = "200" ] || fail "The service worker is missing from the site: sw.js answered $status" \
  "Without it no phone keeps a copy of the app, and nothing works with no signal."

# The module script and every modulepreload: what a phone downloads before
# its first screen, whichever route it opens. Vite writes one modulepreload
# for each chunk the entry imports statically.
first_screen="$(
  grep -oE '(src|href)="[^"]*assets/[^"]+\.js"' "$tmp/index.html" |
    sed -E 's/.*(assets\/[^"]+\.js).*/\1/' |
    sort -u
)"
entry="$(printf '%s\n' "$first_screen" | grep -E '^assets/index-[A-Za-z0-9_-]+\.js$' | head -n 1)"
[ -n "$entry" ] || fail "index.html at $URL has no entry script, so this is not the app" \
  "Expected a <script type=\"module\" src=\"…/assets/index-<hash>.js\">."

not_precached=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  grep -qF "$file" "$tmp/sw.js" || not_precached+=("$file")
done <<<"$first_screen"
if [ "${#not_precached[@]}" -gt 0 ]; then
  fail "A phone with no signal cannot start the app: index.html loads ${#not_precached[@]} file(s) the service worker never saves" \
    "The service worker's precache list (sw.js) does not name:" \
    "${not_precached[@]/#/  }" \
    "" \
    "Check globIgnores in app/vite.config.ts and which chunk the bundler put that" \
    "code in — see the codeSplitting note there for the 2026-09-25 case."
fi
first_screen_count="$(printf '%s\n' "$first_screen" | grep -c .)"

# --- 3. Can a phone on the previous build still start it? --------------------
kept_ok=()
kept_files=()
if [ -d "$KEPT_DIR" ]; then
  for path in "$KEPT_DIR"/*; do
    [ -f "$path" ] || continue
    kept_files+=("$path")
  done
fi
# `${arr[@]+"${arr[@]}"}`: an empty array is "unbound" to bash 3.2's `set -u`,
# which is the bash a Mac ships with.
for path in ${kept_files[@]+"${kept_files[@]}"}; do
  name="$(basename "$path")"
  status="$(fetch "assets/$name" "$tmp/kept")"
  if [ "$status" != "200" ]; then
    fail "Phones on the previous build cannot start the app: assets/$name answered $status on the site" \
      "Every build before the fix asked the network for that file (app/scripts/check-kept-assets.mjs)." \
      "A phone still on such a build shows a black screen and cannot update itself." \
      "Expected the bytes of $path to be served at ${URL}assets/$name."
  fi
  if [ "$(sha256_of "$tmp/kept")" != "$(sha256_of "$path")" ]; then
    fail "Phones on the previous build cannot start the app: assets/$name on the site is a different file" \
      "Its bytes do not match $path. A hashed filename promises specific content;" \
      "an old entry given something else fails to start."
  fi
  kept_ok+=("$name")
done

echo "site:  $URL"
echo "build: $live_build"
echo "A phone with no signal can start it: all $first_screen_count first-screen files are in the service worker's precache."
if [ "${#kept_ok[@]}" -gt 0 ]; then
  echo "A phone on the previous build can start it: ${kept_ok[@]+"${kept_ok[*]}"} served with the exact bytes."
else
  echo "No files are kept for previous builds in $KEPT_DIR, so there was nothing to check for them."
fi
exit 0
