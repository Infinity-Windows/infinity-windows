import { isUuid } from "./qcReviewState";
import type { QcReviewDecisionStatus } from "./qcReview";

/** Only an actually submitted command is durable. No unit facts, evidence,
 * signed links, AI output, or unsubmitted callback drafts belong here. */
export interface QcSubmittedCommand {
  decisionId: string;
  projectId: string;
  openingId: string;
  status: QcReviewDecisionStatus;
  note: string | null;
  expectedReviewVersion: string;
  term: string;
}
export type QcRecovery = { kind: "empty" } | { kind: "command"; command: QcSubmittedCommand }
  | { kind: "invalid" } | { kind: "unavailable" };
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["decisionId", "projectId", "openingId", "status", "note", "expectedReviewVersion", "term"];
export function validateQcSubmittedCommand(value: unknown): QcSubmittedCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(key => !FIELDS.includes(key)) || Object.keys(c).length !== FIELDS.length) return null;
  if (!isUuid(c.decisionId) || !isUuid(c.projectId) || !isUuid(c.openingId)
    || (c.status !== "passed" && c.status !== "callback")
    || (c.note !== null && (typeof c.note !== "string" || c.note.length > 4000 || c.note.includes("\0")))
    || typeof c.expectedReviewVersion !== "string"
    || (c.expectedReviewVersion !== "none" && !VERSION.test(c.expectedReviewVersion))
    || typeof c.term !== "string" || c.term.length > 200 || c.term.includes("\0")
    || (c.status === "passed" && c.term !== "")) return null;
  if ((typeof c.note === "string" ? c.note.trim() || null : null) !== c.note) return null;
  return { decisionId: c.decisionId, projectId: c.projectId, openingId: c.openingId,
    status: c.status, note: c.note as string | null, expectedReviewVersion: c.expectedReviewVersion, term: c.term };
}
const keyFor = (viewer: string) => `qcReview:submitted:v1:${viewer}`;
export function readQcSubmittedCommand(viewer: string): QcRecovery {
  if (!isUuid(viewer)) return { kind: "invalid" };
  try {
    const raw = window.sessionStorage.getItem(keyFor(viewer));
    if (raw === null) return { kind: "empty" };
    if (raw.length > 32_000) return { kind: "invalid" };
    const envelope = JSON.parse(raw);
    if (!envelope || envelope.version !== 1 || envelope.viewer !== viewer
      || Object.keys(envelope).sort().join(",") !== "command,version,viewer") return { kind: "invalid" };
    const command = validateQcSubmittedCommand(envelope.command);
    return command ? { kind: "command", command } : { kind: "invalid" };
  } catch (error) { return { kind: error instanceof SyntaxError ? "invalid" : "unavailable" }; }
}
export function persistQcSubmittedCommand(viewer: string, command: QcSubmittedCommand): boolean {
  const canonical = validateQcSubmittedCommand(command);
  if (!isUuid(viewer) || !canonical) return false;
  const prior = readQcSubmittedCommand(viewer);
  if (prior.kind !== "empty" && (prior.kind !== "command" || JSON.stringify(prior.command) !== JSON.stringify(canonical))) return false;
  try {
    window.sessionStorage.setItem(keyFor(viewer), JSON.stringify({ version: 1, viewer, command: canonical }));
    const stored = readQcSubmittedCommand(viewer);
    return stored.kind === "command" && JSON.stringify(stored.command) === JSON.stringify(canonical);
  } catch { return false; }
}
/** Only the matching receipt/refusal may clear an unresolved command. */
export function clearQcSubmittedCommand(viewer: string, decisionId: string): boolean {
  const current = readQcSubmittedCommand(viewer);
  if (current.kind === "empty") return true;
  if (current.kind !== "command" || current.command.decisionId !== decisionId) return false;
  try {
    window.sessionStorage.removeItem(keyFor(viewer));
    return window.sessionStorage.getItem(keyFor(viewer)) === null;
  } catch { return false; }
}
