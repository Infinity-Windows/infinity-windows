#!/usr/bin/env bash
# Tests for scripts/backup-seal.sh. Offline; a throwaway passphrase and
# throwaway files. Run: scripts/backup-seal.test.sh
#
# What has to hold: a sealed directory opens back to byte-identical files with
# the right passphrase; the wrong passphrase is refused rather than producing
# garbage that looks like a backup; a missing passphrase is refused before
# anything is written; and the passphrase never appears in the output.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
seal="$here/backup-seal.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

mkdir -p "$tmp/plain"
printf '{"manifest":true}\n' > "$tmp/plain/manifest.json"
head -c 20000 /dev/urandom > "$tmp/plain/2026-09-06T0920Z-ref-full.json.gz"

# 1. no passphrase: refused, nothing written
out="$(BACKUP_PASSPHRASE= "$seal" seal "$tmp/plain" "$tmp/sealed0" 2>&1)"; rc=$?
[ "$rc" -eq 3 ] && bad_or_ok=ok || bad_or_ok=bad
$bad_or_ok "missing passphrase exits 3 (got $rc)"
[ -z "$(ls -A "$tmp/sealed0" 2>/dev/null)" ] && ok "missing passphrase writes nothing" || bad "missing passphrase wrote files"

# 2. seal, then open with the right passphrase: byte-identical
export BACKUP_PASSPHRASE='correct horse battery staple 2026'
out="$("$seal" seal "$tmp/plain" "$tmp/sealed" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "seal exits 0" || bad "seal exited $rc: $out"
[ -f "$tmp/sealed/manifest.json.enc" ] && ok "sealed file is named <name>.enc" || bad "no .enc file"
case "$out" in *"$BACKUP_PASSPHRASE"*) bad "passphrase printed";; *) ok "passphrase not printed";; esac
if grep -q '"manifest":true' "$tmp/sealed/manifest.json.enc"; then bad "sealed file still holds plaintext"; else ok "sealed file is not plaintext"; fi

out="$("$seal" open "$tmp/sealed" "$tmp/opened" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "open exits 0" || bad "open exited $rc: $out"
cmp -s "$tmp/plain/manifest.json" "$tmp/opened/manifest.json" && ok "manifest round-trips byte for byte" || bad "manifest differs after round trip"
cmp -s "$tmp/plain/2026-09-06T0920Z-ref-full.json.gz" "$tmp/opened/2026-09-06T0920Z-ref-full.json.gz" && ok "snapshot round-trips byte for byte" || bad "snapshot differs after round trip"

# 3. wrong passphrase: refused, partial output removed
out="$(BACKUP_PASSPHRASE='wrong' "$seal" open "$tmp/sealed" "$tmp/opened-wrong" 2>&1)"; rc=$?
[ "$rc" -eq 4 ] && ok "wrong passphrase exits 4 (got $rc)" || bad "wrong passphrase exited $rc"
[ -z "$(ls -A "$tmp/opened-wrong" 2>/dev/null)" ] && ok "wrong passphrase leaves no file behind" || bad "wrong passphrase left files: $(ls "$tmp/opened-wrong")"

# 4. empty source: refused
mkdir -p "$tmp/empty"
"$seal" seal "$tmp/empty" "$tmp/sealed-empty" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 5 ] && ok "empty directory exits 5 (got $rc)" || bad "empty directory exited $rc"

echo "backup-seal: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
