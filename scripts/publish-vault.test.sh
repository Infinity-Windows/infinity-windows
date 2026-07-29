#!/usr/bin/env bash
# Tests for scripts/publish-vault.sh. Entirely offline: "origin" is a local bare
# repository, so nothing here touches the network or needs a credential.

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
publish="$script_dir/publish-vault.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# A bare repo standing in for GitHub, plus a working clone.
git init --quiet --bare "$tmp/origin.git"
git init --quiet "$tmp/work"
cd "$tmp/work"
git remote add origin "$tmp/origin.git"
git config user.name "tester"
git config user.email "tester@example.com"
mkdir -p app
echo "code" >app/main.txt
git add app/main.txt
git commit --quiet -m "initial"
git push --quiet -u origin HEAD:refs/heads/master

export VAULT_BRANCH="vault-test"

# --- refuses to run when there is nothing generated --------------------------

if "$publish" >/dev/null 2>&1; then
  fail "should refuse to publish when vault/ does not exist"
fi

# --- first run creates the branch with only the vault on it ------------------

mkdir -p vault/windows/SL-100
echo "# profile" >vault/windows/SL-100/_profile.md
out=$("$publish")
grep -q "Published the vault to vault-test" <<<"$out" ||
  fail "first run should report publishing (got: $out)"

files=$(git ls-tree -r --name-only "origin/$VAULT_BRANCH" | sort | tr '\n' ' ')
[ "$files" = "vault/windows/SL-100/_profile.md " ] ||
  fail "branch should hold only the vault, got: $files"

# The branch must not drag the rest of the repository along with it.
if git ls-tree -r --name-only "origin/$VAULT_BRANCH" | grep -q "app/main.txt"; then
  fail "branch should not contain application code"
fi

# It is a fresh history, not a branch off master.
[ "$(git rev-list --count "origin/$VAULT_BRANCH")" = "1" ] ||
  fail "branch should start with a single commit"

# --- an unchanged vault produces no new commit -------------------------------

before=$(git rev-parse "origin/$VAULT_BRANCH")
out=$("$publish")
grep -q "No vault changes to publish" <<<"$out" ||
  fail "unchanged vault should be a no-op (got: $out)"
git fetch --quiet origin "$VAULT_BRANCH"
[ "$(git rev-parse FETCH_HEAD)" = "$before" ] ||
  fail "unchanged vault should not move the branch"

# --- a changed vault appends a commit, fast-forward, no force needed ---------

echo "# profile v2" >vault/windows/SL-100/_profile.md
mkdir -p vault/synthesized
echo "# tips" >vault/synthesized/tips.md
out=$("$publish")
grep -q "Published the vault to vault-test" <<<"$out" ||
  fail "changed vault should publish (got: $out)"

git fetch --quiet origin "$VAULT_BRANCH"
[ "$(git rev-list --count FETCH_HEAD)" = "2" ] ||
  fail "second publish should append exactly one commit"
# The new commit must sit on top of the old one, i.e. no history rewrite.
git merge-base --is-ancestor "$before" FETCH_HEAD ||
  fail "history was rewritten; the branch must only move forward"

git show "FETCH_HEAD:vault/windows/SL-100/_profile.md" | grep -q "v2" ||
  fail "published content should be the regenerated file"
git show "FETCH_HEAD:vault/synthesized/tips.md" >/dev/null ||
  fail "newly added vault files should be published"

# --- files removed from the database disappear from the mirror ---------------

rm vault/synthesized/tips.md
"$publish" >/dev/null
git fetch --quiet origin "$VAULT_BRANCH"
if git ls-tree -r --name-only FETCH_HEAD | grep -q "tips.md"; then
  fail "the mirror should drop files the generator no longer produces"
fi

# --- the commit is attributed to the bot, not to whoever ran it -------------

author=$(git log -1 --format='%an <%ae>' FETCH_HEAD)
[ "$author" = "vault-sync[bot] <vault-sync@users.noreply.github.com>" ] ||
  fail "commit should be attributed to the bot, got: $author"

# --- master is never touched -------------------------------------------------

git fetch --quiet origin master
[ "$(git rev-list --count FETCH_HEAD)" = "1" ] ||
  fail "master must be left exactly as it was"

echo "scripts/publish-vault.sh: all assertions passed"
