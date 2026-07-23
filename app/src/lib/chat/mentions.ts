// Pure @-mention parsing for the job chat. Given the raw message body and the
// job roster, resolve "@Name" tokens to profile ids (for notifying) and split a
// body into segments (for highlighting). Kept dependency-free and unit-tested
// so the notify/highlight paths can trust it.
//
// Forgiving by design: matches are case-insensitive, tolerate trailing
// punctuation, and try a "First Last" pair before falling back to a first-name
// match — so "@Taylor", "@taylor can you", and "@Taylor Ammon" all resolve the
// way a human would expect.

export interface MentionRosterMember {
  id: string;
  display_name: string | null;
}

/** A word char run that can start a name: letters/digits, apostrophes, hyphens. */
const NAME_WORD = "[\\p{L}\\p{N}][\\p{L}\\p{N}'\\-]*";
const MENTION_SRC = `@(${NAME_WORD})(?:(\\s+)(${NAME_WORD}))?`;

function mentionRe(): RegExp {
  return new RegExp(MENTION_SRC, "gu");
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function firstName(display: string | null | undefined): string {
  return norm(display).split(/\s+/)[0] ?? "";
}

interface RosterIndex {
  byFullName: Map<string, string[]>;
  byFirstName: Map<string, string[]>;
}

function indexRoster(roster: readonly MentionRosterMember[]): RosterIndex {
  const byFullName = new Map<string, string[]>();
  const byFirstName = new Map<string, string[]>();
  for (const member of roster) {
    const full = norm(member.display_name);
    if (full) {
      const list = byFullName.get(full) ?? [];
      list.push(member.id);
      byFullName.set(full, list);
    }
    const first = firstName(member.display_name);
    if (first) {
      const list = byFirstName.get(first) ?? [];
      list.push(member.id);
      byFirstName.set(first, list);
    }
  }
  return { byFullName, byFirstName };
}

/** Resolve one @-token (word1 + optional word2) to profile ids, longest first. */
function resolveToken(
  word1: string,
  word2: string | null,
  idx: RosterIndex,
): { ids: string[]; usedSecondWord: boolean } {
  const w1 = norm(word1);
  if (word2) {
    const full = `${w1} ${norm(word2)}`;
    if (idx.byFullName.has(full)) {
      return { ids: idx.byFullName.get(full)!, usedSecondWord: true };
    }
  }
  if (idx.byFullName.has(w1)) return { ids: idx.byFullName.get(w1)!, usedSecondWord: false };
  return { ids: idx.byFirstName.get(w1) ?? [], usedSecondWord: false };
}

/**
 * The `@`-token pairs found in the body, in order: a required first word and an
 * optional following word (so a "First Last" mention can be tried before a
 * bare first-name match). Punctuation and the `@` are already stripped.
 */
export function parseMentionTokens(
  body: string,
): { word1: string; word2: string | null }[] {
  const out: { word1: string; word2: string | null }[] = [];
  for (const m of body.matchAll(mentionRe())) {
    out.push({ word1: m[1], word2: m[3] ?? null });
  }
  return out;
}

/**
 * Resolve every @-mention in `body` to a set of roster profile ids. Tries a
 * two-word full-name match first; otherwise treats the first word as a
 * first-name (or single-word full-name) match. Returns de-duplicated ids in
 * first-seen order.
 */
export function resolveMentions(
  body: string,
  roster: readonly MentionRosterMember[],
): string[] {
  if (!body) return [];
  const idx = indexRoster(roster);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { word1, word2 } of parseMentionTokens(body)) {
    for (const id of resolveToken(word1, word2, idx).ids) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  }
  return result;
}

export interface MentionSegment {
  text: string;
  /** Set when this segment is a resolved @-mention; null for plain text. */
  mentionId: string | null;
}

/**
 * Split `body` into ordered segments for rendering, marking the substrings that
 * are resolved @-mentions so the UI can highlight them. Only the portion that
 * actually resolves is marked (e.g. in "@Taylor can you", just "@Taylor").
 */
export function splitMentionSegments(
  body: string,
  roster: readonly MentionRosterMember[],
): MentionSegment[] {
  if (!body) return [];
  const idx = indexRoster(roster);
  const segments: MentionSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.mentionId === null) last.text += text;
    else segments.push({ text, mentionId: null });
  };

  const re = mentionRe();
  let lastIndex = 0;
  for (const m of body.matchAll(re)) {
    const start = m.index ?? 0;
    const [full, word1, sep, word2] = m;
    const { ids, usedSecondWord } = resolveToken(word1, word2 ?? null, idx);
    pushText(body.slice(lastIndex, start));
    if (ids.length > 0) {
      const mentionText = usedSecondWord ? full : `@${word1}`;
      segments.push({ text: mentionText, mentionId: ids[0] });
      // A non-consumed second word is plain trailing text.
      if (!usedSecondWord && word2) pushText(`${sep}${word2}`);
    } else {
      pushText(full);
    }
    lastIndex = start + full.length;
  }
  pushText(body.slice(lastIndex));
  return segments;
}
