#!/usr/bin/env bash
# Seal a backup archive before it leaves the runner, and open one again.
#
#   scripts/backup-seal.sh seal <archive.tar.gz> <archive.tar.gz.enc>
#   scripts/backup-seal.sh open <archive.tar.gz.enc> <archive.tar.gz>
#
# WHY. The archive holds every crew member's hours, every builder's plans, and
# auth.users with its password hashes. It goes to a private B2 bucket, which
# is the right place, and it is still one leaked application key away from
# being public. Sealed, it is a file nobody can read without the passphrase
# held in the BACKUP_PASSPHRASE repository secret — and, per docs/backups.md,
# in the owner's password manager, because a passphrase that lives only in
# GitHub is lost with the GitHub account and every backup with it.
#
# AES-256-CBC with PBKDF2 (600k iterations, salted), via openssl, which is on
# every GitHub runner and every Mac. Nothing else is needed to open a backup
# on the worst day. The passphrase is read from the environment, never from
# an argument, so it cannot appear in a process listing; nothing here prints it.
set -euo pipefail

mode="${1:-}"; src="${2:-}"; dst="${3:-}"
if [ -z "$mode" ] || [ -z "$src" ] || [ -z "$dst" ]; then
  echo "usage: $0 seal|open <src-file> <dst-file>" >&2
  exit 2
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "BACKUP_PASSPHRASE is not set. Add it as a repository secret (and keep a copy in the password manager)." >&2
  exit 3
fi
if [ ! -s "$src" ]; then
  echo "$src is missing or empty" >&2
  exit 2
fi

case "$mode" in
  seal)
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
      -pass env:BACKUP_PASSPHRASE -in "$src" -out "$dst"
    ;;
  open)
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
      -pass env:BACKUP_PASSPHRASE -in "$src" -out "$dst" 2>/dev/null; then
      rm -f "$dst"
      echo "could not open $src: wrong passphrase or damaged file" >&2
      exit 4
    fi
    ;;
  *)
    echo "unknown mode $mode (seal or open)" >&2
    exit 2
    ;;
esac
echo "$mode: $(wc -c < "$src" | tr -d ' ') bytes -> $dst"
