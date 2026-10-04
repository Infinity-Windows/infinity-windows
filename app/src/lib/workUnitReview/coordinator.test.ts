// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import { UnitReviewCoordinator, REVIEW_FRESH_MS, type ReviewCoordinatorDependencies } from "./coordinator";
import { parseUnitReviewReply, type ReviewPayload, type ReviewReceipt } from "./protocol";
import { freezeReviewOriginal, parseReviewJournalRecord, REVIEW_LEASE_MS, type ReviewJournalRecord } from "./storage";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), UNIT = id(2), COMMAND = id(3);
const basis = () => ({ unitId: UNIT, unitRevision: 1, factId: id(4), factRevision: 1, scopeToken: `ur1:${"a".repeat(64)}`,
  reviewRevision: 0, submissionId: null, generation: 0 });
const payload = (): ReviewPayload => ({ action: "verify_dimensions", basis: basis(), data: { widthDecimal: "001.00000000000000000100",
  heightDecimal: "72", unit: "in", source: "measured", sourceReference: null } });
const view = () => parseUnitReviewReply({ protocolVersion: 1, asOf: "2026-10-04T10:00:00Z", availability: "available", review: {
  basis: basis(), basisStatus: "current", capabilities: { verifyDimensions: true, submit: true, pass: false, fail: false, claimResolved: false, reopen: false },
  observation: { observerId: OWNER, source: "measured", widthDecimal: "1.000000000000000001", heightDecimal: "72", unit: "in", sourceReference: null },
  dimensionVerification: { state: "unverified", verificationId: null }, qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "unproven", qcAccepted: false },
  work: { availability: "available", activeCount: 0, pendingCount: 0 }, defects: [] } }, UNIT);
const receipt = (): ReviewReceipt => ({ protocolVersion: 1, commandId: COMMAND, action: "verify_dimensions", unitId: UNIT, eventId: id(7),
  reviewRevision: 1, generation: 0, submissionId: null, recordedAt: "2026-10-04T10:00:00Z", outcome: "applied" });
const row = (): ReviewJournalRecord => parseReviewJournalRecord({ version: 1, durability: "strict", ownerId: OWNER, unitId: UNIT, commandId: COMMAND, sequence: 0,
  predecessorId: null, revision: 0, payload: payload(), attempts: [], receipt: null });
function setup(initial: ReviewJournalRecord[] = []) {
  let rows = initial, time = 100, admitted = true;
  const deps = {
    read: vi.fn().mockResolvedValue(view()), receipt: vi.fn().mockResolvedValue({ protocolVersion: 1, availability: "unavailable", receipt: null }),
    send: vi.fn().mockResolvedValue({ kind: "unknown" }), cancel: vi.fn().mockResolvedValue({ kind: "unknown" }), journal: vi.fn(async () => structuredClone(rows)),
    reserve: vi.fn(async (_login, original) => { rows = [parseReviewJournalRecord({ ...row(), ...original })]; return { record: rows[0], created: true }; }),
    claim: vi.fn(async () => { rows[0] = { ...rows[0], revision: 1, attempts: [{ purpose: "deliver", token: id(8), startedAt: 100, leaseUntil: 100 + REVIEW_LEASE_MS, outcome: "pending", sqlState: null }] }; return rows[0]; }),
    settle: vi.fn(async (_login, _unit, _command, _revision, _token, attempt) => {
      const last = rows[0].attempts[0]; rows[0] = { ...rows[0], revision: 2, attempts: [{ ...last, outcome: attempt.kind === "applied" ? "recorded" : attempt.kind }], receipt: attempt.receipt ?? null };
      return rows[0];
    }),
    recordReceipt: vi.fn(async (_login, _unit, _command, _revision, r) => { rows[0] = { ...rows[0], receipt: r, revision: rows[0].revision + 1 }; return rows[0]; }),
    monotonicNow: () => time, wallNow: () => 100, token: () => id(8),
  } satisfies ReviewCoordinatorDependencies;
  const coordinator = new UnitReviewCoordinator({ login: signInMark(), unitId: UNIT, contextKey: "job-lifetime-1", admission: () => admitted }, deps);
  return { deps, coordinator, advance: () => { time += REVIEW_FRESH_MS; }, revoke: () => { admitted = false; }, rows: () => rows };
}
beforeEach(() => { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });

describe("permission fenced unit review delivery", () => {
  it("freezes a normalized original before storage and never sends before durable reservation", async () => {
    const s = setup(); await s.coordinator.refresh();
    let release!: () => void;
    s.deps.reserve.mockImplementationOnce(async (_login, original) => { await new Promise<void>(done => { release = done; }); return { record: { ...row(), ...original }, created: true }; });
    const raw = payload(), saving = s.coordinator.reserve(COMMAND, raw); raw.basis.reviewRevision = 99;
    expect(s.deps.reserve.mock.calls[0][1]).toEqual(freezeReviewOriginal(COMMAND, payload()));
    expect(s.deps.send).not.toHaveBeenCalled(); release(); expect(await saving).toMatchObject({ kind: "saved" });
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it("holds storage failure without sending and expires authoring proof", async () => {
    const s = setup(); await s.coordinator.refresh(); s.deps.reserve.mockRejectedValueOnce(Error("quota"));
    expect(await s.coordinator.reserve(COMMAND, payload())).toEqual({ kind: "held", reason: "storage_unavailable" });
    s.advance(); expect(await s.coordinator.reserve(COMMAND, payload())).toEqual({ kind: "held", reason: "refresh_required" });
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it("does not replay an expired pending request on repeated refresh or missing receipt", async () => {
    const pending = row(); pending.attempts = [{ purpose: "deliver", token: id(9), startedAt: 0, leaseUntil: REVIEW_LEASE_MS, outcome: "pending", sqlState: null }];
    const s = setup([pending]); for (let n = 0; n < 3; n++) await s.coordinator.refresh();
    expect(s.deps.send).not.toHaveBeenCalled(); expect(s.deps.claim).not.toHaveBeenCalled();
    expect(s.coordinator.inspection()).toMatchObject({ history: [{ delivery: "unknown" }] });
    expect(await s.coordinator.reserve(id(99), payload())).toEqual({ kind: "held", reason: "competing_request" });
  });
  it("sends the original only after fresh admission and durable lease; local confirmation failure stays unknown", async () => {
    const s = setup([row()]); s.deps.send.mockResolvedValueOnce({ kind: "applied", receipt: receipt() });
    s.deps.settle.mockRejectedValueOnce(Error("quota after server commit"));
    expect(await s.coordinator.deliverOriginal(COMMAND)).toEqual({ kind: "unknown", commandId: COMMAND });
    expect(s.deps.claim.mock.invocationCallOrder[0]).toBeLessThan(s.deps.send.mock.invocationCallOrder[0]);
    expect(s.deps.send.mock.calls[0].slice(0, 2)).toEqual([COMMAND, freezeReviewOriginal(COMMAND, payload()).payload]);
    expect(s.rows()[0].attempts[0].outcome).toBe("pending");
  });
  it("holds a changed basis without sending and hides unknown historical scope", async () => {
    const s = setup([row()]), changed = view(); if (changed.availability !== "available") throw Error();
    changed.review.basis!.reviewRevision = 1; s.deps.read.mockResolvedValue(changed);
    expect(await s.coordinator.deliverOriginal(COMMAND)).toEqual({ kind: "held", reason: "basis_changed" });
    changed.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`;
    expect(await s.coordinator.refresh()).toMatchObject({ history: [], hasHiddenOriginal: true });
    expect(await s.coordinator.reserve(id(99), { ...payload(), basis: changed.review.basis! })).toEqual({ kind: "held", reason: "original_hidden" });
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it("requires a fresh matching receipt to expose changed scope; history never changes current QC", async () => {
    const s = setup([row()]), changed = view(); if (changed.availability !== "available") throw Error();
    changed.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`; s.deps.read.mockResolvedValue(changed);
    s.deps.receipt.mockResolvedValue({ protocolVersion: 1, availability: "available", receipt: receipt() });
    expect(await s.coordinator.refresh()).toMatchObject({ history: [{ delivery: "recorded" }], hasHiddenOriginal: false,
      current: { review: { qc: { qcAccepted: false } } } });
    s.deps.receipt.mockResolvedValue({ protocolVersion: 1, availability: "unavailable", receipt: null });
    expect(await s.coordinator.refresh()).toMatchObject({ history: [], hasHiddenOriginal: true });
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it.each(["logout ABA", "preview ABA", "dispose", "offline", "permissions"])("fences response across %s", async boundary => {
    const s = setup([row()]); let release!: (value: ReturnType<typeof view>) => void;
    s.deps.read.mockImplementationOnce(() => new Promise(done => { release = done; }));
    const refreshing = s.coordinator.refresh();
    if (boundary === "logout ABA") { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); }
    else if (boundary === "preview ABA") s.coordinator.invalidate();
    else if (boundary === "dispose") s.coordinator.dispose();
    else if (boundary === "offline") Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    else s.revoke();
    release(view()); expect(await refreshing).toEqual({ kind: "held", reason: "context_changed" });
    expect(s.deps.journal).not.toHaveBeenCalled(); expect(s.deps.send).not.toHaveBeenCalled();
    expect(s.coordinator.inspection().kind).toBe("held");
  });
  it("does not record or expose a mismatched receipt", async () => {
    const r = row(); r.attempts = [{ purpose: "deliver", token: id(9), startedAt: 0, leaseUntil: REVIEW_LEASE_MS, outcome: "unknown", sqlState: null }];
    const s = setup([r]); s.deps.receipt.mockResolvedValue({ protocolVersion: 1, availability: "available", receipt: { ...receipt(), reviewRevision: 99 } });
    expect(await s.coordinator.refresh()).toEqual({ kind: "held", reason: "unavailable" });
    expect(s.deps.recordReceipt).not.toHaveBeenCalled(); expect(s.coordinator.inspection().kind).toBe("held");
  });
  it("keeps a dispatched request pending after auth changes before acknowledgement", async () => {
    const s = setup([row()]); s.deps.send.mockImplementationOnce(async () => {
      rememberSignedIn({ user: { id: id(99) } }); return { kind: "applied", receipt: receipt() };
    });
    expect(await s.coordinator.deliverOriginal(COMMAND)).toEqual({ kind: "held", reason: "context_changed" });
    expect(s.deps.settle).not.toHaveBeenCalled(); expect(s.rows()[0].attempts[0].outcome).toBe("pending");
  });
});


describe("cancelled originals and current authority", () => {
  it("does not expose a same-token draft after its current action authority is lost", async () => {
    const s = setup([row()]), current = view(); if (current.availability !== "available") throw Error();
    current.review.capabilities.verifyDimensions = false; s.deps.read.mockResolvedValue(current);
    expect(await s.coordinator.refresh()).toMatchObject({ history: [], hasHiddenOriginal: true });
    expect(s.deps.send).not.toHaveBeenCalled(); expect(s.deps.cancel).not.toHaveBeenCalled();
  });
  it("can explicitly cancel a changed basis without silently resending or replacing the decision", async () => {
    const s = setup([row()]), current = view(); if (current.availability !== "available") throw Error();
    current.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`; s.deps.read.mockResolvedValue(current);
    const original = freezeReviewOriginal(COMMAND, payload()).payload;
    s.deps.cancel.mockResolvedValueOnce({ kind: "cancelled", receipt: { protocolVersion: 1, commandId: COMMAND,
      action: original.action, unitId: UNIT, recordedAt: "2026-10-04T10:00:00Z", outcome: "cancelled", original } });
    expect(await s.coordinator.cancelRetainedHead()).toEqual({ kind: "cancelled", commandId: COMMAND });
    expect(s.deps.cancel.mock.calls[0].slice(0, 2)).toEqual([COMMAND, original]);
    expect(s.deps.send).not.toHaveBeenCalled(); expect(s.deps.reserve).not.toHaveBeenCalled();
  });
});
