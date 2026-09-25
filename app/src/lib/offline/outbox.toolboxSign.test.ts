// Offline toolbox signing, the runtime half (2026-09-25): the real outbox
// module on its in-memory store (no IndexedDB under vitest), with the server
// stubbed. A talk signed with no signal is kept on the phone, the clock-in the
// person taps next waits behind it, and when signal comes back the server
// hears the signature FIRST and the clock-in second — each exactly once. A
// signature the server refuses keeps its clock-in on the phone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolboxSignPayload } from "../toolboxSign";

const rpc = vi.fn();
const upload = vi.fn();
vi.mock("../supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: (bucket: string) => ({ upload: (...args: unknown[]) => upload(bucket, ...args) }) },
  },
  supabaseConfigured: true,
}));
vi.mock("../signedIn", () => ({ signedInEmail: () => "e2e@example.test" }));
vi.mock("./telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("./outbox");

const ME = "2b1c9f0e-1111-4a2b-8c3d-000000000001";
const TALK = "7d0f3a2e-2222-4b3c-9d4e-000000000002";
let n = 0;
function signature(over: Partial<ToolboxSignPayload> = {}): ToolboxSignPayload {
  n += 1;
  const clientId = `0e9b8c7d-3333-4c4d-8e5f-${String(n).padStart(12, "0")}`;
  return {
    clientId,
    profileId: ME,
    talkId: TALK,
    talkDate: "2026-09-25",
    typedName: "Dana Reyes",
    signedAt: new Date().toISOString(),
    talkSnapshot: "{}",
    signaturePath: `${ME}/${TALK}/x-${clientId}-signature.png`,
    signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    pdfPath: `${ME}/${TALK}/x-${clientId}.pdf`,
    ...over,
  };
}
const PUNCH = {
  clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77",
  tappedAt: new Date().toISOString(),
  clockCheckedAt: null,
  clockSkewMs: null,
};
const PDF = new Blob(["%PDF-1.7"], { type: "application/pdf" });

const offline = () => Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
const online = () => Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

beforeEach(() => {
  rpc.mockReset();
  upload.mockReset();
  upload.mockResolvedValue({ data: {}, error: null });
});

afterEach(async () => {
  online();
  for (const e of await outbox.listAll()) await outbox.discardFailed(e.id);
});

describe("a signature made with no signal", () => {
  it("is kept on the phone with its PDF, listed for the gates, and nothing is sent", async () => {
    offline();
    const sig = signature();
    const id = await outbox.enqueueToolboxSign(sig, PDF);
    expect(id).toBe(sig.clientId);
    const [stored] = await outbox.listAll();
    expect(stored).toMatchObject({ id: sig.clientId, op: "toolbox_sign", status: "queued", hasBlob: true });
    expect(stored.payload).toMatchObject({ clientId: sig.clientId, profileId: ME, pdfPath: sig.pdfPath });
    expect(outbox.getToolboxQueueSnapshot().entries.map((e) => e.id)).toEqual([sig.clientId]);
    expect(outbox.todaysSignatureOnPhone(ME)?.entryId).toBe(sig.clientId);
    expect(outbox.getCounts().toolbox).toBe(1);
    expect(rpc).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("without a PDF, says so rather than naming a file that is not there", async () => {
    offline();
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, null);
    const [stored] = await outbox.listAll();
    expect(stored.hasBlob).toBe(false);
    expect(stored.payload.pdfPath).toBeNull();
  });

  it("handed over twice is still one entry", async () => {
    offline();
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, PDF);
    await outbox.enqueueToolboxSign(sig, PDF);
    expect((await outbox.listAll()).length).toBe(1);
  });
});

describe("the clock-in tapped after it", () => {
  it("waits for today's signature", async () => {
    offline();
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, PDF);
    const inId = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH, profileId: ME });
    const clockIn = (await outbox.listAll()).find((e) => e.id === inId)!;
    expect(clockIn.dependsOn).toBe(sig.clientId);
  });

  it("does not wait for somebody else's, or for yesterday's", async () => {
    offline();
    await outbox.enqueueToolboxSign(signature({ profileId: "someone-else" }), null);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await outbox.enqueueToolboxSign(signature({ signedAt: yesterday.toISOString() }), null);
    const inId = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH, profileId: ME });
    expect((await outbox.listAll()).find((e) => e.id === inId)!.dependsOn).toBeNull();
  });

  it("a switch behind a pending clock-in keeps waiting on that clock-in", async () => {
    offline();
    await outbox.enqueueToolboxSign(signature(), null);
    const firstIn = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH, profileId: ME });
    const switchIn = await outbox.enqueueClockIn({
      projectId: "p2",
      costCodeId: "cc1",
      punch: { ...PUNCH, clientId: "1b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b72" },
      profileId: ME,
      afterShiftRef: outbox.pendingRefForShift(firstIn),
    });
    expect((await outbox.listAll()).find((e) => e.id === switchIn)!.dependsOn).toBe(firstIn);
  });
});

describe("when signal comes back", () => {
  it("the server hears the signature first and the clock-in second, each exactly once", async () => {
    offline();
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, PDF);
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH, profileId: ME });

    const order: string[] = [];
    const row = { id: "completion-1", profile_id: ME, client_id: sig.clientId, signed_at: sig.signedAt };
    rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return fn === "sign_toolbox_talk"
        ? { data: row, error: null }
        : { data: { id: "shift-1", profile_id: ME, clock_in_at: PUNCH.tappedAt, status: "open" }, error: null };
    });
    const heard: unknown[] = [];
    const stop = outbox.subscribeToolboxSent((_e, r) => heard.push(r));
    try {
      online();
      await outbox.drain();
    } finally {
      stop();
    }

    expect(order).toEqual(["sign_toolbox_talk", "clock_in"]);
    expect(upload.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["toolbox-records", sig.signaturePath],
      ["toolbox-records", sig.pdfPath],
    ]);
    expect(heard).toEqual([row]);
    expect(await outbox.listAll()).toEqual([]);
    expect(outbox.todaysSignatureOnPhone(ME)).toBeNull();
    expect(outbox.recentlySent().slice(0, 2).map((s) => s.entry.op)).toEqual(["clock_in", "toolbox_sign"]);
  });

  it("a refused signature keeps the clock-in on the phone, unsent — and Try again sends both, in order", async () => {
    offline();
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, PDF);
    const inId = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH, profileId: ME });

    rpc.mockImplementation(async (fn: string) =>
      fn === "sign_toolbox_talk"
        ? { data: null, error: { code: "42501", message: "This toolbox talk signature belongs to someone else on this phone." } }
        : { data: { id: "shift-1" }, error: null },
    );
    online();
    await outbox.drain();

    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["sign_toolbox_talk"]);
    const byId = new Map((await outbox.listAll()).map((e) => [e.id, e]));
    expect(byId.get(sig.clientId)?.status).toBe("failed");
    expect(byId.get(inId)?.status).toBe("queued");
    expect(byId.get(inId)?.lastError).toBeNull();
    // Still counts as signed on this phone — refused, and saying so.
    expect(outbox.todaysSignatureOnPhone(ME)).toMatchObject({ status: "failed" });
    expect(outbox.getCounts()).toMatchObject({ clock: 1, deadLetter: 1 });

    rpc.mockReset();
    const order: string[] = [];
    rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return { data: { id: fn === "clock_in" ? "shift-1" : "completion-1" }, error: null };
    });
    await outbox.retryFailed(sig.clientId);
    await vi.waitFor(async () => expect((await outbox.listAll()).length).toBe(0));
    expect(order).toEqual(["sign_toolbox_talk", "clock_in"]);
  });
});
