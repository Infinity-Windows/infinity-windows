#!/usr/bin/env bash
# Tests for scripts/checkpoint.sh. Entirely offline: "origin" is a local bare
# repository, so nothing here touches the network or needs a credential.
#
# The case that matters most is the third one. The first checkpoint taken by
# hand restored to the PREVIOUS commit, because a fetch moves the
# remote-tracking ref and leaves the local branch behind, and cloning a bundle
# checks out the local one. The backup verified clean and held yesterday's code.

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checkpoint="$script_dir/checkpoint.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# A bare repo standing in for GitHub, a working clone, and the script installed
# where it expects to live (it locates the repo from its own path).
git init --quiet --bare "$tmp/origin.git"
git init --quiet "$tmp/work"
cd "$tmp/work"
git config user.name "tester"
git config user.email "tester@example.com"
git remote add origin "$tmp/origin.git"
echo "one" >a.txt
git add a.txt
git commit --quiet -m "one"
git branch -M master
git push --quiet -u origin master
mkdir -p "$tmp/work/scripts"
cp "$checkpoint" "$tmp/work/scripts/checkpoint.sh"

run() { CHECKPOINT_DIR="$tmp/out" "$@" "$tmp/work/scripts/checkpoint.sh"; }

# 1. A plain run produces a bundle that restores to what origin has.
run env >/dev/null || fail "a clean run should succeed"
[ -f "$tmp/out/infinity-windows-$(date +%Y-%m-%d).bundle" ] ||
  fail "no bundle was written"
git clone --quiet --branch master "$tmp/out/infinity-windows-$(date +%Y-%m-%d).bundle" "$tmp/r1"
[ "$(git -C "$tmp/r1" rev-parse HEAD)" = "$(git -C "$tmp/work" rev-parse master)" ] ||
  fail "the restored tip is not the tip that was checkpointed"

# 2. Everything is in there, not just the default branch.
git -C "$tmp/work" branch --quiet side
git -C "$tmp/work" push --quiet origin side
CHECKPOINT_STAMP=t2 run env >/dev/null
git -C "$tmp/r1" bundle list-heads "$tmp/out/infinity-windows-t2.bundle" 2>/dev/null |
  grep -q "refs/heads/side" || fail "a second branch did not make it into the bundle"

# 3. THE ONE. A local default branch left behind by a fetch must be caught and
#    fast-forwarded, so the bundle holds what the server holds.
git -C "$tmp/work" checkout --quiet side
echo "two" >"$tmp/work/b.txt"
git -C "$tmp/work" add b.txt
git -C "$tmp/work" commit --quiet -m "two"
# Land it on origin's master without moving the local master — exactly what a
# squash-merge on GitHub does to a working copy that only ever fetches.
git -C "$tmp/work" push --quiet origin side:master
git -C "$tmp/work" fetch --quiet origin
[ "$(git -C "$tmp/work" rev-parse master)" != "$(git -C "$tmp/work" rev-parse origin/master)" ] ||
  fail "the test failed to set up a stale local master"

CHECKPOINT_STAMP=t3 run env >/dev/null || fail "a run with a stale master should still succeed"
git clone --quiet --branch master "$tmp/out/infinity-windows-t3.bundle" "$tmp/r3"
[ "$(git -C "$tmp/r3" rev-parse HEAD)" = "$(git -C "$tmp/work" rev-parse origin/master)" ] ||
  fail "the bundle restored a stale master — this is the bug the script exists to prevent"

# 4. A local branch that has genuinely diverged is a person's problem. Say so,
#    keep the checkpoint, do not rewrite anybody's work.
git -C "$tmp/work" checkout --quiet master
echo "local only" >"$tmp/work/c.txt"
git -C "$tmp/work" add c.txt
git -C "$tmp/work" commit --quiet -m "local only"
out=$(CHECKPOINT_STAMP=t4 CHECKPOINT_DIR="$tmp/out" "$tmp/work/scripts/checkpoint.sh" 2>&1) && diverged_ok=1 || diverged_ok=0
[ "$diverged_ok" = "0" ] || fail "a diverged master should stop the run rather than pass quietly"
echo "$out" | grep -q "commits origin does not" ||
  fail "a diverged master should say so in plain words"

# 5. Old bundles are pruned so this can run after every merge without filling
#    the disk. 46 MB each adds up fast.
git -C "$tmp/work" reset --quiet --hard origin/master
for n in 1 2 3 4 5 6 7; do
  CHECKPOINT_STAMP="p$n" CHECKPOINT_KEEP=3 CHECKPOINT_DIR="$tmp/out2" \
    "$tmp/work/scripts/checkpoint.sh" >/dev/null
done
count=$(ls -1 "$tmp/out2"/infinity-windows-*.bundle | wc -l | tr -d ' ')
[ "$count" = "3" ] || fail "expected 3 bundles kept, found $count"

echo "PASS: checkpoint.sh"
