/**
 * Lesson write-ups for the Hex-Portal archive: the five headings, their shape,
 * and the Ask tool that prepares one. Pure — no Deno, no fetch — so the app's
 * Vitest suite and the Ask page use the same rules the database enforces
 * (_hex_learning_content in 20261026000000_hex_learning_review.sql).
 *
 * What the model can and cannot do is decided here and in the database:
 *  - It prepares a draft on the person's screen. It cannot save, send, pick a
 *    reviewer or approve: the schema has no such field, and those are taps.
 *  - A reviewer it hears by name is only looked up; an exact single match is
 *    shown preselected, anything else is a list the person chooses from.
 *  - Impact minutes and cost are the person's own estimate, labelled as such.
 *    Nothing here reads or writes a clock or payroll.
 */
import type { AnthropicToolDef } from "./anthropicTools.ts";

export const LEARNING_HEADINGS = ["issue", "what_happened", "impact", "lesson_learned", "preventive_action"] as const;
export type LearningHeading = (typeof LEARNING_HEADINGS)[number];

export interface LearningContent {
  issue: string | null;
  what_happened: string | null;
  impact: string | null;
  impact_minutes: number | null;
  impact_cost_cents: number | null;
  lesson_learned: string | null;
  preventive_action: string | null;
  unknown: LearningHeading[];
}

export const emptyLearningContent = (): LearningContent => ({
  issue: null, what_happened: null, impact: null, impact_minutes: null, impact_cost_cents: null,
  lesson_learned: null, preventive_action: null, unknown: [],
});

const isHeading = (v: unknown): v is LearningHeading => LEARNING_HEADINGS.includes(v as LearningHeading);
const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > 4000) throw new Error("Keep each heading under 4000 characters.");
  return t || null;
};
const whole = (v: unknown, max: number): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new Error("Enter impact minutes and cost as whole numbers, or leave them blank.");
  return v;
};

/** The same normalisation the database applies. Throws a plain sentence. */
export function normalizeLearning(input: Partial<LearningContent> | null | undefined): LearningContent {
  const c = emptyLearningContent();
  for (const h of LEARNING_HEADINGS) c[h] = text(input?.[h]);
  c.impact_minutes = whole(input?.impact_minutes, 100000);
  c.impact_cost_cents = whole(input?.impact_cost_cents, 100000000);
  const unknown = [...new Set((input?.unknown ?? []).filter(isHeading))];
  if (unknown.some((h) => answered(c, h))) throw new Error("A heading cannot be both answered and Unknown.");
  c.unknown = [...unknown].sort() as LearningHeading[];
  return c;
}

/** Impact counts as answered by its words, minutes or cost. */
function answered(c: LearningContent, h: LearningHeading): boolean {
  if (h === "impact") return c.impact !== null || c.impact_minutes !== null || c.impact_cost_cents !== null;
  return c[h] !== null;
}

/** Headings with neither an answer nor an explicit Unknown, in reading order. */
export function missingHeadings(c: LearningContent): LearningHeading[] {
  return LEARNING_HEADINGS.filter((h) => !answered(c, h) && !c.unknown.includes(h));
}

/** What still stops Send, or null. Issue and What happened must be said. */
export function sendBlocker(c: LearningContent): "missing" | "issue_and_what_happened" | null {
  if (missingHeadings(c).length) return "missing";
  if (c.issue === null || c.what_happened === null) return "issue_and_what_happened";
  return null;
}

export const HEADING_LABELS_EN: Record<LearningHeading, string> = {
  issue: "Issue", what_happened: "What happened", impact: "Impact", lesson_learned: "Lesson learned", preventive_action: "Preventive action",
};

/** "$12.50" from cents; the words are the person's estimate. */
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The formatted breakdown the crew is used to, in either language. */
export function formatBreakdown(
  c: LearningContent,
  words: { labels: Record<LearningHeading, string>; unknown: string; missing: string; selfReported: (parts: string) => string; minutes: (n: number) => string } =
    { labels: HEADING_LABELS_EN, unknown: "Unknown", missing: "Not answered yet", selfReported: (p) => `self-reported: ${p}`, minutes: (n) => `${n} min` },
): string {
  return LEARNING_HEADINGS.map((h) => {
    let value = c[h] ?? (c.unknown.includes(h) ? words.unknown : answered(c, h) ? "" : words.missing);
    if (h === "impact") {
      const parts = [c.impact_minutes !== null ? words.minutes(c.impact_minutes) : null, c.impact_cost_cents !== null ? dollars(c.impact_cost_cents) : null].filter(Boolean).join(", ");
      if (parts) value = `${value ? `${value} ` : ""}(${words.selfReported(parts)})`;
    }
    return `${words.labels[h]}: ${value}`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// The Ask tool
// ---------------------------------------------------------------------------
const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

export const LEARNING_TOOLS: AnthropicToolDef[] = [{
  name: "prepare_learning_draft", strict: true,
  description: "Prepare (or update) the person's lesson write-up for one job and optional unit on their screen: Issue, What happened, Impact, Lesson learned, Preventive action. Call whenever they tell you what happened or answer a heading. It saves and sends NOTHING: the person reviews the card, saves it, chooses the reviewer and taps Send themselves.",
  input_schema: {
    type: "object", additionalProperties: false,
    properties: {
      project_id: { type: "string", description: "The job id from get_field_context." },
      unit_id: nullable("string", "The unit id from get_field_context, if they named a unit that has a record."),
      unit_label: nullable("string", "The unit number or name as said, if any."),
      issue: nullable("string", "The problem in a short sentence, in their words. Null if not said."),
      what_happened: nullable("string", "What happened, in their words. Null if not said."),
      impact: nullable("string", "The effect on the work, in their words. Null if not said."),
      impact_minutes: nullable("integer", "Minutes lost, ONLY if they said a number. Their estimate, not payroll."),
      impact_cost_dollars: nullable("number", "Cost in dollars, ONLY if they said one. Their estimate."),
      lesson_learned: nullable("string", "What they learned, in their words. Null if not said."),
      preventive_action: nullable("string", "What should be done next time, in their words. Null if not said."),
      unknown: { type: "array", items: { type: "string", enum: [...LEARNING_HEADINGS] }, description: "Headings they said they do not know. Silence is NOT unknown." },
      reviewer_name: nullable("string", "The foreman or supervisor they want to review it, exactly as said. Null if not said."),
    },
    required: ["project_id", "unit_id", "unit_label", "issue", "what_happened", "impact", "impact_minutes", "impact_cost_dollars", "lesson_learned", "preventive_action", "unknown", "reviewer_name"],
  },
}];
export const LEARNING_TOOL_NAMES = new Set(LEARNING_TOOLS.map((t) => t.name));

export const LEARNING_SYSTEM_PROMPT = `
LESSON WRITE-UPS. When someone tells you what happened on a job or unit so others can learn from it:
- Find the job (and unit) with get_field_context first, then call prepare_learning_draft with what THIS message said; it is merged with the LEARNING DRAFT below.
- Keep their words. Do not invent causes, instructions, measurements, minutes or costs. Impact minutes/cost are only their own estimate and never change their time or pay.
- Ask only for headings still missing. "I don't know" goes in unknown. A lesson is an observation for review, not an approved installation instruction; never present it as one, and never contradict the manufacturer or safety rules.
- You cannot save, send, choose the reviewer, forward or approve. Say the card below is ready for them to check, save and send to the person they choose. If the reviewer name matched several people or nobody, say they must pick from the list.
- A foreman reviews and can ask for changes or pass it to a supervisor; only a supervisor or owner approves it for the Hex-Portal archive. Never say anything was approved, sent to Hex-Portal or received.
`;

export interface ReviewerChoice { id: string; name: string; role: "foreman" | "supervisor" | "owner"; exact: boolean }
export interface ReviewerLookup { status: "exact" | "choose" | "none" | "not_named"; match: ReviewerChoice | null; choices: ReviewerChoice[]; said?: string | null }

/** The prepared write-up carried on a field reply and saved with the request. */
export interface LearningPrep {
  /** The person's own field message the write-up started from (its words and recording). */
  request_id: string;
  /** Every field message whose answers went into it, first to last. References only. */
  source_request_ids: string[];
  project_id: string;
  job: { name: string; job_code: string | null } | null;
  unit_id: string | null;
  unit_label: string | null;
  content: LearningContent;
  missing: LearningHeading[];
  reviewer: ReviewerLookup | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One tool call, checked and converted. Throws a sentence for the model. */
export function learningInput(input: unknown): { project_id: string; unit_id: string | null; unit_label: string | null; content: Partial<LearningContent>; reviewer_name: string | null } {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof a.project_id !== "string" || !UUID.test(a.project_id)) throw new Error("Find the exact job with get_field_context first.");
  if (a.unit_id != null && (typeof a.unit_id !== "string" || !UUID.test(a.unit_id))) throw new Error("Use a unit id from get_field_context, or only the unit label.");
  const cost = a.impact_cost_dollars;
  if (cost != null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 1_000_000)) throw new Error("Ask for the cost again as a dollar amount.");
  const minutes = a.impact_minutes;
  if (minutes != null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 100000)) throw new Error("Ask how many whole minutes were lost.");
  const content: Partial<LearningContent> = {
    issue: text(a.issue), what_happened: text(a.what_happened), impact: text(a.impact), lesson_learned: text(a.lesson_learned), preventive_action: text(a.preventive_action),
    impact_minutes: (minutes as number | null) ?? null, impact_cost_cents: cost == null ? null : Math.round((cost as number) * 100),
    unknown: Array.isArray(a.unknown) ? a.unknown.filter(isHeading) : [],
  };
  const label = text(a.unit_label);
  return { project_id: a.project_id.toLowerCase(), unit_id: typeof a.unit_id === "string" ? a.unit_id.toLowerCase() : null,
    unit_label: label ? label.slice(0, 160) : null, content, reviewer_name: text(a.reviewer_name)?.slice(0, 100) ?? null };
}

/**
 * Merge this message's answers onto the draft so far.
 *  - Said now replaces; not said (null) keeps.
 *  - "I don't know that after all" clears an earlier answer unless this
 *    message also gives one.
 *  - A different job starts a fresh draft; a different unit on the same job
 *    keeps the headings but takes the new unit.
 */
export function mergeLearning(prev: LearningContent | null, said: Partial<LearningContent>): LearningContent {
  const out: LearningContent = { ...(prev ?? emptyLearningContent()), unknown: [...(prev?.unknown ?? [])] };
  for (const h of LEARNING_HEADINGS) if (said[h] != null) out[h] = said[h] as string;
  if (said.impact_minutes != null) out.impact_minutes = said.impact_minutes;
  if (said.impact_cost_cents != null) out.impact_cost_cents = said.impact_cost_cents;
  const newly = (said.unknown ?? []).filter(isHeading);
  for (const h of newly) {
    if (said[h] != null || (h === "impact" && (said.impact_minutes != null || said.impact_cost_cents != null))) continue;
    out[h] = null;
    if (h === "impact") { out.impact_minutes = null; out.impact_cost_cents = null; }
  }
  out.unknown = [...new Set([...out.unknown, ...newly])].filter((h) => !answered(out, h)) as LearningHeading[];
  return normalizeLearning(out);
}

/** What the model is told: the draft and what it may say about it. */
export function describeLearning(prep: LearningPrep): string {
  const reviewer = prep.reviewer;
  const who = !reviewer || reviewer.status === "not_named" ? "No reviewer named yet; the person chooses on the card."
    : reviewer.status === "exact" ? `Reviewer ${reviewer.match?.name} is preselected; the person still taps Send.`
    : reviewer.status === "choose" ? "Several people could match that name; the person must choose on the card."
    : "Nobody who can review this job matches that name; the person must choose on the card.";
  return JSON.stringify({
    draft: { job: prep.job, unit: prep.unit_label, headings: prep.content, missing: prep.missing },
    reviewer: who,
    guidance: "NOT saved and NOT sent. Ask only for the missing headings (Unknown is allowed). Never say it was saved, sent or approved.",
  });
}
