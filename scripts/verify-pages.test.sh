#!/usr/bin/env bash
# Tests for scripts/verify-pages.sh.
#
# Every case stubs curl with a fake site in a temp directory, so nothing here
# needs the network or a deploy. The behaviours worth pinning down: a healthy
# deploy passes, each of the three ways a phone fails to start goes red with
# a first line a non-engineer can act on, and an answer the script could not
# get fails rather than passes — the same rule scripts/verify-functions.sh
# applies to an unanswered probe.
#
#   scripts/verify-pages.test.sh
#   scripts/verify-pages.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/verify-pages.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

# sha256sum on Linux, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# A site the shape a deploy leaves on Pages: index.html loading an entry and
# two modulepreloads, a service worker naming all three, version.json, and
# the one file old phones ask for. `kept/` is what the repo holds for them.
new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin" "$root/site/assets" "$root/kept"
  cat >"$root/site/index.html" <<'HTML'
<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-lCSYwAWP.js">
<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-aKtaBQYM.js">
<link rel="stylesheet" crossorigin href="/assets/index-pdOV5gfH.css">
</head><body><div id="root"></div></body></html>
HTML
  cat >"$root/site/sw.js" <<'JS'
precacheAndRoute([{url:"assets/index-Ab12Cd34.js",revision:null},{url:"assets/react-lCSYwAWP.js",revision:null},{url:"assets/rolldown-runtime-aKtaBQYM.js",revision:null},{url:"index.html",revision:"abc"}]);
JS
  printf '{"buildId":"deadbeef","builtAt":"2026-09-25T20:13:58.518Z"}' >"$root/site/version.json"
  printf 'import{t}from"./rolldown-runtime-aKtaBQYM.js";export{t};\n' >"$root/kept/monitoring-BsbA4Bc6.js"
  cp "$root/kept/monitoring-BsbA4Bc6.js" "$root/site/assets/monitoring-BsbA4Bc6.js"

  # The stub: serves `site/` by URL path, ignores the query string, prints the
  # status the way `-w '%{http_code}'` does, writes the body to `-o`.
  # STUB_DEAD=1 makes it fail like a connection that never answered.
  cat >"$root/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--max-time) shift 2 ;;
    -sS|-L|-s) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ "${STUB_DEAD:-0}" = "1" ]; then
  echo "curl: (6) Could not resolve host" >&2
  exit 6
fi
path="${url#*://*/}"
path="${path%%\?*}"
[ -z "$path" ] && path="index.html"
file="$STUB_SITE/$path"
if [ -f "$file" ]; then
  cp "$file" "$out"
  printf '200'
else
  printf '<html>404</html>' >"$out"
  printf '404'
fi
STUB
  chmod +x "$root/bin/curl"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    CURL_BIN="$root/bin/curl" \
    STUB_SITE="$root/site" \
    STUB_DEAD="${DEAD_OVERRIDE-0}" \
    PAGES_URL="${URL_OVERRIDE-https://example.test/}" \
    EXPECT_BUILD_ID="${EXPECT_OVERRIDE-deadbeef}" \
    KEPT_DIR="${KEPT_OVERRIDE-$root/kept}" \
    VERIFY_ATTEMPTS=2 VERIFY_RETRY_DELAY=0 \
    "$SCRIPT" 2>&1)"
  RC=$?
  [ "$VERBOSE" = 1 ] && printf '%s\n--- rc=%s\n%s\n' "$current" "$RC" "$OUT"
  return 0
}

pass() {
  passed=$((passed + 1))
  rm -rf "$root"
}

fail() {
  failed=$((failed + 1))
  echo "FAIL: $current — $1"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  rm -rf "$root"
}

expect_rc() {
  [ "$RC" = "$1" ] || { fail "expected exit $1, got $RC"; return 1; }
}

expect_contains() {
  case "$OUT" in
    *"$1"*) return 0 ;;
    *) fail "output should contain: $1"; return 1 ;;
  esac
}

expect_first_line() {
  local first
  first="$(printf '%s\n' "$OUT" | head -n 1)"
  case "$first" in
    *"$1"*) return 0 ;;
    *) fail "first line should lead with: $1 (was: $first)"; return 1 ;;
  esac
}

# --- cases ------------------------------------------------------------------

new_case "a healthy deploy passes and says what it checked"
run
expect_rc 0 && expect_contains "build: deadbeef" &&
  expect_contains "all 3 first-screen files are in the service worker's precache" &&
  expect_contains "monitoring-BsbA4Bc6.js served with the exact bytes" && pass

new_case "the previous build still live is not a pass"
EXPECT_OVERRIDE="0123456" run
unset EXPECT_OVERRIDE
expect_rc 1 && expect_first_line "The site still serves the previous build" &&
  expect_contains "live:     deadbeef" && expect_contains "expected: 0123456" && pass

new_case "with no expected build, question 1 only reads the build id out"
EXPECT_OVERRIDE="" run
unset EXPECT_OVERRIDE
expect_rc 0 && expect_contains "build: deadbeef" && pass

new_case "a first-screen chunk the worker never saves — the 2026-09-25 shape"
# React had landed in the crash monitor's chunk, which globIgnores keeps out
# of the precache; index.html modulepreloads it all the same.
sed -i.bak 's#<link rel="modulepreload" crossorigin href="/assets/react-lCSYwAWP.js">#<link rel="modulepreload" crossorigin href="/assets/monitoring-Xy98Zw76.js">#' "$root/site/index.html"
run
expect_rc 1 && expect_first_line "A phone with no signal cannot start the app: index.html loads 1 file(s) the service worker never saves" &&
  expect_contains "assets/monitoring-Xy98Zw76.js" && expect_contains "globIgnores" && pass

new_case "the file old phones ask for is gone from the site"
rm "$root/site/assets/monitoring-BsbA4Bc6.js"
run
expect_rc 1 && expect_first_line "Phones on the previous build cannot start the app: assets/monitoring-BsbA4Bc6.js answered 404" &&
  expect_contains "black screen" && pass

new_case "the file old phones ask for is a different file on the site"
printf 'something else\n' >"$root/site/assets/monitoring-BsbA4Bc6.js"
run
expect_rc 1 && expect_first_line "Phones on the previous build cannot start the app: assets/monitoring-BsbA4Bc6.js on the site is a different file" && pass

new_case "nothing kept for previous builds is not a failure"
rm -rf "$root/kept"
run
expect_rc 0 && expect_contains "No files are kept for previous builds" && pass

new_case "a site that never answers is a verification failure, not a pass"
DEAD_OVERRIDE=1 run
unset DEAD_OVERRIDE
expect_rc 1 && expect_first_line "Could not reach https://example.test/ to check the deploy, so nothing was verified" &&
  expect_contains "VERIFICATION failure" && pass

new_case "a site with no version.json is not the app"
rm "$root/site/version.json"
run
expect_rc 1 && expect_first_line "is not serving the app: version.json answered 404" && pass

new_case "index.html without an entry script is not the app"
printf '<html><body>Site not found</body></html>' >"$root/site/index.html"
run
expect_rc 1 && expect_first_line "has no entry script, so this is not the app" && pass

new_case "no PAGES_URL is refused, with the command to run"
URL_OVERRIDE="" run
unset URL_OVERRIDE
expect_rc 1 && expect_contains "PAGES_URL is not set" && expect_contains "scripts/verify-pages.sh" && pass

new_case "the real kept files in app/public/assets are what the script would look for"
# The stub site has to hold each of them for this to pass: the case pins that
# the repo's own kept directory is read, file by file.
for f in app/public/assets/*; do cp "$f" "$root/site/assets/$(basename "$f")"; done
KEPT_OVERRIDE="app/public/assets" run
unset KEPT_OVERRIDE
expect_rc 0 && expect_contains "$(basename "$(ls app/public/assets | head -n 1)") served with the exact bytes" && pass

# --- summary ----------------------------------------------------------------
echo "verify-pages.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
