import { supabase, supabaseConfigured } from "../supabase";
import type { BrainOutcome } from "./answer";

/**
 * The unanswered-question log. Every question asked of Ask Infinity is recorded
 * with whether our own written knowledge answered it and what it matched, so a
 * foreman can read the misses and write the five sentences that would have
 * answered them — real crew wording rather than guesswork.
 *
 * Logging never blocks or breaks an answer: a question asked in a basement is
 * held in local storage and sent the next time the phone has signal.
 */

const QUEUE_KEY = "iw.askLog.pending";
const MAX_QUEUED = 200;

export interface AskLogRow {
  id: string;
  asker_id: string;
  question: string;
  answered: boolean;
  outcome: "answers" | "live" | "miss";
  matched_ids: string[];
  matched_titles: string[];
  online: boolean | null;
  asked_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface PendingEntry {
  question: string;
  answered: boolean;
  outcome: "answers" | "live" | "miss";
  matched_ids: string[];
  matched_titles: string[];
  online: boolean | null;
  asked_at: string;
}

/** Shape one asked question into a log row. Pure, so the tests can check it. */
export function toLogEntry(
  question: string,
  outcome: BrainOutcome,
  opts: { online: boolean | null; askedAt?: string } = { online: null },
): PendingEntry {
  const hits = outcome.kind === "answers" ? outcome.hits : [];
  return {
    question: question.trim().slice(0, 500),
    // A "live" question isn't a gap in our written knowledge, but it isn't an
    // answer either — it stays unanswered so it shows up in the foreman's list.
    answered: outcome.kind === "answers",
    outcome: outcome.kind,
    matched_ids: hits.map((h) => h.entry.id),
    matched_titles: hits.map((h) => h.entry.title),
    online: opts.online,
    asked_at: opts.askedAt ?? new Date().toISOString(),
  };
}

function readQueue(): PendingEntry[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(entries: PendingEntry[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries.slice(-MAX_QUEUED)));
  } catch {
    // Storage full or unavailable — dropping a log line is never worth an error.
  }
}

/** Held-back log lines still waiting for signal. Trimmed to the newest 200. */
export function queueForLater(entry: PendingEntry): void {
  writeQueue([...readQueue(), entry]);
}

async function insertRows(askerId: string, entries: PendingEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await supabase
    .from("ask_question_log")
    .insert(entries.map((e) => ({ ...e, asker_id: askerId })));
  if (error) throw error;
}

/**
 * Record one question, flushing anything that was asked offline first. Resolves
 * either way — a failure just leaves the line queued for next time.
 */
export async function logAskedQuestion(
  question: string,
  outcome: BrainOutcome,
  opts: { online?: boolean } = {},
): Promise<void> {
  const online = typeof navigator === "undefined" ? null : (opts.online ?? navigator.onLine);
  const entry = toLogEntry(question, outcome, { online });
  if (!supabaseConfigured || online === false) {
    queueForLater(entry);
    return;
  }
  try {
    const { data } = await supabase.auth.getUser();
    const askerId = data.user?.id;
    if (!askerId) return;
    const pending = readQueue();
    await insertRows(askerId, [...pending, entry]);
    if (pending.length > 0) writeQueue([]);
  } catch {
    queueForLater(entry);
  }
}

/** The foreman's list. Readable only by foreman+ — the RLS policy enforces it. */
export async function listAskedQuestions(
  opts: { onlyUnanswered?: boolean; limit?: number } = {},
): Promise<AskLogRow[]> {
  if (!supabaseConfigured) return [];
  let query = supabase
    .from("ask_question_log")
    .select("*")
    .order("asked_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.onlyUnanswered) query = query.eq("answered", false);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AskLogRow[];
}

/** Mark a miss as dealt with once the answer has been written down. */
export async function markAskedQuestionReviewed(id: string): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("ask_question_log")
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: data.user?.id ?? null })
    .eq("id", id);
  if (error) throw error;
}

/** Group identical questions so a foreman sees "asked 7 times", not 7 rows. */
export interface AskLogGroup {
  question: string;
  asks: number;
  lastAskedAt: string;
  /** Row ids in the group, so "reviewed" can clear all of them at once. */
  ids: string[];
  /** Whatever the brain did offer, for the top row — often the wrong thing. */
  matchedTitles: string[];
  reviewed: boolean;
}

export function groupAskLog(rows: AskLogRow[]): AskLogGroup[] {
  const groups = new Map<string, AskLogGroup>();
  for (const row of rows) {
    const key = row.question.toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
    const existing = groups.get(key);
    if (existing) {
      existing.asks += 1;
      existing.ids.push(row.id);
      if (row.asked_at > existing.lastAskedAt) {
        existing.lastAskedAt = row.asked_at;
        existing.matchedTitles = row.matched_titles;
      }
      existing.reviewed = existing.reviewed && row.reviewed_at != null;
      continue;
    }
    groups.set(key, {
      question: row.question,
      asks: 1,
      lastAskedAt: row.asked_at,
      ids: [row.id],
      matchedTitles: row.matched_titles,
      reviewed: row.reviewed_at != null,
    });
  }
  return [...groups.values()].sort(
    (a, b) => b.asks - a.asks || b.lastAskedAt.localeCompare(a.lastAskedAt),
  );
}
