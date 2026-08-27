/**
 * Wave A's scheduling toolset for the `ask` edge function: tool definitions,
 * the supervisor-rank gate, and the pure INPUT validation that can be checked
 * before any database is touched. Pure — no `Deno`, no `fetch`, no Supabase
 * client — so this is unit-testable the same way anthropicJson.ts and
 * anthropicTools.ts are.
 *
 * What stays OUT of this file, deliberately: existence checks (does this
 * project_id/profile_id actually exist), active-profile checks, and
 * double-booking checks. Those need a live query against schedule_assignments
 * and are inherently impure, so they live in ask/index.ts next to the rest of
 * loadLiveContext's DB-reading code — the same split that file already draws.
 *
 * PERMISSION MIRROR (a1-ai-scheduler-spec.md, settled, cite-not-redecide):
 * "the AI holds exactly the caller's power. Scheduling tools refuse below
 * supervisor rank with a plain sentence. No new power enters through the chat
 * door." schedule_assignments' own RLS is wide open to any authenticated user
 * (20260721010000_crew_scheduling.sql — the app enforces edit-vs-read in the
 * route guard, same as Scheduling.tsx's own canEdit = isSupervisorPlus), so
 * this gate is the ONLY thing standing between a foreman's chat message and a
 * DRAFT write. It is checked identically by all three tools.
 */

import type { AnthropicToolDef } from "./anthropicTools.ts";

// ---------------------------------------------------------------------------
// The permission gate
// ---------------------------------------------------------------------------

/** Supervisor rank — mirrors role_rank()/roleRank() (owner 3, supervisor 2,
 * foreman 1, installer 0). The same floor Scheduling.tsx's canEdit already
 * uses for moving people on the board (owner decision, 2026-08-11). */
export const SCHEDULING_MIN_RANK = 2;

/** The plain sentence every scheduling tool returns verbatim below supervisor
 * rank — the model must relay it, not retry or paraphrase around it. */
export const SCHEDULING_REFUSAL =
  "Scheduling is a supervisor call. I can't read or change the crew board " +
  "for you — ask a supervisor or owner to plan this, or ask me something else.";

/** The refusal string, or null when the caller may proceed. One function so
 * every tool's gate check is the same line rather than three copies that
 * could drift apart. */
export function schedulingRefusal(callerRank: number): string | null {
  return callerRank >= SCHEDULING_MIN_RANK ? null : SCHEDULING_REFUSAL;
}

// ---------------------------------------------------------------------------
// Pure input validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** A real calendar date in YYYY-MM-DD — not just regex-shaped: "2026-02-30"
 * fails because Date rolls it into March and the round-trip stops matching. */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface ParsedDateRange {
  from: string;
  to: string;
  /** clear_ai_drafts' optional scope; unused (always null) by
   * get_scheduling_picture, which has no project_id parameter. */
  projectId: string | null;
  formatError: string | null;
}

/** Shared {from, to[, project_id]} shape both get_scheduling_picture and
 * clear_ai_drafts take. */
export function parseDateRangeInput(input: unknown): ParsedDateRange {
  const bad = (formatError: string): ParsedDateRange => ({
    from: "",
    to: "",
    projectId: null,
    formatError,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return bad('expected an object with "from" and "to" dates');
  }
  const obj = input as Record<string, unknown>;
  if (!isIsoDate(obj.from)) return bad('"from" must be a date, YYYY-MM-DD');
  if (!isIsoDate(obj.to)) return bad('"to" must be a date, YYYY-MM-DD');
  if (obj.from > obj.to) return bad('"from" must not be after "to"');
  return {
    from: obj.from,
    to: obj.to,
    projectId: looksLikeUuid(obj.project_id) ? obj.project_id : null,
    formatError: null,
  };
}

/** draft_assignments takes 1-200 person-day entries per call — a supervisor
 * planning two weeks for a twenty-person crew tops out well under this. */
export const MAX_DRAFT_ENTRIES = 200;

export interface DraftEntry {
  project_id: string;
  profile_id: string;
  date: string;
}

export interface DraftEntryError {
  /** Index into the ORIGINAL entries array the model sent, for its own reply. */
  index: number;
  reason: string;
}

export interface ParsedDraftEntries {
  /** Well-formed entries, ready for the DB-existence/double-book checks that
   * only ask/index.ts can run. */
  entries: DraftEntry[];
  /** Per-entry format problems — still worth reporting even though they never
   * reach the database. */
  errors: DraftEntryError[];
  /** Set when the WHOLE input is malformed (not an object, no array, empty,
   * over the cap) — entries/errors are both empty in that case. */
  formatError: string | null;
}

/**
 * Pure shape/format validation ONLY — existence, active status, and
 * double-booking are checked after this, against the database.
 */
export function parseDraftEntriesInput(input: unknown): ParsedDraftEntries {
  const bad = (formatError: string): ParsedDraftEntries => ({
    entries: [],
    errors: [],
    formatError,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return bad('expected an object with an "entries" array');
  }
  const raw = (input as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return bad('"entries" must be an array');
  if (raw.length === 0) return bad('"entries" cannot be empty');
  if (raw.length > MAX_DRAFT_ENTRIES) {
    return bad(`at most ${MAX_DRAFT_ENTRIES} entries per call, got ${raw.length}`);
  }

  const entries: DraftEntry[] = [];
  const errors: DraftEntryError[] = [];
  raw.forEach((item, index) => {
    const e = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (!looksLikeUuid(e.project_id)) {
      errors.push({ index, reason: "project_id must be a valid id" });
    } else if (!looksLikeUuid(e.profile_id)) {
      errors.push({ index, reason: "profile_id must be a valid id" });
    } else if (!isIsoDate(e.date)) {
      errors.push({ index, reason: "date must be YYYY-MM-DD" });
    } else {
      entries.push({
        project_id: e.project_id as string,
        profile_id: e.profile_id as string,
        date: e.date as string,
      });
    }
  });

  return { entries, errors, formatError: null };
}

// ---------------------------------------------------------------------------
// Tool definitions (the Anthropic Messages API shapes — see the PR body for
// these verbatim as "the tool JSON shapes")
// ---------------------------------------------------------------------------

const DATE_RANGE_PROPS = {
  from: { type: "string", description: "Start date, inclusive, YYYY-MM-DD." },
  to: { type: "string", description: "End date, inclusive, YYYY-MM-DD." },
} as const;

export const GET_SCHEDULING_PICTURE_TOOL: AnthropicToolDef = {
  name: "get_scheduling_picture",
  description:
    "Read the current scheduling picture for a date range: active jobs with " +
    "remaining work and the app's own day/crew estimate, the crew roster " +
    "(skill, capabilities, active status, who is already booked when), saved " +
    "crews, and this assistant's own existing draft assignments in range. " +
    "Call this FIRST, before drafting anything — never invent a job, a crew " +
    "member, or a number it didn't return. Refuses below supervisor rank.",
  input_schema: {
    type: "object",
    properties: { ...DATE_RANGE_PROPS },
    required: ["from", "to"],
  },
};

export const DRAFT_ASSIGNMENTS_TOOL: AnthropicToolDef = {
  name: "draft_assignments",
  description:
    "Write DRAFT crew assignments onto the schedule board: one person, one " +
    "job, one day per entry — the board's own native unit, so every row is " +
    "individually draggable and removable there. Every row this writes is " +
    "marked AI-proposed and stays invisible to the crew until a human " +
    "publishes on Scheduling — this tool can NEVER publish. Returns one " +
    "ok/refusal result per entry (refusal reasons: double_booked, " +
    "unknown_project, unknown_profile). Refuses the whole call below " +
    "supervisor rank.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: MAX_DRAFT_ENTRIES,
        description: `1 to ${MAX_DRAFT_ENTRIES} person-day assignments to draft.`,
        items: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "The job's id, from get_scheduling_picture." },
            profile_id: { type: "string", description: "The crew member's id, from get_scheduling_picture." },
            date: { type: "string", description: "YYYY-MM-DD." },
          },
          required: ["project_id", "profile_id", "date"],
        },
      },
    },
    required: ["entries"],
  },
};

export const CLEAR_AI_DRAFTS_TOOL: AnthropicToolDef = {
  name: "clear_ai_drafts",
  description:
    "Remove ONLY this assistant's own draft assignments (created_via='ai') " +
    "in a date range, optionally scoped to one job. Published rows and a " +
    "human's own drafts are never touched. Use this before redrafting after " +
    "a correction (\"swap Sam for Jordan\") rather than leaving stale " +
    "proposals sitting on the board next to the new ones. Refuses below " +
    "supervisor rank.",
  input_schema: {
    type: "object",
    properties: {
      ...DATE_RANGE_PROPS,
      project_id: { type: "string", description: "Optional — limit clearing to one job." },
    },
    required: ["from", "to"],
  },
};

export const SCHEDULING_TOOLS: AnthropicToolDef[] = [
  GET_SCHEDULING_PICTURE_TOOL,
  DRAFT_ASSIGNMENTS_TOOL,
  CLEAR_AI_DRAFTS_TOOL,
];

// ---------------------------------------------------------------------------
// System prompt addition
// ---------------------------------------------------------------------------

/**
 * Appended to ASK_SYSTEM_PROMPT (knowledge.ts) for every call — the toolset
 * is always offered, to every caller, so a below-rank caller gets the SAME
 * clean tool refusal a human trying a hidden button would get, rather than
 * the tools quietly not existing for them. The team rules below are the
 * settled decisions from a1-ai-scheduler-spec.md's grilled header, restated
 * for the model rather than re-decided.
 */
export const SCHEDULING_SYSTEM_PROMPT =
  "\n\nSCHEDULING: you may also be asked to plan crew scheduling. Three tools " +
  "are available: get_scheduling_picture, draft_assignments, clear_ai_drafts. " +
  "Call get_scheduling_picture FIRST for the range in question, before " +
  "drafting anything — never invent a job, a crew member, or a number it " +
  "didn't return. Every scheduling tool mirrors the asking user's own " +
  "permission: below supervisor rank it returns a plain refusal sentence, " +
  "which you must relay to the user verbatim rather than retry, argue with, " +
  "or work around.\n" +
  "Team rules when proposing crew (never re-decide these, they are settled):\n" +
  "- Every team needs at least one skill-4-or-higher lead.\n" +
  "- Fill headcount from crew who are active, unbooked in the range, and " +
  "available — never double-book a person across overlapping assignments.\n" +
  "- Honor any capability a job names (wet glazing, curtain wall, retrofit, " +
  "nail fin, doors) — only send someone who holds that badge.\n" +
  "- Location is soft reasoning from job addresses (nearby jobs, same town) " +
  "— never compute or claim drive times or mileage.\n" +
  "- Saved crews are a SOFT law: keep a named team together where you can, " +
  "and when you can't, SAY so plainly in your answer (\"I split Team 1 — " +
  "Sam covers Sand Hollow alone\") rather than splitting one silently.\n" +
  "- Never silently under-staff a job. When you can't fully cover " +
  "something, name exactly what's short and offer the least-bad trades " +
  "with their real cost (\"pull Taylor off PECAN14 — that job loses its " +
  "lead\", \"send 3 for 3 days instead of 4 for 2\", \"wait until " +
  "Thursday\") rather than staying quiet about the gap.\n" +
  "- Open with the app's own day/crew estimate from get_scheduling_picture " +
  "(expected minutes, recommended crew size) rather than guessing; when the " +
  "person asking gives a different number in plain words, use theirs " +
  "instead but say so plainly. Either way, show the math (units x time, " +
  "crew-hours, days) rather than just stating a conclusion.\n" +
  '- A mid-conversation correction ("swap Sam for Jordan") edits the plan ' +
  "in place: clear_ai_drafts the affected entries, then draft_assignments " +
  "the fix — don't just describe the change without writing it.\n" +
  "- draft_assignments can NEVER publish a schedule to the crew — it only " +
  "ever writes drafts a human must review. Every final answer that drafted " +
  "anything must end with a plain summary of what was drafted and the " +
  'sentence: "Review on Scheduling — nothing reaches the crew until you ' +
  'publish."';
