#!/usr/bin/env bash
# Publish the generated vault/ directory to its own branch.
#
# Why not straight onto master: this repo's rules require every change to master
# to arrive as a reviewed pull request, and a nightly bot cannot satisfy that on
# its own — a pull request opened with the default Actions token does not trigger
# the required status checks, so it could never merge. Pushing to master is also
# exactly what .cursor/rules/agent-handles-prs.mdc forbids.
#
# So the generated wiki gets its own branch, which carries the vault and nothing
# else. History stays linear and no force-push is ever needed. Nothing the app
# serves reads these files — they exist for Obsidian.
#
# Usage: scripts/publish-vault.sh
#   VAULT_BRANCH  branch to publish to (default: vault-mirror)
#   GIT_REMOTE    remote to push to    (default: origin)

set -euo pipefail

BRANCH="${VAULT_BRANCH:-vault-mirror}"
REMOTE="${GIT_REMOTE:-origin}"

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [ ! -d vault ]; then
  echo "No vault/ directory to publish — has the sync run?" >&2
  exit 1
fi

worktree=$(mktemp -d)
# mktemp -d creates the directory; git worktree add insists on making it itself.
rmdir "$worktree"

cleanup() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"
}
trap cleanup EXIT

if git fetch --quiet "$REMOTE" "$BRANCH" 2>/dev/null; then
  # The branch already exists: build on top of it so history stays linear.
  git worktree add --quiet "$worktree" -B "$BRANCH" FETCH_HEAD
else
  # First run: start a branch with no history, so it carries only the vault
  # rather than a frozen copy of the whole repository.
  git worktree add --quiet --detach "$worktree" HEAD
  git -C "$worktree" checkout --quiet --orphan "$BRANCH"
  git -C "$worktree" reset --quiet
fi

# The database is the system of truth, so the branch mirrors what was just
# generated: replace the directory wholesale rather than merging into it.
rm -rf "$worktree/vault"
cp -R vault "$worktree/vault"

git -C "$worktree" add --all vault
if git -C "$worktree" diff --cached --quiet; then
  echo "No vault changes to publish."
  exit 0
fi

git -C "$worktree" \
  -c user.name="vault-sync[bot]" \
  -c user.email="vault-sync@users.noreply.github.com" \
  commit --quiet -m "chore(vault): sync install brain from Supabase"

# A plain push is enough: this branch only ever moves forward, and only this job
# writes to it.
if ! git -C "$worktree" push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH"; then
  echo "::error::Could not publish the vault to $BRANCH." >&2
  exit 1
fi

echo "Published the vault to $BRANCH."
