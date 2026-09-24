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
# every GitHub runner and every Mac. The passphrase is read from the
# environment, never from an argument, so it cannot appear in a process
# listing; nothing here prints it.
#
# WHY THE SEAL CHECK. AES-CBC on its own cannot tell a wrong passphrase from
# the right one. The only thing `openssl enc -d` checks is the padding on the
# last block, and a wrong key passes that about one time in 256 — so the
# first version of `open` exited 0 and wrote a file full of noise on roughly
# one wrong try in 256. CI caught it on master on 2026-09-23 (run
# 35945380393): "wrong passphrase exited 0". A restore that "succeeds" with
# noise is worse than one that fails, because nobody goes looking for the
# previous night's copy.
#
# So every file sealed here now carries a seal: an HMAC-SHA256 over the whole
# encrypted payload, keyed from the passphrase through PBKDF2 with a salt of
# its own. `open` checks the seal BEFORE decrypting a byte, so a wrong
# passphrase, a flipped bit and a download that stopped short all fail the
# same way, in words, with nothing written. Encrypt-then-MAC is the textbook
# construction. The alternative — a hash of the plaintext tucked inside the
# encrypted payload — could only be checked after decrypting the whole file,
# would leave 2 GiB of output to delete on failure, and would not be a
# construction anyone else has reviewed.
#
# The layout, so a person can read it back with nothing but `head` and `tail`:
#
#   FORGE BACKUP SEAL v1\n  21 bytes   the header; `head -c 21 file` shows it
#   salt                    16 bytes   for the seal key (PBKDF2-HMAC-SHA256)
#   seal                    32 bytes   HMAC-SHA256 over every other byte
#   payload                 the rest   exactly what `openssl enc` wrote
#
# The payload is the one thing the first version wrote, unchanged, which is
# what keeps the old files openable: a file that starts with openssl's own
# `Salted__` instead of the header is from before the seal check. `open`
# still opens it, says so, and then checks the result the only way an old
# file can be checked — it has to be a real gzip and a real backup archive
# (scripts/backup_verify.py) — because on the old format that is the only
# thing standing between a wrong passphrase and an exit 0. Every new seal
# gets the header. Once the bucket's 30-day rule has expired the last
# `Salted__` file, the old-format branch is dead code and can go.
#
# The seal itself — binary I/O, PBKDF2 and a constant-time compare — is
# python3's standard library, which every runner and every Mac has and which
# already checks the archive (backup_verify.py). openssl's own `kdf` command
# would do the derivation, but only on OpenSSL 3; a Mac's stock openssl is
# LibreSSL, and a derived key on an openssl command line would be visible in
# `ps` — the exact thing reading the passphrase from the environment avoids.
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
here="$(cd "$(dirname "$0")" && pwd)"

# The payload starts at byte 70 (1-based: 21 + 16 + 32 bytes of header come
# first). Pinned by the test's "fallback command" case, because
# scripts/restore.md quotes `tail -c +70` as the way to open a file on a
# machine that has openssl and not this script.
payload_from=70

# seal_tool header        -> writes a fresh header (magic, salt, zeroed seal)
# seal_tool sign  <file>  -> computes the seal over the file and writes it in
# seal_tool verify <file> -> exit 0 sealed and intact; 1 sealed but the seal
#                            does not match (wrong passphrase, or altered);
#                            10 old format (openssl's Salted__); 11 neither
seal_tool() {
  python3 - "$@" <<'PY'
import hashlib
import hmac
import os
import sys

MAGIC = b"FORGE BACKUP SEAL v1\n"
SALT_LEN, SEAL_LEN, ITERATIONS = 16, 32, 600000
SEAL_AT = len(MAGIC) + SALT_LEN          # 37
PAYLOAD_AT = SEAL_AT + SEAL_LEN          # 69
LEGACY = b"Salted__"                     # what `openssl enc -salt` writes first


def seal_key(salt: bytes) -> bytes:
    # Bytes, not str: the passphrase must hash to what openssl saw, and
    # os.environb hands back exactly the bytes that were set.
    passphrase = os.environb.get(b"BACKUP_PASSPHRASE", b"")
    return hashlib.pbkdf2_hmac("sha256", passphrase, salt, ITERATIONS, dklen=32)


def seal_of(fh, salt: bytes) -> bytes:
    """HMAC over the header without its seal field, then the whole payload."""
    mac = hmac.new(seal_key(salt), MAGIC + salt, "sha256")
    fh.seek(PAYLOAD_AT)
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        mac.update(chunk)
    return mac.digest()


mode = sys.argv[1]
if mode == "header":
    sys.stdout.buffer.write(MAGIC + os.urandom(SALT_LEN) + bytes(SEAL_LEN))
elif mode == "sign":
    with open(sys.argv[2], "r+b") as fh:
        head = fh.read(PAYLOAD_AT)
        if not head.startswith(MAGIC) or head[SEAL_AT:PAYLOAD_AT] != bytes(SEAL_LEN):
            sys.exit(f"{sys.argv[2]}: not a fresh header, refusing to seal it")
        seal = seal_of(fh, head[len(MAGIC):SEAL_AT])
        fh.seek(SEAL_AT)
        fh.write(seal)
elif mode == "verify":
    with open(sys.argv[2], "rb") as fh:
        head = fh.read(PAYLOAD_AT)
        if head.startswith(LEGACY):
            sys.exit(10)
        if not head.startswith(MAGIC):
            sys.exit(11)
        if len(head) < PAYLOAD_AT:
            sys.exit(1)
        expected = seal_of(fh, head[len(MAGIC):SEAL_AT])
    sys.exit(0 if hmac.compare_digest(expected, head[SEAL_AT:PAYLOAD_AT]) else 1)
else:
    sys.exit(f"unknown seal_tool mode {mode}")
PY
}

refuse() {  # $1: why. Nothing that looks like a backup may be left behind.
  rm -f "$dst"
  echo "could not open $src: $1" >&2
  exit 4
}

case "$mode" in
  seal)
    # Header first, payload appended, seal written into the header last —
    # the seal covers the payload, and this way the payload is written once
    # rather than copied into place behind a finished header, on a runner
    # that is already holding the unpacked dump, the archive and the seal.
    tmp="$dst.part"
    trap 'rm -f "$tmp"' EXIT
    seal_tool header > "$tmp"
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
      -pass env:BACKUP_PASSPHRASE -in "$src" >> "$tmp"
    seal_tool sign "$tmp"
    mv "$tmp" "$dst"
    ;;
  open)
    if seal_tool verify "$src"; then kind=0; else kind=$?; fi
    case "$kind" in
      0)
        tail -c "+$payload_from" "$src" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
          -pass env:BACKUP_PASSPHRASE -out "$dst" \
          || refuse "the seal checked out but openssl could not decrypt the payload"
        ;;
      1)
        refuse "the seal does not match. Wrong passphrase, or the file has been damaged or altered since it was sealed. Try the previous night's file."
        ;;
      10)
        echo "WARNING: $src was sealed in the old format, from before the seal check. The old format cannot tell a wrong passphrase from the right one, so what comes out is checked for being a real backup archive instead." >&2
        [ -f "$here/backup_verify.py" ] \
          || refuse "an old-format file can only be trusted after scripts/backup_verify.py has checked it, and that script is not beside this one. Run this from a full checkout of the repository."
        openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
          -pass env:BACKUP_PASSPHRASE -in "$src" -out "$dst" 2>/dev/null \
          || refuse "wrong passphrase or damaged file"
        # A wrong passphrase that slipped past the padding check yields noise,
        # and noise is not a gzip: this is the cheap check. The archive check
        # after it is the full one, the same one the workflows run next.
        gzip -t "$dst" 2>/dev/null \
          || refuse "what came out is not a backup archive: wrong passphrase, or a damaged file. Try the previous night's file."
        python3 "$here/backup_verify.py" "$dst" \
          || refuse "what came out is not the backup archive its manifest describes: wrong passphrase, or a damaged file. Try the previous night's file."
        ;;
      *)
        refuse "not a sealed backup (it starts with neither the seal header nor openssl's Salted__)"
        ;;
    esac
    ;;
  *)
    echo "unknown mode $mode (seal or open)" >&2
    exit 2
    ;;
esac
echo "$mode: $(wc -c < "$src" | tr -d ' ') bytes -> $dst"
