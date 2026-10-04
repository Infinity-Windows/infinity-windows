import { stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { cancelUnitReview, fetchUnitReview, fetchUnitReviewReceipt, submitUnitReview } from "./api";
import { parseUnitReviewReply, type ReviewPayload, type ReviewReply } from "./protocol";
import { bindReviewReceipt, claimReviewAttempt, freezeReviewOriginal, readReviewJournal, recordReviewReceipt,
  reserveReviewOriginal, reviewDeliveryState, settleReviewAttempt, type ReviewJournalRecord } from "./storage";

export const REVIEW_FRESH_MS = 30_000;
export interface ReviewContext {
  login: SignInMark; unitId: string; contextKey: string;
  /** Include real permissions, preview, visibility, and the job/route lifetime.
   * Call invalidate synchronously on every boundary, including preview ABA. */
  admission: () => boolean;
}
export interface ReviewCoordinatorDependencies {
  read: typeof fetchUnitReview; receipt: typeof fetchUnitReviewReceipt; send: typeof submitUnitReview; cancel: typeof cancelUnitReview;
  journal: typeof readReviewJournal; reserve: typeof reserveReviewOriginal; claim: typeof claimReviewAttempt;
  settle: typeof settleReviewAttempt; recordReceipt: typeof recordReviewReceipt;
  monotonicNow: () => number; wallNow: () => number; token: () => string;
}
const defaults: ReviewCoordinatorDependencies = {
  read: fetchUnitReview, receipt: fetchUnitReviewReceipt, send: submitUnitReview, cancel: cancelUnitReview,
  journal: readReviewJournal, reserve: reserveReviewOriginal, claim: claimReviewAttempt,
  settle: settleReviewAttempt, recordReceipt: recordReviewReceipt,
  monotonicNow: () => performance.now(), wallNow: () => Date.now(), token: () => crypto.randomUUID(),
};
export type ReviewHeld = { kind: "held"; reason: "context_changed" | "unavailable" | "storage_unavailable" | "refresh_required" | "basis_changed" | "original_hidden" | "competing_request" };
export interface ReviewInspection {
  kind: "ready";
  /** Current permission-checked view in RAM only. Receipt history cannot set it. */
  current: Extract<ReviewReply, { availability: "available" }>;
  history: { record: ReviewJournalRecord; delivery: ReturnType<typeof reviewDeliveryState> }[];
  hasHiddenOriginal: boolean;
}
export type ReviewDeliveryResult = ReviewHeld | { kind: "recorded" | "unknown" | "refused" | "saved" | "cancelled"; commandId: string };
interface Snapshot { startedAt: number; serial: number; current: ReviewInspection["current"]; rows: ReviewJournalRecord[]; exposed: Set<string> }
const capability = (action: ReviewPayload["action"]) => action === "verify_dimensions" ? "verifyDimensions" : action === "claim_resolved" ? "claimResolved" : action;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const held = (reason: ReviewHeld["reason"]): ReviewHeld => ({ kind: "held", reason });

/** No listeners or automatic delivery. A mounted adapter owns this one context,
 * disposes it on unmount, and calls delivery only on a deliberate human tap.
 * Retained originals need fresh current AND original scope authorization. */
export class UnitReviewCoordinator {
  private readonly context: ReviewContext;
  private readonly deps: ReviewCoordinatorDependencies;
  private serial = 0;
  private disposed = false;
  private snapshot: Snapshot | null = null;
  constructor(context: ReviewContext, dependencies: Partial<ReviewCoordinatorDependencies> = {}) {
    uuid(context.unitId); uuid(context.login.userId);
    if (!context.contextKey.trim()) throw new Error("A selected unit context is required.");
    this.context = { ...context, unitId: context.unitId.toLowerCase(), login: { ...context.login } }; this.deps = { ...defaults, ...dependencies };
  }
  invalidate(): void { ++this.serial; this.snapshot = null; }
  dispose(): void { this.disposed = true; this.invalidate(); }
  private admitted = (): boolean => !this.disposed && stillSignedInAs(this.context.login, this.context.login.userId!)
    && (typeof navigator === "undefined" || navigator.onLine !== false) && this.context.admission();
  private fence(serial: number): () => boolean { return () => serial === this.serial && this.admitted(); }
  private fresh(snapshot: Snapshot | null): snapshot is Snapshot {
    if (!snapshot || !this.fence(snapshot.serial)()) return false;
    const age = this.deps.monotonicNow() - snapshot.startedAt;
    return age >= 0 && age < REVIEW_FRESH_MS;
  }
  /** Call during render, not just after a promise. Never cache this result. */
  inspection(): ReviewInspection | ReviewHeld {
    const s = this.snapshot;
    if (!this.admitted()) return held("context_changed");
    if (!this.fresh(s)) return held("refresh_required");
    return { kind: "ready", current: parseUnitReviewReply(s.current, this.context.unitId) as ReviewInspection["current"],
      history: s.rows.filter(row => s.exposed.has(row.commandId)).map(row => ({ record: structuredClone(row), delivery: reviewDeliveryState(row) })),
      hasHiddenOriginal: s.rows.some(row => !s.exposed.has(row.commandId)) };
  }
  /** Receipt-only recovery on reload/focus/reconnect never sends a decision. */
  async refresh(): Promise<ReviewInspection | ReviewHeld> {
    this.invalidate(); const serial = this.serial, admission = this.fence(serial), startedAt = this.deps.monotonicNow();
    if (!admission()) return held("context_changed");
    let storage = false;
    try {
      const current = parseUnitReviewReply(await this.deps.read(this.context.unitId, this.context.login, admission), this.context.unitId);
      if (!admission()) return held("context_changed");
      if (current.availability !== "available") return held("unavailable");
      storage = true;
      const rows = await this.deps.journal(this.context.login, this.context.unitId, admission);
      if (!admission()) return held("context_changed");
      storage = false; const exposed = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        let row = rows[i];
        // A changed token cannot prove the old incarnation's private scope.
        // Fresh receipt authorization includes the server's incarnation check.
        let originalScope = current.review.basis?.scopeToken === row.payload.basis.scopeToken
          && current.review.capabilities[capability(row.payload.action)];
        if (row.attempts.length || row.receipt || !originalScope) {
          const reply = await this.deps.receipt(row.commandId, this.context.login, admission);
          if (!admission()) return held("context_changed");
          if (reply.availability === "available") {
            const receipt = bindReviewReceipt(reply.receipt, row); originalScope = true;
            if (!row.receipt) {
              storage = true;
              row = await this.deps.recordReceipt(this.context.login, this.context.unitId, row.commandId, row.revision, receipt, admission);
              if (!admission()) return held("context_changed");
              storage = false; rows[i] = row;
            } else if (!same(receipt, row.receipt)) return held("unavailable");
          }
        }
        if (originalScope) exposed.add(row.commandId);
      }
      if (!admission()) return held("context_changed");
      this.snapshot = { startedAt, serial, current, rows, exposed }; return this.inspection();
    } catch { return held(!admission() ? "context_changed" : storage ? "storage_unavailable" : "unavailable"); }
  }
  /** Freeze before any await. Even a save error may follow native commit:
   * refresh the retained head before authoring a replacement. Never sends. */
  async reserve(commandId: string, payload: ReviewPayload): Promise<ReviewHeld | { kind: "saved"; commandId: string; created: boolean }> {
    const original = freezeReviewOriginal(commandId, payload), s = this.snapshot;
    if (!this.admitted()) return held("context_changed");
    if (!this.fresh(s)) return held("refresh_required");
    if (original.payload.basis.unitId !== this.context.unitId || !same(original.payload.basis, s.current.review.basis)
      || !s.current.review.capabilities[capability(original.payload.action)]) return held("basis_changed");
    const head = s.rows.at(-1);
    if (head && !s.exposed.has(head.commandId)) return held("original_hidden");
    if (head && !["recorded", "refused", "cancelled"].includes(reviewDeliveryState(head))) return held("competing_request");
    const admission = this.fence(s.serial);
    try {
      const saved = await this.deps.reserve(this.context.login, original, head?.commandId ?? null, () => admission() && this.fresh(s));
      if (!admission()) return held("context_changed");
      this.invalidate(); return { kind: "saved", commandId: saved.record.commandId, created: saved.created };
    } catch { return held(!admission() ? "context_changed" : "storage_unavailable"); }
  }
  /** Explicit delivery of the same UUID/basis/data; changed bases never rebase. */
  deliverOriginal(commandId: string): Promise<ReviewDeliveryResult> {
    return this.attemptOriginal(uuid(commandId).toLowerCase(), false);
  }
  /** Deliberate closure may submit the hidden owner's original to the server,
   * but cannot expose it. Server authorization includes its original fact and
   * incarnation; only a confirmed cancellation permits replacement. */
  cancelRetainedHead(): Promise<ReviewDeliveryResult> { return this.attemptOriginal(null, true); }
  private async attemptOriginal(commandId: string | null, cancelling: boolean): Promise<ReviewDeliveryResult> {
    const refreshed = await this.refresh();
    if (refreshed.kind !== "ready") return refreshed;
    const s = this.snapshot!, row = commandId === null ? s.rows.at(-1) : s.rows.find(r => r.commandId === commandId);
    if (!row || !cancelling && !s.exposed.has(row.commandId)) return held("original_hidden");
    commandId = row.commandId;
    if (row.receipt && !s.exposed.has(commandId)) return held("original_hidden");
    if (row.receipt) return { kind: row.receipt.outcome === "cancelled" ? "cancelled" : "recorded", commandId };
    if (s.rows.at(-1)?.commandId !== commandId) return held("competing_request");
    if (!cancelling && (!same(row.payload.basis, s.current.review.basis) || !s.current.review.capabilities[capability(row.payload.action)])) return held("basis_changed");
    const admission = () => this.fence(s.serial)() && this.fresh(s);
    let claimed = false;
    try {
      const token = this.deps.token();
      const reserved = await this.deps.claim(this.context.login, this.context.unitId, commandId, row.revision, token, this.deps.wallNow(), admission, cancelling ? "cancel" : "deliver");
      claimed = true; if (!admission()) return held("context_changed");
      const attempt = await (cancelling ? this.deps.cancel : this.deps.send)(commandId, reserved.payload, this.context.login, admission);
      // Crossing logout/preview/navigation keeps pending disk evidence intact.
      if (!admission()) return held("context_changed");
      const settled = await this.deps.settle(this.context.login, this.context.unitId, commandId, reserved.revision, token, attempt, admission);
      if (!admission()) return held("context_changed");
      this.invalidate(); return { kind: reviewDeliveryState(settled), commandId };
    } catch {
      if (!admission()) return held("context_changed");
      this.invalidate(); return claimed ? { kind: "unknown", commandId } : held("storage_unavailable");
    }
  }
}
