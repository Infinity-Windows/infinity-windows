#!/usr/bin/env bash
# Tests for scripts/backup-seal.sh. Offline: a throwaway passphrase, throwaway
# files. Run: scripts/backup-seal.test.sh
#
# What has to hold: a sealed archive opens back byte-identical with the right
# passphrase; EVERY wrong passphrase is refused and leaves nothing behind that
# looks like a backup; so is a file that was altered, or cut short; a file
# from before the seal check still opens, with a warning, and only when what
# comes out is a real archive; a missing passphrase is refused before anything
# is written; the passphrase never appears in the output.
#
# The wrong-passphrase cases run 300 different wrong passphrases each, on
# purpose. The first version of `open` was AES-CBC with nothing over it, and
# CBC's padding check passes a wrong key about one time in 256 — so one try
# went green 255 times in 256, and the one red build (master, 2026-09-23, run
# 35945380393) was the only thing that ever noticed. Against that version,
# 300 tries would have let one through about two times in three. Now none
# may, and the loop is what makes that a statement rather than a hope.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
seal="$PWD/scripts/backup-seal.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
# Every line the script prints during these tests, so one grep at the end can
# insist the passphrase is in none of it.
log="$tmp/all-output.txt"; : > "$log"
attempts=300

# Every one of $attempts different wrong passphrases must be refused with
# exit 4 and leave no file. Eight at a time: each try is a 600k-iteration
# key derivation, so one at a time this would be minutes of CI.
refuse_every_wrong_passphrase() {  # $1 label  $2 sealed file  $3 scratch dir name
  local label="$1" enc="$2" dir="$tmp/wrong-$3" i wrong_exit=0 left=0
  mkdir -p "$dir"
  for i in $(seq 1 "$attempts"); do
    (
      BACKUP_PASSPHRASE="not it $i" "$seal" open "$enc" "$dir/$i.tar.gz" >"$dir/$i.out" 2>&1
      echo $? >"$dir/$i.rc"
    ) &
    [ $((i % 8)) -eq 0 ] && wait
  done
  wait
  for i in $(seq 1 "$attempts"); do
    [ "$(cat "$dir/$i.rc")" = 4 ] || wrong_exit=$((wrong_exit+1))
    [ -e "$dir/$i.tar.gz" ] && left=$((left+1))
    cat "$dir/$i.out" >> "$log"
  done
  [ "$wrong_exit" -eq 0 ] && ok "$label: all $attempts wrong passphrases exit 4" \
    || bad "$label: $wrong_exit of $attempts wrong passphrases did not exit 4"
  [ "$left" -eq 0 ] && ok "$label: no wrong passphrase left a file behind" \
    || bad "$label: $left wrong passphrase(s) left a file behind"
}

head -c 30000 /dev/urandom > "$tmp/a.tar.gz"

out="$(BACKUP_PASSPHRASE= "$seal" seal "$tmp/a.tar.gz" "$tmp/a0.enc" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 3 ] && ok "missing passphrase exits 3" || bad "missing passphrase exited $rc"
[ ! -e "$tmp/a0.enc" ] && ok "missing passphrase writes nothing" || bad "missing passphrase wrote a file"

export BACKUP_PASSPHRASE='correct horse battery staple 2026'
out="$("$seal" seal "$tmp/a.tar.gz" "$tmp/a.enc" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 0 ] && ok "seal exits 0" || bad "seal exited $rc: $out"
case "$out" in *"$BACKUP_PASSPHRASE"*) bad "passphrase printed";; *) ok "passphrase not printed";; esac
cmp -s "$tmp/a.tar.gz" "$tmp/a.enc" && bad "sealed file equals plaintext" || ok "sealed file differs from the plaintext"
[ "$(head -c 20 "$tmp/a.enc")" = "FORGE BACKUP SEAL v1" ] && ok "a new seal starts with the seal header" || bad "a new seal does not start with the seal header"
[ ! -e "$tmp/a.enc.part" ] && ok "seal leaves no partial file behind" || bad "seal left its partial file behind"

out="$("$seal" open "$tmp/a.enc" "$tmp/back.tar.gz" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 0 ] && ok "open exits 0" || bad "open exited $rc: $out"
cmp -s "$tmp/a.tar.gz" "$tmp/back.tar.gz" && ok "archive round-trips byte for byte" || bad "archive differs after round trip"
case "$out" in *WARNING*) bad "a new-format file opened with a warning";; *) ok "a new-format file opens without a warning";; esac

# The command scripts/restore.md gives for a machine that has openssl and not
# this script. If the header ever changes size, this is the case that says so.
tail -c +70 "$tmp/a.enc" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -pass env:BACKUP_PASSPHRASE -out "$tmp/fallback.tar.gz" 2>/dev/null
cmp -s "$tmp/a.tar.gz" "$tmp/fallback.tar.gz" && ok "the documented fallback (tail -c +70 | openssl) opens it too" || bad "the documented fallback does not open it"

out="$(BACKUP_PASSPHRASE='wrong' "$seal" open "$tmp/a.enc" "$tmp/wrong.tar.gz" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 4 ] && ok "wrong passphrase exits 4" || bad "wrong passphrase exited $rc"
[ ! -e "$tmp/wrong.tar.gz" ] && ok "wrong passphrase leaves no file behind" || bad "wrong passphrase left a file"
case "$out" in *"wrong passphrase"*|*"Wrong passphrase"*) ok "wrong passphrase is told so in words";; *) bad "wrong passphrase message was: $out";; esac

refuse_every_wrong_passphrase "sealed file" "$tmp/a.enc" new

# Altered files. One byte, in each part of the file that could be altered:
# the payload, the seal itself, and the salt the seal key comes from.
flip_byte() {  # $1 file  $2 offset
  printf '\000' | dd of="$1" bs=1 seek="$2" count=1 conv=notrunc 2>/dev/null
  # A zero where there already was one changes nothing; make sure it changed.
  cmp -s "$1" "$tmp/a.enc" && printf '\377' | dd of="$1" bs=1 seek="$2" count=1 conv=notrunc 2>/dev/null
}
for spot in "payload 5000" "seal 40" "salt 25"; do
  what="${spot% *}"; at="${spot#* }"
  cp "$tmp/a.enc" "$tmp/altered-$what.enc"; flip_byte "$tmp/altered-$what.enc" "$at"
  out="$("$seal" open "$tmp/altered-$what.enc" "$tmp/altered-$what.tar.gz" 2>&1)"; rc=$?
  echo "$out" >> "$log"
  [ "$rc" -eq 4 ] && ok "a flipped byte in the $what exits 4" || bad "a flipped byte in the $what exited $rc: $out"
  [ ! -e "$tmp/altered-$what.tar.gz" ] && ok "a flipped byte in the $what leaves no file behind" || bad "a flipped byte in the $what left a file"
done

# Cut short, as a download that stopped would leave it: by a little, and to
# less than the header.
size="$(wc -c < "$tmp/a.enc" | tr -d ' ')"
head -c "$((size - 1))" "$tmp/a.enc" > "$tmp/short.enc"
head -c 30 "$tmp/a.enc" > "$tmp/stub.enc"
for name in short stub; do
  out="$("$seal" open "$tmp/$name.enc" "$tmp/$name.tar.gz" 2>&1)"; rc=$?
  echo "$out" >> "$log"
  [ "$rc" -eq 4 ] && ok "a truncated file ($name) exits 4" || bad "a truncated file ($name) exited $rc: $out"
  [ ! -e "$tmp/$name.tar.gz" ] && ok "a truncated file ($name) leaves no file behind" || bad "a truncated file ($name) left a file"
  case "$out" in *Traceback*) bad "a truncated file ($name) printed a traceback";; *) ;; esac
done

head -c 4000 /dev/urandom > "$tmp/junk.enc"
out="$("$seal" open "$tmp/junk.enc" "$tmp/junk.tar.gz" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 4 ] && ok "a file that is not a seal exits 4" || bad "a file that is not a seal exited $rc"
[ ! -e "$tmp/junk.tar.gz" ] && ok "a file that is not a seal leaves no file behind" || bad "a file that is not a seal left a file"
case "$out" in *"not a sealed backup"*) ok "a file that is not a seal is told so in words";; *) bad "not-a-seal message was: $out";; esac

# The old format: what the first version of the script wrote, and what is in
# the bucket from before the seal check. It has no seal, so it can only be
# trusted once what comes out is a real archive — a real one is built here,
# the shape scripts/backup_verify.py insists on.
python3 - "$tmp" <<'PY'
import hashlib, json, os, sys, tarfile
root = os.path.join(sys.argv[1], "2026-09-06T0910Z")
os.makedirs(root)
dumps = {"roles.sql": b"create role crew;\n", "schema.sql": b"create table projects (id uuid);\n" * 40,
         "data.sql": b"COPY projects FROM stdin;\n" + b"row\n" * 500}
for name, body in dumps.items():
    with open(os.path.join(root, name), "wb") as fh:
        fh.write(body)
with open(os.path.join(root, "MANIFEST.json"), "w") as fh:
    json.dump({"project_ref": "ref", "postgres_version": "15.1", "table_count": 1,
               "dumps": {n: {"bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in dumps.items()}}, fh)
with tarfile.open(os.path.join(sys.argv[1], "real.tar.gz"), "w:gz") as tar:
    tar.add(root, arcname=os.path.basename(root))
PY
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:BACKUP_PASSPHRASE -in "$tmp/real.tar.gz" -out "$tmp/legacy.enc"
[ "$(head -c 8 "$tmp/legacy.enc")" = "Salted__" ] && ok "an old-format file starts with openssl's Salted__ (the fixture is the real old format)" || bad "the old-format fixture is not what openssl writes"
out="$("$seal" open "$tmp/legacy.enc" "$tmp/legacy.tar.gz" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 0 ] && ok "an old-format file still opens" || bad "an old-format file exited $rc: $out"
cmp -s "$tmp/real.tar.gz" "$tmp/legacy.tar.gz" && ok "an old-format file round-trips byte for byte" || bad "an old-format file differs after opening"
case "$out" in *"WARNING"*"old format"*) ok "an old-format file opens with a warning";; *) bad "an old-format file opened without the warning: $out";; esac
case "$out" in *"cannot tell a wrong passphrase"*) ok "the warning says what the old format cannot do";; *) bad "the warning does not say what the old format cannot do";; esac

refuse_every_wrong_passphrase "old-format file" "$tmp/legacy.enc" legacy

# An old-format seal of something that is not an archive: the right passphrase
# opens it, and what comes out is refused anyway, because on the old format
# "it is an archive" is the only proof there is that the passphrase was right.
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:BACKUP_PASSPHRASE -in "$tmp/a.tar.gz" -out "$tmp/legacy-noise.enc"
out="$("$seal" open "$tmp/legacy-noise.enc" "$tmp/legacy-noise.tar.gz" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 4 ] && ok "an old-format file that is not an archive exits 4" || bad "an old-format file that is not an archive exited $rc"
[ ! -e "$tmp/legacy-noise.tar.gz" ] && ok "an old-format file that is not an archive leaves no file behind" || bad "an old-format file that is not an archive left a file"

: > "$tmp/empty.tar.gz"
out="$("$seal" seal "$tmp/empty.tar.gz" "$tmp/empty.enc" 2>&1)"; rc=$?
echo "$out" >> "$log"
[ "$rc" -eq 2 ] && ok "an empty archive is refused" || bad "empty archive exited $rc"

# Over everything every case printed: the right passphrase, and the shape of
# the wrong ones the loops used.
if grep -q -F "$BACKUP_PASSPHRASE" "$log"; then bad "the passphrase appears in the output"; else ok "the passphrase appears nowhere in the output"; fi
if grep -q -F "not it " "$log"; then bad "a wrong passphrase appears in the output"; else ok "no wrong passphrase appears in the output either"; fi

echo "backup-seal: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
