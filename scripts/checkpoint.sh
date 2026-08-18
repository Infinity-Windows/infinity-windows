#!/usr/bin/env bash
# Take a verified local checkpoint of this repository.
#
# One file, all history, restore-tested before it is trusted. Run it after work
# lands on master (owner's call, 2026-08-18).
#
# Why a bundle and not a folder copy: a bundle is a single self-contained file
# that `git clone` can restore from directly, and `git bundle verify` will say
# out loud whether the history inside it is complete. A copied folder tells you
# nothing about whether it is intact until the day you need it.
#
# Why it fast-forwards master first: the first checkpoint taken by hand restored
# to the PREVIOUS commit, because the local `master` branch was behind
# `origin/master` — a fetch updates the remote-tracking ref and leaves the local
# branch where it was, and `git clone <bundle>` checks out the local one. The
# backup looked fine and would have handed back yesterday's code.
#
#   scripts/checkpoint.sh                 -> ~/Downloads/infinity-windows-checkpoints
#   CHECKPOINT_DIR=/Volumes/usb scripts/checkpoint.sh
#
# Keeps the newest KEEP bundles and deletes older ones, so this can run often
# without filling the disk.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out="${CHECKPOINT_DIR:-$HOME/Downloads/infinity-windows-checkpoints}"
keep="${CHECKPOINT_KEEP:-5}"
stamp="${CHECKPOINT_STAMP:-$(date +%Y-%m-%d)}"
bundle="$out/infinity-windows-$stamp.bundle"

cd "$repo"
mkdir -p "$out"

echo "==> fetching"
git fetch --quiet --prune origin

# Fast-forward the local branch to match the remote. Only ever a
# fast-forward: if they have diverged, that is a real situation a person needs
# to look at, not something a backup script should paper over.
# `|| true` on both halves: under `set -e -o pipefail` a repo with no
# origin/HEAD ref (a fresh `git init` + `git remote add`, and some clones) makes
# this pipeline exit non-zero and kills the script before the fallback below can
# do its job.
default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
default="${default:-master}"
if git rev-parse --verify --quiet "refs/heads/$default" >/dev/null; then
  if [ "$(git rev-parse "$default")" != "$(git rev-parse "origin/$default")" ]; then
    if git merge-base --is-ancestor "$default" "origin/$default"; then
      echo "==> fast-forwarding $default to origin/$default"
      git fetch --quiet origin "$default:$default"
    else
      echo "!! local $default has commits origin does not — not touching it." >&2
      echo "   The checkpoint still captures both; sort the divergence out by hand." >&2
    fi
  fi
fi

echo "==> writing $bundle"
# refs/stash only when there IS one: naming a ref that does not resolve makes
# `git bundle create` fail outright, and a repo with an empty stash is the
# normal case, not an error.
stash_ref=()
git rev-parse --verify --quiet refs/stash >/dev/null && stash_ref=(refs/stash)
git bundle create "$bundle" --all "${stash_ref[@]+"${stash_ref[@]}"}" >/dev/null 2>&1
git bundle verify "$bundle" >/dev/null 2>&1 || { echo "!! bundle failed verification" >&2; git bundle verify "$bundle" >&2 || true; exit 1; }

# The part that makes this a checkpoint rather than a file: restore it, and
# check what comes back out is what is on the server.
echo "==> restore test"
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
git clone --quiet --branch "$default" "$bundle" "$probe/restored"
restored=$(git -C "$probe/restored" rev-parse HEAD)
expected=$(git rev-parse "origin/$default")
if [ "$restored" != "$expected" ]; then
  echo "!! restored $default is $restored, origin/$default is $expected" >&2
  echo "   The checkpoint does NOT hold what is on the server. Not usable." >&2
  exit 1
fi

# Newest first, delete everything past the newest $keep. A while-read loop and
# not `mapfile`, which macOS's bash 3.2 does not have — this has to run on the
# machine it is protecting.
{ ls -1t "$out"/infinity-windows-*.bundle 2>/dev/null || true; } | tail -n +$((keep + 1)) |
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "==> pruning $(basename "$f")"
    rm -f "$f"
  done

echo "OK  $bundle"
echo "    $default $restored — matches origin"
echo "    $(git rev-list --all --count) commits, $(du -h "$bundle" | cut -f1)"
