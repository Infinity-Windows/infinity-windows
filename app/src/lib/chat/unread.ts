// Pure unread-count logic for the job chat. Given the messages a user can see,
// their per-project last-read cursor, and their own id, count how many messages
// are unread per project. Kept dependency-free and unit-tested so the badge
// counts are provably correct.
//
// A message is unread for a project when it was created strictly AFTER that
// project's last_read_at (or the project has never been read) AND it was not
// written by the viewer themselves — you never mark yourself unread.

export interface UnreadMessage {
  project_id: string;
  author_id: string;
  created_at: string;
}

/** Parse an ISO timestamp to epoch ms, tolerating the null "never read" case. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Count unread messages per project. `lastReadByProject` maps a project id to
 * the viewer's last_read_at (ISO); a missing entry means the project has never
 * been read (so every other-authored message counts). Only projects with at
 * least one unread message appear in the result.
 */
export function countUnreadByProject(
  messages: readonly UnreadMessage[],
  lastReadByProject: Readonly<Record<string, string | null | undefined>>,
  selfId: string | null,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    if (selfId && m.author_id === selfId) continue;
    const created = toMs(m.created_at);
    if (created === null) continue;
    const lastRead = toMs(lastReadByProject[m.project_id]);
    if (lastRead !== null && created <= lastRead) continue;
    counts[m.project_id] = (counts[m.project_id] ?? 0) + 1;
  }
  return counts;
}

/** Sum of every project's unread count. */
export function totalUnread(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}
