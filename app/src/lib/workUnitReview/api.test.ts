import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import type { ReviewPayload } from "./protocol";
const m = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), client: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { auth: { getSession: m.session } }, clientWithToken: m.client }));
const { cancelUnitReview, fetchUnitReview, fetchUnitReviewReceipt, submitUnitReview, UnitReviewUnavailableError } = await import("./api");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), UNIT = id(2), COMMAND = id(3), AT = "2026-10-04T12:00:00.000123Z";
const payload = (): Extract<ReviewPayload, { action: "verify_dimensions" }> => ({ action: "verify_dimensions", basis: { unitId: UNIT, unitRevision: 2, factId: id(4),
  factRevision: 1, scopeToken: "ur1:" + "b".repeat(64), reviewRevision: 0, submissionId: null, generation: 0 },
  data: { widthDecimal: "00036.00000000000000000100", heightDecimal: "72.0", unit: "in", source: "measured", sourceReference: "Tape" } });
const receipt = () => ({ protocolVersion: 1, commandId: COMMAND, action: "verify_dimensions", unitId: UNIT, eventId: id(5),
  reviewRevision: 1, generation: 0, submissionId: null, recordedAt: AT, outcome: "applied" });
const unavailable = () => ({ protocolVersion: 1, asOf: AT, availability: "unavailable", review: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const session = () => ({ data: { session: { access_token: "checked-token", user: { id: OWNER } } }, error: null });
beforeEach(() => {
  rememberSignedIn({ user: { id: OWNER } }); vi.stubGlobal("navigator", { onLine: true });
  m.rpc.mockReset().mockResolvedValue({ data: unavailable(), error: null }); m.session.mockReset().mockResolvedValue(session());
  m.client.mockReset().mockReturnValue({ rpc: m.rpc });
});
afterEach(() => { rememberSignedIn(null); vi.unstubAllGlobals(); });

describe("fresh private unit-review transport", () => {
  it("reads only the exact unit with the checked token and preserves hidden/unavailable", async () => {
    expect(await fetchUnitReview(UNIT)).toEqual(unavailable());
    expect(m.client).toHaveBeenCalledWith("checked-token");
    expect(m.rpc).toHaveBeenCalledOnce(); expect(m.rpc).toHaveBeenCalledWith("work_unit_review_read", { p_unit_id: UNIT });
  });
  it("never reads offline or during denied preview/navigation admission", async () => {
    await expect(fetchUnitReview(UNIT, signInMark(), () => false)).rejects.toThrow(UnitReviewUnavailableError);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(fetchUnitReview(UNIT)).rejects.toThrow(UnitReviewUnavailableError);
    expect(m.rpc).not.toHaveBeenCalled(); expect(m.session).not.toHaveBeenCalled();
  });
  it("fences owner ABA while the actual session lookup is held", async () => {
    const held = deferred<ReturnType<typeof session>>(); m.session.mockReturnValueOnce(held.promise);
    const read = fetchUnitReview(UNIT); rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); held.resolve(session());
    await expect(read).rejects.toThrow(UnitReviewUnavailableError); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("drops late current-view replies after navigation, auth ABA or going offline", async () => {
    const held = deferred<{ data: unknown; error: null }>(); let admitted = true; m.rpc.mockReturnValueOnce(held.promise);
    const read = fetchUnitReview(UNIT, signInMark(), () => admitted); await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    admitted = false; held.resolve({ data: unavailable(), error: null });
    await expect(read).rejects.toThrow(UnitReviewUnavailableError);
    m.rpc.mockClear(); const held2 = deferred<{ data: unknown; error: null }>(); m.rpc.mockReturnValueOnce(held2.promise);
    const read2 = fetchUnitReview(UNIT); await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); held2.resolve({ data: unavailable(), error: null });
    await expect(read2).rejects.toThrow(UnitReviewUnavailableError);
    m.rpc.mockClear(); const held3 = deferred<{ data: unknown; error: null }>(); m.rpc.mockReturnValueOnce(held3.promise);
    const read3 = fetchUnitReview(UNIT); await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    vi.stubGlobal("navigator", { onLine: false }); held3.resolve({ data: unavailable(), error: null });
    await expect(read3).rejects.toThrow(UnitReviewUnavailableError);
  });
  it("freezes exact original UUID, basis and canonical decimal payload before awaits", async () => {
    const held = deferred<ReturnType<typeof session>>(); m.session.mockReturnValueOnce(held.promise);
    m.rpc.mockResolvedValueOnce({ data: receipt(), error: null }); const original = payload();
    const attempt = submitUnitReview(COMMAND, original, signInMark(), () => true);
    original.basis.unitId = id(99); original.data.widthDecimal = "99"; held.resolve(session());
    expect(await attempt).toEqual({ kind: "applied", receipt: receipt() });
    expect(m.rpc).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenCalledWith("work_unit_review_command", { p_command_id: COMMAND, p_protocol_version: 1,
      p_payload: expect.objectContaining({ basis: expect.objectContaining({ unitId: UNIT }),
        data: expect.objectContaining({ widthDecimal: "36.000000000000000001", heightDecimal: "72" }) }) });
  });
  it("checks live admission again after held session lookup, before any command RPC", async () => {
    const held = deferred<ReturnType<typeof session>>(); m.session.mockReturnValueOnce(held.promise); let admitted = true;
    const attempt = submitUnitReview(COMMAND, payload(), signInMark(), () => admitted);
    admitted = false; held.resolve(session());
    expect(await attempt).toEqual({ kind: "held" }); expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each(["network", "malformed", "foreign", "wrong action", "auth ABA", "preview"]) ("keeps delivery %s unknown without a second request", async kind => {
    const held = deferred<{ data: unknown; error: unknown }>(); m.rpc.mockReturnValueOnce(held.promise); let admitted = true;
    const attempt = submitUnitReview(COMMAND, payload(), signInMark(), () => admitted);
    await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    let data: unknown = receipt(), error: unknown = null;
    if (kind === "network") error = { code: "NETWORK" };
    if (kind === "malformed") data = { ...receipt(), qcAccepted: true };
    if (kind === "foreign") data = { ...receipt(), commandId: id(99) };
    if (kind === "wrong action") data = { ...receipt(), action: "pass" };
    if (kind === "auth ABA") { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); }
    if (kind === "preview") admitted = false;
    held.resolve({ data, error }); expect(await attempt).toEqual({ kind: "unknown" }); expect(m.rpc).toHaveBeenCalledOnce();
  });
  it("reports a known transactional refusal for this attempt without creating a receipt", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: "23514" } });
    expect(await submitUnitReview(COMMAND, payload(), signInMark(), () => true)).toEqual({ kind: "attempt_refused", sqlState: "23514" });
    const hostile = {}; Object.defineProperty(hostile, "code", { get() { throw Error("do not read"); } });
    m.rpc.mockResolvedValueOnce({ data: null, error: hostile });
    expect(await submitUnitReview(COMMAND, payload(), signInMark(), () => true)).toEqual({ kind: "unknown" });
  });
  it("rejects invalid intent before any lookup, UUID creation or RPC", async () => {
    const raw = payload(); raw.data.widthDecimal = ".5";
    await expect(submitUnitReview(COMMAND, raw, signInMark(), () => true)).rejects.toThrow();
    expect(m.session).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("receipt lookup remains read-only and unavailable does not mean failed delivery", async () => {
    const reply = { protocolVersion: 1, availability: "unavailable", receipt: null };
    m.rpc.mockResolvedValueOnce({ data: reply, error: null });
    expect(await fetchUnitReviewReceipt(COMMAND, signInMark())).toEqual(reply);
    expect(m.rpc).toHaveBeenCalledOnce(); expect(m.rpc).toHaveBeenCalledWith("work_unit_review_command_receipt", { p_command_id: COMMAND });
  });
  it("accepts a valid immutable receipt after connectivity drops, without claiming a current view", async () => {
    const held = deferred<{ data: unknown; error: null }>(); m.rpc.mockReturnValueOnce(held.promise);
    const attempt = submitUnitReview(COMMAND, payload(), signInMark(), () => true);
    await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); vi.stubGlobal("navigator", { onLine: false });
    held.resolve({ data: receipt(), error: null }); expect(await attempt).toEqual({ kind: "applied", receipt: receipt() });
    expect(m.rpc).toHaveBeenCalledOnce();
  });
});


describe("explicit permanent review cancellation transport", () => {
  it("uses the original UUID and full payload and accepts either race winner", async () => {
    const original = payload();
    const cancelled = { protocolVersion: 1, commandId: COMMAND, action: original.action, unitId: UNIT,
      recordedAt: AT, outcome: "cancelled", original };
    m.rpc.mockResolvedValueOnce({ data: cancelled, error: null });
    expect(await cancelUnitReview(COMMAND, original, signInMark(), () => true)).toMatchObject({ kind: "cancelled", receipt: { original: { data: { widthDecimal: "36.000000000000000001" } } } });
    expect(m.rpc).toHaveBeenCalledWith("work_unit_review_cancel", expect.objectContaining({ p_command_id: COMMAND }));
    m.rpc.mockResolvedValueOnce({ data: receipt(), error: null });
    expect(await cancelUnitReview(COMMAND, original, signInMark(), () => true)).toEqual({ kind: "applied", receipt: receipt() });
    m.rpc.mockResolvedValueOnce({ data: cancelled, error: null });
    expect(await submitUnitReview(COMMAND, original, signInMark(), () => true)).toMatchObject({ kind: "cancelled" });
  });
  it("keeps generic serialization, malformed cancellation and changed original unknown", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: "40001" } });
    expect(await cancelUnitReview(COMMAND, payload(), signInMark(), () => true)).toEqual({ kind: "unknown" });
    const original = payload(); original.data.sourceReference = "Another original";
    m.rpc.mockResolvedValueOnce({ data: { protocolVersion: 1, commandId: COMMAND, action: original.action, unitId: UNIT,
      recordedAt: AT, outcome: "cancelled", original }, error: null });
    expect(await cancelUnitReview(COMMAND, payload(), signInMark(), () => true)).toEqual({ kind: "unknown" });
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it("does not send across admission loss and does not confirm across owner ABA", async () => {
    expect(await cancelUnitReview(COMMAND, payload(), signInMark(), () => false)).toEqual({ kind: "held" });
    expect(m.rpc).not.toHaveBeenCalled();
    const wait = deferred<{ data: unknown; error: null }>(); m.rpc.mockReturnValueOnce(wait.promise);
    const cancelling = cancelUnitReview(COMMAND, payload(), signInMark(), () => true);
    await vi.waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } });
    wait.resolve({ data: receipt(), error: null }); expect(await cancelling).toEqual({ kind: "unknown" });
  });
});
