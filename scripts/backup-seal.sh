#!/usr/bin/env bash
# Seal a backup directory before it leaves the runner, and open one again.
#
#   scripts/backup-seal.sh seal <plain-dir> <sealed-dir>
#   scripts/backup-seal.sh open <sealed-dir> <plain-dir>
#
# WHY THIS EXISTS. This repository is public, and on a public repository a
# workflow artifact can be downloaded by anyone with a GitHub login. A backup
# holds every crew email and phone number and every job in the business, so it
# must not be uploaded as it is. Each file is encrypted with a passphrase held
# only in the BACKUP_PASSPHRASE repository secret (and, per
# docs/restore-from-backup.md, in the owner's password manager — a passphrase
# that lives only in GitHub is lost with the GitHub account, and then so is
# every backup).
#
# AES-256-CBC with PBKDF2, via openssl, which is on every GitHub runner and
# every Mac. No other tool is needed to open a backup on the worst day.
#
# The passphrase is read from the environment, never from an argument, so it
# cannot appear in a process listing or a shell history. Nothing here prints
# it.
set -euo pipefail

mode="${1:-}"
src="${2:-}"
dst="${3:-}"

if [ -z "$mode" ] || [ -z "$src" ] || [ -z "$dst" ]; then
  echo "usage: $0 seal|open <src-dir> <dst-dir>" >&2
  exit 2
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "BACKUP_PASSPHRASE is not set. Add it as a repository secret (and keep a copy in the password manager)." >&2
  exit 3
fi
if [ ! -d "$src" ]; then
  echo "$src is not a directory" >&2
  exit 2
fi
mkdir -p "$dst"

count=0
case "$mode" in
  seal)
    for f in "$src"/*; do
      [ -f "$f" ] || continue
      openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
        -pass env:BACKUP_PASSPHRASE -in "$f" -out "$dst/$(basename "$f").enc"
      count=$((count + 1))
    done
    ;;
  open)
    for f in "$src"/*.enc; do
      [ -f "$f" ] || continue
      name="$(basename "$f" .enc)"
      if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
        -pass env:BACKUP_PASSPHRASE -in "$f" -out "$dst/$name" 2>/dev/null; then
        rm -f "$dst/$name"
        echo "could not open $f: wrong passphrase or damaged file" >&2
        exit 4
      fi
      count=$((count + 1))
    done
    ;;
  *)
    echo "unknown mode $mode (seal or open)" >&2
    exit 2
    ;;
esac

if [ "$count" -eq 0 ]; then
  echo "nothing to $mode in $src" >&2
  exit 5
fi
echo "$mode: $count file(s) -> $dst"
