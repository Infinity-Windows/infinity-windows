// The toolbox_sign outbox handler (offline toolbox signing, 2026-09-25): a
// talk signed with no signal, sent from the queue. Its promise is that sending
// it twice — a reply lost to a dead zone, a reload mid-send — is ONE signature
// and one pair of files, so every call it makes is keyed by the signature's
// client id: the files go to paths made from it, with upsert, and the row goes
// through sign_toolbox_talk, which answers a repeat with the row it made. Same
// mocking idiom as receiptOutbox.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError, SendTookTooLongError, type OutboxEntry } from "./outbox-core";

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

describe("a database that has not got sign_toolbox_talk yet", () => {
  const MISSING = { code: "PGRST202", message: "Could not find the function public.sign_toolbox_talk(...) in the schema cache" };

  it("files the row the way the app did before, once — a resend finds it by its signature file", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    const stored: Record<string, unknown>[] = [];
    lookup.mockImplementation(async (_table: string, _cols: string, where: Record<string, string>) => ({
      data: stored.find((r) => r.profile_id === where.profile_id && r.signature_path === where.signature_path) ?? null,
      error: null,
    }));
    insert.mockImplementation(async (_table: string, row: Record<string, unknown>) => {
      const made = { id: `row-${stored.length + 1}`, ...row };
      stored.push(made);
      return { data: made, error: null };
    });

    const first = await send();
    const second = await send();
    expect(stored).toHaveLength(1);
    expect(second).toEqual(first);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]).toEqual([
      "toolbox_completions",
      {
        talk_id: TALK,
        profile_id: ME,
        typed_name: "Dana Reyes",
        signature_path: SIG_PATH,
        pdf_path: PDF_PATH,
        talk_snapshot: '{"id":"t","title":"Ladders"}',
        signed_at: SIGNED_AT,
      },
    ]);
  });

  it("keeps trying when that lookup could not be asked, rather than inserting blind", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    lookup.mockResolvedValue({ data: null, error: new TypeError("Failed to fetch") });
    const err = await send().catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });
});
