// The toolbox_sign outbox handler (offline toolbox signing, 2026-09-25): a
// talk signed with no signal, sent from the queue. Its promise is that sending
// it twice — a reply lost to a dead zone, a reload mid-send — is ONE signature
// and one pair of files, so every call it makes is keyed by the signature's
// client id: the files go to paths made from it, with upsert, and the row goes
// through sign_toolbox_talk, which answers a repeat with the row it made. Same
// mocking idiom as receiptOutbox.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainStore, isRetryableError, SendTookTooLongError, type OutboxEntry } from "./outbox-core";
import { MemoryOutboxStore } from "./outboxStore";

const storageUpload = vi.fn();
const rpc = vi.fn();
const lookup = vi.fn();
const insert = vi.fn();

vi.mock("../supabase", () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, body: unknown, opts: Record<string, unknown>) => storageUpload(bucket, path, body, opts),
      }),
    },
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (c1: string, v1: string) => ({
          eq: (c2: string, v2: string) => ({
            limit: () => ({ maybeSingle: () => lookup(table, cols, { [c1]: v1, [c2]: v2 }) }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: () => insert(table, row) }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => rpc(fn, args),
  },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

const ME = "2b1c9f0e-1111-4a2b-8c3d-000000000001";
const TALK = "7d0f3a2e-2222-4b3c-9d4e-000000000002";
const CLIENT = "0e9b8c7d-3333-4c4d-8e5f-000000000003";
const SIG_PATH = `${ME}/${TALK}/2026-09-25-${CLIENT}-signature.png`;
const PDF_PATH = `${ME}/${TALK}/2026-09-25-${CLIENT}.pdf`;
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const PDF = new Blob(["%PDF-1.7 signed"], { type: "application/pdf" });
const SIGNED_AT = "2026-09-25T13:02:11.000Z";

const PAYLOAD = {
  clientId: CLIENT,
  profileId: ME,
  talkId: TALK,
  talkDate: "2026-09-25",
  typedName: "Dana Reyes",
  signedAt: SIGNED_AT,
  talkSnapshot: '{"id":"t","title":"Ladders"}',
  signaturePath: SIG_PATH,
  signatureDataUrl: PNG,
  pdfPath: PDF_PATH,
};

function entry(payload: Record<string, unknown> = PAYLOAD, hasBlob = true): OutboxEntry {
  return {
    id: CLIENT,
    op: "toolbox_sign",
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob,
  };
}

async function send(e: OutboxEntry = entry(), opts: { blob?: Blob | null; signal?: AbortSignal } = {}): Promise<unknown> {
  const handler = handlers.toolbox_sign;
  if (!handler) throw new Error("no toolbox_sign handler is registered");
  return handler(e, { getBlob: async () => (opts.blob === undefined ? PDF : opts.blob), signal: opts.signal });
}

/** A server that behaves like sign_toolbox_talk: one row per (signer, client id). */
function idempotentServer() {
  const rows = new Map<string, Record<string, unknown>>();
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "sign_toolbox_talk") return { data: null, error: { message: `unexpected ${fn}` } };
    const key = `${args.p_profile_id}:${args.p_client_id}`;
    if (!rows.has(key)) {
      rows.set(key, { id: `row-${rows.size + 1}`, profile_id: args.p_profile_id, client_id: args.p_client_id, signed_at: args.p_signed_at });
    }
    return { data: rows.get(key), error: null };
  });
  return rows;
}

beforeEach(() => {
  storageUpload.mockReset();
  storageUpload.mockResolvedValue({ data: { path: "x" }, error: null });
  rpc.mockReset();
  lookup.mockReset();
  insert.mockReset();
});

describe("sending a signature from the queue", () => {
  it("puts the signature and the PDF at paths made from the client id, with upsert, then files the row", async () => {
    const rows = idempotentServer();
    const result = await send();

    expect(storageUpload).toHaveBeenCalledTimes(2);
    const [sigCall, pdfCall] = storageUpload.mock.calls;
    expect(sigCall[0]).toBe("toolbox-records");
    expect(sigCall[1]).toBe(SIG_PATH);
    expect(Array.from(sigCall[2] as Uint8Array).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(sigCall[3]).toEqual({ contentType: "image/png", upsert: true });
    expect(pdfCall[0]).toBe("toolbox-records");
    expect(pdfCall[1]).toBe(PDF_PATH);
    expect(pdfCall[2]).toBe(PDF);
    expect(pdfCall[3]).toEqual({ contentType: "application/pdf", upsert: true });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sign_toolbox_talk", {
      p_client_id: CLIENT,
      p_profile_id: ME,
      p_talk_id: TALK,
      p_typed_name: "Dana Reyes",
      p_signature_path: SIG_PATH,
      p_pdf_path: PDF_PATH,
      p_talk_snapshot: '{"id":"t","title":"Ladders"}',
      p_signed_at: SIGNED_AT,
    });
    // The row the server made, handed to onSent so the screens can show it.
    expect(result).toEqual(rows.get(`${ME}:${CLIENT}`));
  });

  it("is ONE signature when it is sent twice — same files, same client id, one row", async () => {
    const rows = idempotentServer();
    const first = await send();
    // The reply was lost; the queue sends the very same entry again.
    const second = await send();
    expect(rows.size).toBe(1);
    expect(second).toEqual(first);
    expect(storageUpload.mock.calls.slice(2)).toEqual(storageUpload.mock.calls.slice(0, 2));
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it("files a signature whose PDF could not be built on the phone, without one", async () => {
    idempotentServer();
    await send(entry({ ...PAYLOAD, pdfPath: null }, false), { blob: null });
    expect(storageUpload).toHaveBeenCalledTimes(1);
    expect(storageUpload.mock.calls[0][1]).toBe(SIG_PATH);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_pdf_path: null });
  });

  it("files the row with no PDF when the PDF went missing from the phone's store", async () => {
    idempotentServer();
    await send(entry(), { blob: null });
    expect(storageUpload).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_pdf_path: null });
  });
});

describe("what it will not send", () => {
  for (const missing of ["clientId", "profileId", "signaturePath", "signatureDataUrl", "typedName"] as const) {
    it(`an entry saved without its ${missing} is refused for good, and nothing goes out`, async () => {
      idempotentServer();
      const bad = entry({ ...PAYLOAD, [missing]: null });
      const err = await send(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isRetryableError(err)).toBe(false);
      expect(storageUpload).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  }

  it("stops before filing the row when the drain stopped waiting during the upload", async () => {
    idempotentServer();
    const abort = new AbortController();
    storageUpload.mockImplementation(async () => {
      abort.abort();
      return { data: {}, error: null };
    });
    await expect(send(entry(), { signal: abort.signal })).rejects.toBeInstanceOf(SendTookTooLongError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("what Forge answers", () => {
  it("a refusal (someone else's signature) is final and says so in Forge's words", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "This toolbox talk signature belongs to someone else on this phone. Sign in as the person who signed it to send it." },
    });
    const err = await send().catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(false);
    expect((err as { message: string }).message).toContain("belongs to someone else");
  });

  it("no signal during the upload is retried, and the row is not filed", async () => {
    storageUpload.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await send().catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a storage refusal comes back as the upload's own error", async () => {
    storageUpload.mockResolvedValueOnce({ data: null, error: { message: "new row violates row-level security policy" } });
    const err = await send().catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// Codex review of #666 (2026-09-27), finding 3: the old-database fallback
// (look the row up by its signature file, then insert it) was two steps with
// nothing unique behind them, so an attempt the watchdog had given up on
// could wake after its retry had filed the row and file it again. The
// fallback is gone: sign_toolbox_talk ships in the same change, and a
// signature waits on the phone — keyed, retried — until Forge has it.
/** PostgREST's answer while the function has not reached the database. */
const MISSING = { code: "PGRST202", message: "Could not find the function public.sign_toolbox_talk(...) in the schema cache" };

describe("a database that has not got sign_toolbox_talk yet", () => {
  it("keeps the signature on the phone to try again, and writes nothing around the keyed call", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Retried with the ordinary backoff, not given up on the first try …
    expect(isRetryableError(err)).toBe(true);
    // … said in plain words on Stuck writes if it ever runs out of tries …
    expect((err as Error).message).toMatch(/safe on this phone/);
    expect((err as Error).message).not.toMatch(/schema cache|PGRST/);
    // … and never filed some other way.
    expect(lookup).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("is sent by the first retry after the function reaches the database, once", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry());
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    const first = await drainStore(store, handlers, { now: 0 });
    expect(first).toMatchObject({ sent: 0, retried: 1 });
    const rows = idempotentServer();
    const second = await drainStore(store, handlers, { now: 10 * 60_000 });
    expect(second.sent).toBe(1);
    expect(rows.size).toBe(1);
    expect(await store.getAll()).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });
});

// Codex's reproduction, as written against the fallback: the function is
// missing throughout, the first attempt's lookup stalls past the watchdog,
// the retry files the row, and the stalled attempt wakes and files it again.
// Realistic lookup and insert stubs, so a fallback would duplicate here.
describe("Codex's fallback race (the function missing throughout)", () => {
  it("files nothing twice — nothing is filed around the keyed call at all", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    const rows: Record<string, unknown>[] = [];
    let lookups = 0;
    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    lookup.mockImplementation(async (_t: string, _c: string, where: Record<string, string>) => {
      // Answered by the database when the request arrives; only the reply is
      // late — the way a dead zone delays one.
      const found = rows.find((r) => r.signature_path === where.signature_path) ?? null;
      if (++lookups === 1) await stalled;
      return { data: found, error: null };
    });
    insert.mockImplementation(async (_t: string, row: Record<string, unknown>) => {
      rows.push(row);
      return { data: { id: rows.length, ...row }, error: null };
    });
    const store = new MemoryOutboxStore();
    await store.put(entry({ ...PAYLOAD, pdfPath: null }, false));

    await drainStore(store, handlers, { now: 0, sendDeadlineMs: () => 30 });
    await drainStore(store, handlers, { now: 1_000_000, sendDeadlineMs: () => 1_000 });
    release();
    await new Promise((r) => setTimeout(r, 20));

    expect(rows).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
    // Still on the phone, waiting for the function — not lost, not doubled.
    const [left] = await store.getAll();
    expect(left).toMatchObject({ id: CLIENT, status: "queued" });
    expect(left.lastError).toMatch(/safe on this phone/);
  });
});

// The watchdog replay, on the real drain and the real handler: the first
// attempt's keyed call stops answering, the drain gives up on it and the
// retry files the signature; then the first attempt wakes. It must not file
// anything a second time — the keyed call answers a repeat of the client id
// with the row it already made, and there is no other write left to make.
describe("a send the watchdog gave up on, waking after its retry", () => {
  it("files one signature, whether the old call wakes with the row or with the missing function", async () => {
    const rows = idempotentServer();
    const answer = rpc.getMockImplementation()!;
    let wakeOld!: (v: unknown) => void;
    const oldCall = new Promise((r) => (wakeOld = r));
    rpc.mockImplementationOnce(() => oldCall);
    const store = new MemoryOutboxStore();
    await store.put(entry({ ...PAYLOAD, pdfPath: null }, false));

    const first = await drainStore(store, handlers, { now: 0, sendDeadlineMs: () => 30 });
    expect(first).toMatchObject({ sent: 0, retried: 1 });
    const second = await drainStore(store, handlers, { now: 10 * 60_000, sendDeadlineMs: () => 1_000 });
    expect(second.sent).toBe(1);
    expect(rows.size).toBe(1);

    // The first attempt wakes with the missing function …
    wakeOld({ data: null, error: MISSING });
    await new Promise((r) => setTimeout(r, 20));
    expect(rows.size).toBe(1);
    expect(insert).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    // … and a replay of the whole send (a reload mid-send) is still that one row.
    await answer("sign_toolbox_talk", { p_profile_id: ME, p_client_id: CLIENT });
    await send(entry({ ...PAYLOAD, pdfPath: null }, false), { blob: null });
    expect(rows.size).toBe(1);
    expect(await store.getAll()).toEqual([]);
  });
});
