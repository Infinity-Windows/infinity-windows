# Split a Postgres migration into statements, so a rule can ask a question
# about one CREATE TABLE without a regex tripping over the file around it.
#
# WHY THIS IS NOT `tr ';' '\n'`. Three things in these migrations contain a
# semicolon that does not end a statement:
#
#   * a function body between `$$` (or `$function$`) markers — every RPC here
#     has one, and they are full of `;`
#   * a `comment on ... is '...'` string, which in this repo runs to whole
#     paragraphs of prose with punctuation in it
#   * a `--` comment, which is where most of this repo's thinking lives
#
# Splitting naively cuts a function in half and the halves then answer
# questions wrongly — a body containing the words "create policy" would be read
# as a policy. So this tracks all three states and emits one record per real
# statement.
#
# WHAT IT THROWS AWAY, on purpose. Function bodies and string literals are
# replaced by a single space, and comments are dropped. Every rule that uses
# this asks about a statement's HEADER — is RLS enabled, does this policy name
# the partner guard, does this function say `set search_path` — and all of that
# is outside the body. Keeping the bodies would mean a policy's prose could
# satisfy the check that its policy text is missing.
#
# Output: one line per statement, `startline<TAB>normalised lowercase text`,
# where startline is the line the statement's first non-blank character is on,
# so a finding can be reported as file:line.
#
# Used by scripts/advisory-rules.sh; tested through scripts/advisory-rules.test.sh.

function append(t, n) {
  if (t ~ /[^ \t]/ && start == 0) start = n
  stmt = stmt " " t
}

function flush() {
  if (stmt ~ /[^ \t]/) {
    gsub(/[ \t]+/, " ", stmt)
    sub(/^ /, "", stmt)
    sub(/ $/, "", stmt)
    print start "\t" tolower(stmt)
  }
  stmt = ""
  start = 0
}

BEGIN { stmt = ""; start = 0; indq = 0; tag = ""; insq = 0 }

{
  line = $0
  out = ""
  i = 1
  L = length(line)
  while (i <= L) {
    if (indq) {
      # Inside a $$ body: skip everything until the matching closing tag.
      p = index(substr(line, i), tag)
      if (p == 0) { i = L + 1 } else { i = i + p - 1 + length(tag); indq = 0; tag = "" }
      continue
    }
    if (insq) {
      # Inside a '...' literal, which may run past the end of a line. Two
      # single quotes in a row are an escaped quote and do not close it.
      c = substr(line, i, 1)
      if (c == "'") {
        if (substr(line, i + 1, 1) == "'") { i += 2; continue }
        insq = 0; i++; continue
      }
      i++
      continue
    }
    c = substr(line, i, 1)
    if (substr(line, i, 2) == "--") { i = L + 1; continue }
    if (c == "$") {
      rest = substr(line, i)
      if (match(rest, /^\$[A-Za-z_0-9]*\$/)) {
        tag = substr(rest, 1, RLENGTH)
        indq = 1
        i += RLENGTH
        out = out " "
        continue
      }
    }
    if (c == "'") { insq = 1; i++; out = out " "; continue }
    if (c == ";") {
      append(out, NR)
      out = ""
      flush()
      i++
      continue
    }
    out = out c
    i++
  }
  append(out, NR)
  out = ""
}

END { flush() }
