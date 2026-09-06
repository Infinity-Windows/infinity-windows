#!/usr/bin/env bash
# Tests for scripts/backup-seal.sh. Offline: a throwaway passphrase, throwaway
# files. Run: scripts/backup-seal.test.sh
#
# What has to hold: a sealed archive opens back byte-identical with the right
# passphrase; the wrong passphrase is refused and leaves nothing behind that
# looks like a backup; a missing passphrase is refused before anything is
# written; the passphrase never appears in the output.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
seal="$PWD/scripts/backup-seal.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

head -c 30000 /dev/urandom > "$tmp/a.tar.gz"

out="$(BACKUP_PASSPHRASE= "$seal" seal "$tmp/a.tar.gz" "$tmp/a0.enc" 2>&1)"; rc=$?
[ "$rc" -eq 3 ] && ok "missing passphrase exits 3" || bad "missing passphrase exited $rc"
[ ! -e "$tmp/a0.enc" ] && ok "missing passphrase writes nothing" || bad "missing passphrase wrote a file"

export BACKUP_PASSPHRASE='correct horse battery staple 2026'
out="$("$seal" seal "$tmp/a.tar.gz" "$tmp/a.enc" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "seal exits 0" || bad "seal exited $rc: $out"
case "$out" in *"$BACKUP_PASSPHRASE"*) bad "passphrase printed";; *) ok "passphrase not printed";; esac
cmp -s "$tmp/a.tar.gz" "$tmp/a.enc" && bad "sealed file equals plaintext" || ok "sealed file differs from the plaintext"

out="$("$seal" open "$tmp/a.enc" "$tmp/back.tar.gz" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "open exits 0" || bad "open exited $rc: $out"
cmp -s "$tmp/a.tar.gz" "$tmp/back.tar.gz" && ok "archive round-trips byte for byte" || bad "archive differs after round trip"

out="$(BACKUP_PASSPHRASE='wrong' "$seal" open "$tmp/a.enc" "$tmp/wrong.tar.gz" 2>&1)"; rc=$?
[ "$rc" -eq 4 ] && ok "wrong passphrase exits 4" || bad "wrong passphrase exited $rc"
[ ! -e "$tmp/wrong.tar.gz" ] && ok "wrong passphrase leaves no file behind" || bad "wrong passphrase left a file"

: > "$tmp/empty.tar.gz"
"$seal" seal "$tmp/empty.tar.gz" "$tmp/empty.enc" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "an empty archive is refused" || bad "empty archive exited $rc"

echo "backup-seal: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
