#!/usr/bin/env bash
#
# sync.sh — safely sync this checkout to the latest master.
#
# master is our single source of truth. This script:
#   1. fetches from origin
#   2. refuses to run if you have uncommitted changes
#   3. checks out master and fast-forwards it to origin/master
#   4. reinstalls deps if package.json / package-lock.json changed
#   5. reminds you to restart Vite and hard-refresh the browser
#
# See SYNC.md for the full playbook.

set -euo pipefail

# --- pretty output helpers -------------------------------------------------
info()  { printf "\033[0;36m➜  %s\033[0m\n" "$1"; }
ok()    { printf "\033[0;32m✔  %s\033[0m\n" "$1"; }
warn()  { printf "\033[0;33m⚠  %s\033[0m\n" "$1"; }
error() { printf "\033[0;31m✖  %s\033[0m\n" "$1"; }

# --- locate the repo root (works no matter where you run this from) --------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
APP_DIR="$REPO_ROOT/app"

echo ""
info "Syncing to the latest master (source of truth)..."
echo ""

# --- 1. fetch --------------------------------------------------------------
info "Fetching latest from origin..."
git fetch origin
ok "Fetched."

# --- 2. block on uncommitted changes --------------------------------------
if ! git diff-index --quiet HEAD -- 2>/dev/null || [ -n "$(git status --porcelain)" ]; then
  echo ""
  error "You have uncommitted changes. Sync stopped to keep your work safe."
  echo ""
  warn "Do ONE of these, then run sync again:"
  echo "    • Commit them:   git add -A && git commit -m \"wip: my changes\""
  echo "    • Or stash them: git stash   (bring back later with: git stash pop)"
  echo ""
  exit 1
fi

# --- 3. remember where we were, then check out + fast-forward master -------
PREV_HEAD="$(git rev-parse HEAD)"

info "Checking out master..."
git checkout master

info "Pulling latest master (fast-forward only)..."
if ! git pull --ff-only origin master; then
  echo ""
  error "Could not fast-forward master. Your history has diverged from origin."
  echo ""
  warn "DO NOT force anything. Please STOP AND ASK for help."
  warn "See the 'git says my branch has diverged' section in SYNC.md."
  echo ""
  exit 1
fi
ok "master is up to date."

NEW_HEAD="$(git rev-parse HEAD)"

# --- 4. reinstall deps if they changed ------------------------------------
if [ "$PREV_HEAD" != "$NEW_HEAD" ] && \
   ! git diff --quiet "$PREV_HEAD" "$NEW_HEAD" -- app/package.json app/package-lock.json 2>/dev/null; then
  echo ""
  info "Dependencies changed — running npm install in app/ ..."
  ( cd "$APP_DIR" && npm install )
  ok "Dependencies installed."
else
  ok "Dependencies unchanged — skipping npm install."
fi

# --- 5. summary + reminders -----------------------------------------------
echo ""
ok "You are now synced. Current commit:"
echo ""
git log --oneline -1
echo ""
warn "Two things to finish up:"
echo "    1. Restart Vite:      cd app && npm run dev   (Ctrl+C first if it's running)"
echo "    2. Hard-refresh the browser:   Cmd/Ctrl + Shift + R"
echo "       (PWA cache can show an OLD design — see SYNC.md if it persists.)"
echo ""
