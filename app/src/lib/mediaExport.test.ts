import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A recording stand-in for the Supabase client: every query's chained calls
// are kept so tests can assert the exact (RLS-scoped, unchanged) read shape,
// and storage signing mints a new token each time so freshness is visible.
const db = vi.hoisted(() => {
  type Op = [string, unknown[]];
  type Query = { table: string; ops: Op[] };
  const state = {
    queries: [] as Query[],
    respond: (_q: Query): { data: unknown; error: unknown } => ({ data: [], error: null }),
    signed: [] as { bucket: string; path: string; ttl: number }[],
    signFail: new Set<string>(),
    mint: 0,
  };
  function from(table: string) {
    const q: Query = { table, ops: [] };
    state.queries.push(q);
    const builder: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => state.respond(q))
                .then(ok, bad);
          }
          return (...args: unknown[]) => {
            q.ops.push([String(prop), args]);
            return builder;
          };
        },
      },
    );
    return builder;
  }
  const supabase = {
    from,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          state.signed.push({ bucket, path, ttl });
          if (state.signFail.has(path)) return { data: null, error: { message: "denied" } };
          state.mint += 1;
          return {
            data: { signedUrl: `https://storage.test/${bucket}/${path}?token=${state.mint}` },
            error: null,
          };
        },
      }),
    },
  };
  return { state, supabase };
});

vi.mock("./supabase", () => ({ supabase: db.supabase }));

import {
  canShareMediaFiles,
  inferMediaType,
  isMediaShareCancel,
  listMediaExportItems,
  MediaExportDataError,
  mediaExportName,
  mediaExportRangeError,
  mediaExportWindow,
  mediaExportZip,
  mediaLocalDay,
  prepareMediaExport,
  shareMediaFiles,
  type MediaExportItem,
} from "./mediaExport";
import { EXPORT_MAX_ROWS } from "./photos";
import { listReceipts } from "./receipts";

type Op = [string, unknown[]];

function serve(rows: unknown[]) {
  db.state.respond = (q) => {
    const range = q.ops.find((o) => o[0] === "range");
    const [a, b] = range ? (range[1] as number[]) : [0, rows.length - 1];
    return { data: rows.slice(a, b + 1), error: null };
  };
}

function photoRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `p${String(i).padStart(5, "0")}`,
    storage_path: `install-media/photos/p${i}.jpg`,
    created_at: "2026-10-06T18:00:00Z",
    taken_at: null,
    project_id: "job1",
    ...over,
  };
}

function receiptRow(i: number, over: Record<string, unknown> = {}) {
  const id = `r${String(i).padStart(5, "0")}`;
  return {
    id,
    uploaded_by: "u1",
    project_id: "job1",
    pending_job_name: null,
    photo_path: `install-media/receipts/${id}.jpg`,
    amount_cents: 100,
    vendor: "Shell",
    purchased_on: "2026-10-06",
    category: null,
    category_by: null,
    is_passthrough: null,
    note: null,
    ocr: null,
    created_at: "2026-10-06T18:00:00Z",
    reviewed_by: null,
    reviewed_at: null,
    cost_code_id: null,
    job_cost_id: null,
    document_path: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    profiles: { display_name: "Taylor" },
    ...over,
  };
}

function item(over: Partial<MediaExportItem> = {}): MediaExportItem {
  return {
    id: "p1",
    projectId: "job1",
    date: "2026-10-06",
    label: "2026-10-06",
    storagePath: "install-media/photos/p1.jpg",
    documentPath: null,
    kind: "photo",
    jobCode: null,
    ...over,
  };
}

type FetchHandler = (url: string) => Response | Promise<Response>;
let onFetch: FetchHandler;
const fetchMock = vi.fn((url: string) => Promise.resolve().then(() => onFetch(url)));

const bytes = (n: number, type = "image/jpeg") =>
  new Response(new Uint8Array(n).fill(7), { headers: { "content-type": type } });

beforeEach(() => {
  db.state.queries = [];
  db.state.signed = [];
  db.state.signFail = new Set();
  db.state.respond = () => ({ data: [], error: null });
  onFetch = () => bytes(4);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mediaExportRangeError", () => {
  it("treats two empty dates as all time and one empty date as incomplete", () => {
    expect(mediaExportRangeError("", "")).toBeNull();
    expect(mediaExportRangeError("2026-10-01", "")).toBe("range_incomplete");
    expect(mediaExportRangeError("", "2026-10-01")).toBe("range_incomplete");
  });

  it("rejects days that are not real calendar days or not strict YYYY-MM-DD", () => {
    expect(mediaExportRangeError("2026-02-30", "2026-03-01")).toBe("range_invalid");
    expect(mediaExportRangeError("2025-02-29", "2025-03-01")).toBe("range_invalid");
    expect(mediaExportRangeError("2026-13-01", "2026-13-02")).toBe("range_invalid");
    expect(mediaExportRangeError("2026-1-05", "2026-01-06")).toBe("range_invalid");
    expect(mediaExportRangeError("2026-10-06T00:00", "2026-10-07")).toBe("range_invalid");
    expect(mediaExportRangeError("2024-02-29", "2024-02-29")).toBeNull();
  });

  it("requires from <= through, inclusive of a single day", () => {
    expect(mediaExportRangeError("2026-10-07", "2026-10-06")).toBe("range_order");
    expect(mediaExportRangeError("2026-10-06", "2026-10-06")).toBeNull();
  });
});

describe("mediaLocalDay / mediaExportWindow", () => {
  it("assigns instants to the local calendar day across both DST changes", () => {
    const tz = "America/Denver";
    // Spring forward 2026-03-08 02:00 MST (09:00Z).
    expect(mediaLocalDay("2026-03-08T06:30:00Z", tz)).toBe("2026-03-07");
    expect(mediaLocalDay("2026-03-08T08:30:00Z", tz)).toBe("2026-03-08");
    // Fall back 2026-11-01 02:00 MDT (08:00Z).
    expect(mediaLocalDay("2026-11-01T05:30:00Z", tz)).toBe("2026-10-31");
    expect(mediaLocalDay("2026-11-01T06:30:00Z", tz)).toBe("2026-11-01");
    expect(mediaLocalDay("not a date", tz)).toBeNull();
    expect(mediaLocalDay(null, tz)).toBeNull();
  });

  it("builds a server window that covers the range as local days in any zone", () => {
    const w = mediaExportWindow("2026-10-06", "2026-10-06");
    expect(w.fromDay).toBe("2026-10-06");
    expect(w.throughDay).toBe("2026-10-06");
    // UTC+14 starts the day at 10:00Z the day before; UTC-12 ends it at 12:00Z the day after.
    expect(w.since <= "2026-10-05T10:00:00.000Z").toBe(true);
    expect(w.before >= "2026-10-07T12:00:00.000Z").toBe(true);
  });
});

describe("listMediaExportItems — photos", () => {
  it("pages past 500 in a stable created_at/id order, scoped like the feed, without signing", async () => {
    serve(Array.from({ length: 1203 }, (_, i) => photoRow(i)));
    const items = await listMediaExportItems(
      { kind: "photo", projectId: "job1", fromDate: "", throughDate: "" },
      "UTC",
    );
    expect(items).toHaveLength(1203);
    expect(db.state.queries.map((q) => q.ops.find((o) => o[0] === "range")?.[1])).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
    const ops = db.state.queries[0].ops;
    expect(db.state.queries[0].table).toBe("attachments");
    expect(ops).toContainEqual(["eq", ["kind", "photo"]]);
    expect(ops).toContainEqual(["is", ["deleted_at", null]]);
    expect(ops).toContainEqual(["not", ["storage_path", "like", "install-media/receipts/%"]]);
    expect(ops).toContainEqual(["not", ["storage_path", "like", "receipts/%"]]);
    expect(ops.findIndex((o) => o[0] === "not")).toBeLessThan(ops.findIndex((o) => o[0] === "range"));
    expect(ops).toContainEqual(["eq", ["project_id", "job1"]]);
    expect(ops.filter((o) => o[0] === "order")).toEqual([
      ["order", ["created_at", { ascending: false }]],
      ["order", ["id", { ascending: false }]],
    ]);
    expect(ops.some((o) => o[0] === "or")).toBe(false);
    expect(db.state.signed).toEqual([]);
    expect(items[0]).toMatchObject({
      kind: "photo",
      documentPath: null,
      date: "2026-10-06",
      storagePath: "install-media/photos/p0.jpg",
    });
  });

  it("rejects known receipt paths even when a stale server response returns photo-kind rows", async () => {
    serve([
      photoRow(1),
      photoRow(2, { storage_path: "install-media/receipts/r2.jpg" }),
      photoRow(3, { storage_path: "receipts/r3.jpg" }),
      photoRow(4, { storage_path: "install-media/photos/receipt-note.jpg" }),
    ]);
    const items = await listMediaExportItems({ kind: "photo", projectId: "job1", fromDate: "", throughDate: "" });
    expect(items.map((p) => p.storagePath)).toEqual([
      "install-media/photos/p1.jpg",
      "install-media/photos/receipt-note.jpg",
    ]);
    expect(db.state.queries.every((q) => q.table === "attachments")).toBe(true);
    expect(db.state.queries[0].ops).toContainEqual(["eq", ["project_id", "job1"]]);
    expect(db.state.signed).toEqual([]);
  });

  it("leaves the job filter off for all jobs (RLS alone decides)", async () => {
    serve([photoRow(1)]);
    await listMediaExportItems({ kind: "photo", projectId: null, fromDate: "", throughDate: "" });
    expect(db.state.queries[0].ops.some((o) => o[0] === "eq" && (o[1] as unknown[])[0] === "project_id")).toBe(false);
  });

  it("returns exactly the cap, but refuses one more instead of truncating", async () => {
    serve(Array.from({ length: EXPORT_MAX_ROWS }, (_, i) => photoRow(i)));
    const all = await listMediaExportItems({ kind: "photo", projectId: null, fromDate: "", throughDate: "" });
    expect(all).toHaveLength(EXPORT_MAX_ROWS);

    serve(Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => photoRow(i)));
    const err = await listMediaExportItems({
      kind: "photo",
      projectId: null,
      fromDate: "",
      throughDate: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaExportDataError);
    expect((err as MediaExportDataError).code).toBe("too_many");
  });

  it("fails closed on a database without the job/trash columns — no all-jobs fallback", async () => {
    db.state.respond = () => ({
      data: null,
      error: { code: "42703", message: "column attachments.deleted_at does not exist" },
    });
    const err = await listMediaExportItems({
      kind: "photo",
      projectId: "job1",
      fromDate: "",
      throughDate: "",
    }).catch((e: unknown) => e);
    expect((err as MediaExportDataError).code).toBe("schema_missing");
    expect(db.state.queries).toHaveLength(1);
  });

  it("filters by local capture day (taken_at, else created_at), prefiltered on the server", async () => {
    serve([
      // Oct 6 21:00 MDT — inside.
      photoRow(1, { taken_at: "2026-10-07T03:00:00Z", created_at: "2026-10-09T00:00:00Z" }),
      // No capture time; Oct 5 23:00 MDT — outside.
      photoRow(2, { created_at: "2026-10-06T05:00:00Z" }),
      // Taken Oct 4 local, uploaded Oct 6 — capture day wins, outside.
      photoRow(3, { taken_at: "2026-10-04T18:00:00Z", created_at: "2026-10-06T18:00:00Z" }),
      // No capture time; Oct 6 12:00 MDT — inside.
      photoRow(4, { created_at: "2026-10-06T18:00:00Z" }),
    ]);
    const items = await listMediaExportItems(
      { kind: "photo", projectId: "job1", fromDate: "2026-10-06", throughDate: "2026-10-06" },
      "America/Denver",
    );
    expect(items.map((i) => i.id)).toEqual(["p00001", "p00004"]);
    expect(items.every((i) => i.date === "2026-10-06")).toBe(true);
    const or = db.state.queries[0].ops.find((o) => o[0] === "or") as Op;
    expect(String(or[1][0])).toContain("taken_at.is.null");
  });

  it("rejects a bad range before reading anything", async () => {
    const err = await listMediaExportItems({
      kind: "photo",
      projectId: null,
      fromDate: "2026-02-30",
      throughDate: "2026-03-02",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toBe("range_invalid");
    expect(db.state.queries).toHaveLength(0);
  });
});

describe("listMediaExportItems — receipts", () => {
  it("pages past 500 receipts with the office read, unsigned, carrying job and PDF", async () => {
    serve(
      Array.from({ length: 501 }, (_, i) =>
        receiptRow(i, i === 0 ? { document_path: "install-media/receipts/r00000.pdf" } : {}),
      ),
    );
    const items = await listMediaExportItems(
      { kind: "receipt", projectId: "job1", fromDate: "", throughDate: "" },
      "UTC",
    );
    expect(items).toHaveLength(501);
    expect(db.state.queries).toHaveLength(2);
    expect(db.state.queries[0].table).toBe("receipts");
    expect(db.state.queries[0].ops).toContainEqual(["eq", ["project_id", "job1"]]);
    expect(db.state.signed).toEqual([]);
    expect(items[0]).toMatchObject({
      id: "r00000",
      kind: "receipt",
      jobCode: "BLACK22",
      storagePath: "install-media/receipts/r00000.jpg",
      documentPath: "install-media/receipts/r00000.pdf",
      label: "Shell · 2026-10-06",
    });
  });

  it("keeps a bare purchase date literal and falls back to the created_at local day", async () => {
    serve([
      // Purchased Oct 6, filed days later — the purchase date rules, unshifted.
      receiptRow(1, { purchased_on: "2026-10-06", created_at: "2026-10-09T03:00:00Z" }),
      // No purchase date; created Oct 6 21:00 MDT — inside.
      receiptRow(2, { purchased_on: null, created_at: "2026-10-07T03:00:00Z" }),
      // Purchased Oct 7 — outside even though filed on Oct 6.
      receiptRow(3, { purchased_on: "2026-10-07", created_at: "2026-10-06T18:00:00Z" }),
    ]);
    const items = await listMediaExportItems(
      { kind: "receipt", projectId: null, fromDate: "2026-10-01", throughDate: "2026-10-06" },
      "America/Denver",
    );
    expect(items.map((i) => [i.id, i.date])).toEqual([
      ["r00001", "2026-10-06"],
      ["r00002", "2026-10-06"],
    ]);
    const or = db.state.queries[0].ops.find((o) => o[0] === "or") as Op;
    expect(String(or[1][0])).toContain("purchased_on.gte.2026-10-01,purchased_on.lte.2026-10-06");
  });
});

describe("prepareMediaExport", () => {
  it("mints a fresh signed URL on every prepare — nothing cached", async () => {
    const urls: string[] = [];
    onFetch = (url) => {
      urls.push(url);
      return bytes(3);
    };
    await prepareMediaExport([item()]);
    await prepareMediaExport([item()]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("carries a receipt's original PDF via the id-checked ten-minute link, with page1/PDF names", async () => {
    onFetch = (url) => (url.includes(".pdf") ? bytes(5, "application/pdf") : bytes(3));
    const receipt = item({
      id: "r1",
      kind: "receipt",
      jobCode: "BLACK 22/A",
      storagePath: "install-media/receipts/r1.jpg",
      documentPath: "install-media/receipts/r1.pdf",
    });
    const res = await prepareMediaExport([receipt]);
    expect(res.failed).toEqual([]);
    expect(res.files.map((f) => [f.name, f.type, f.size])).toEqual([
      ["receipt_BLACK-22-A_2026-10-06_r1_page1.jpg", "image/jpeg", 3],
      ["receipt_BLACK-22-A_2026-10-06_r1.pdf", "application/pdf", 5],
    ]);
    expect(db.state.signed).toContainEqual({ bucket: "install-media", path: "receipts/r1.pdf", ttl: 600 });
  });

  it("keeps the image but reports the PDF when its stored path is not the receipt's own", async () => {
    const res = await prepareMediaExport([
      item({ id: "r1", kind: "receipt", storagePath: "install-media/receipts/r1.jpg", documentPath: "other/x.pdf" }),
    ]);
    expect(res.files).toHaveLength(1);
    expect(res.failed).toEqual([{ id: "r1", label: "2026-10-06", reason: "pdf_sign_failed" }]);
    expect(db.state.signed.some((s) => s.path === "x.pdf")).toBe(false);
  });

  it("reports HTTP, network, signing and empty-body failures per row and keeps the rest", async () => {
    db.state.signFail.add("photos/sign.jpg");
    onFetch = (url) => {
      if (url.includes("missing")) return new Response("no", { status: 404 });
      if (url.includes("offline")) throw new TypeError("Failed to fetch");
      if (url.includes("blank")) return new Response(new Uint8Array(0));
      return bytes(2);
    };
    const res = await prepareMediaExport([
      item({ id: "a", storagePath: "install-media/photos/ok.jpg" }),
      item({ id: "b", storagePath: "install-media/photos/missing.jpg" }),
      item({ id: "c", storagePath: "install-media/photos/offline.jpg" }),
      item({ id: "d", storagePath: "install-media/photos/sign.jpg" }),
      item({ id: "e", storagePath: "install-media/photos/blank.jpg" }),
    ]);
    expect(res.files.map((f) => f.name)).toEqual(["photo_2026-10-06_a.jpg"]);
    expect(res.failed.map((f) => [f.id, f.reason])).toEqual([
      ["b", "http_404"],
      ["c", "network"],
      ["d", "sign_failed"],
      ["e", "empty"],
    ]);
  });

  it("names files deterministically in item order and never overwrites a duplicate id", async () => {
    onFetch = async (url) => {
      // The first item finishes last; the order and names must not care.
      if (url.includes("slow")) await new Promise((r) => setTimeout(r, 20));
      return bytes(1);
    };
    const res = await prepareMediaExport([
      item({ id: "dup", storagePath: "install-media/photos/slow.jpg" }),
      item({ id: "dup", storagePath: "install-media/photos/fast.png" }),
      item({ id: "dup", storagePath: "install-media/photos/fast.jpeg" }),
    ]);
    expect(res.files.map((f) => [f.name, f.type])).toEqual([
      ["photo_2026-10-06_dup.jpg", "image/jpeg"],
      ["photo_2026-10-06_dup.png", "image/png"],
      ["photo_2026-10-06_dup-2.jpg", "image/jpeg"],
    ]);
  });

  it("fetches at most three at a time and reports progress to the end", async () => {
    let inFlight = 0;
    let peak = 0;
    onFetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return bytes(1);
    };
    const progress: [number, number][] = [];
    const res = await prepareMediaExport(
      Array.from({ length: 10 }, (_, i) => item({ id: `p${i}` })),
      (d, t) => progress.push([d, t]),
    );
    expect(res.files).toHaveLength(10);
    expect(peak).toBe(3);
    expect(progress[0]).toEqual([0, 10]);
    expect(progress.at(-1)).toEqual([10, 10]);
  });

  it("stops at the byte cap and reports the rest as too_large", async () => {
    onFetch = () => bytes(6);
    const res = await prepareMediaExport(
      [item({ id: "a" }), item({ id: "b" }), item({ id: "c" }), item({ id: "d" })],
      undefined,
      { maxBytes: 10 },
    );
    expect(res.files).toHaveLength(1);
    expect(res.failed).toHaveLength(3);
    expect(res.failed.every((f) => f.reason === "too_large")).toBe(true);
  });

  it("refuses a declared oversize body without reading it", async () => {
    const blob = vi.fn();
    onFetch = () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "999999", "content-type": "image/jpeg" }),
        body: null,
        blob,
      }) as unknown as Response;
    const res = await prepareMediaExport([item()], undefined, { maxBytes: 100 });
    expect(res.files).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual(["too_large"]);
    expect(blob).not.toHaveBeenCalled();
  });

  it("marks everything aborted once the signal fires, fetching nothing", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const res = await prepareMediaExport([item({ id: "a" }), item({ id: "b" })], undefined, {
      signal: ctl.signal,
    });
    expect(res.files).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual(["aborted", "aborted"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("export integrity regressions", () => {
  it("preserves signing of the first existing receipt feed row", async () => {
    serve([receiptRow(1)]);
    const rows = await listReceipts();
    expect(rows[0].signedUrl).toContain("token=");
    expect(db.state.signed).toHaveLength(1);
  });
  it("keeps an available original PDF when its receipt preview fails", async () => {
    onFetch = url => url.includes(".pdf") ? bytes(5, "application/pdf") : new Response("missing", { status: 404 });
    const result = await prepareMediaExport([item({ id: "r1", kind: "receipt", storagePath: "install-media/receipts/r1.jpg", documentPath: "install-media/receipts/r1.pdf" })]);
    expect(result.files.map(f => f.name)).toEqual(["receipt_2026-10-06_r1.pdf"]);
    expect(result.failed.map(f => f.reason)).toEqual(["http_404"]);
  });
  it("cancels an unknown-length stream at the export cap before buffering its full body", async () => {
    let pulls = 0; let canceled = false;
    onFetch = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls <= 100) controller.enqueue(new Uint8Array(3)); else controller.close(); },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "image/jpeg" } });
    const result = await prepareMediaExport([item()], undefined, { maxBytes: 4 });
    expect(result.files).toEqual([]);
    expect(result.failed[0].reason).toBe("too_large");
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThan(5);
  });
});

describe("stalled export cancellation", () => {
  it("times out signing, and ignores a signed URL that arrives after its deadline", async () => {
    let finish!: (result: { data: { signedUrl: string }; error: null }) => void;
    const spy = vi.spyOn(db.supabase.storage, "from").mockImplementation(() => ({ createSignedUrl: () => new Promise(resolve => { finish = resolve; }) }));
    try {
      const result = await prepareMediaExport([item()], undefined, { timeoutMs: 5 });
      expect(result.failed[0].reason).toBe("timeout");
      finish({ data: { signedUrl: "https://storage.test/late.jpg" }, error: null });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.files).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it("user abort settles a signing promise that never responds", async () => {
    const spy = vi.spyOn(db.supabase.storage, "from").mockImplementation(() => ({ createSignedUrl: () => new Promise(() => {}) }));
    const ctl = new AbortController();
    try {
      const pending = prepareMediaExport([item()], undefined, { signal: ctl.signal });
      setTimeout(() => ctl.abort(), 5);
      const result = await pending;
      expect(result.failed[0].reason).toBe("aborted");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("settles a fetch that ignores its signal", async () => {
    onFetch = () => new Promise(() => {});
    const result = await prepareMediaExport([item()], undefined, { timeoutMs: 5 });
    expect(result.files).toEqual([]);
    expect(result.failed[0].reason).toBe("timeout");
  });
  it("settles a hung body even when its cancel promise never completes", async () => {
    let canceled = false;
    onFetch = () => new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }));
    const result = await prepareMediaExport([item()], undefined, { timeoutMs: 5 });
    expect(result.failed[0].reason).toBe("timeout");
    expect(result.files).toEqual([]);
    expect(canceled).toBe(true);
  });
  it("does not finalize EOF when abort runs between settlement and the read continuation", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const reader = {
      read: () => {
        if (++calls === 1) return Promise.resolve({ done: false, value: new Uint8Array(3) });
        return { then(resolve: (result: { done: boolean; value: undefined }) => void) { resolve({ done: true, value: undefined }); queueMicrotask(() => ctl.abort()); } };
      },
      cancel: () => Promise.resolve(), releaseLock: () => {},
    };
    onFetch = () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader, cancel: () => Promise.resolve() } } as unknown as Response);
    const result = await prepareMediaExport([item()], undefined, { signal: ctl.signal });
    expect(result.failed[0].reason).toBe("aborted");
    expect(result.files).toEqual([]);
  });
  it("refunds failed partial chunks so another worker can use that capacity", async () => {
    let put!: (chunk: Uint8Array) => void;
    let fail!: (error: Error) => void;
    onFetch = url => {
      if (url.includes("partial")) return new Response(new ReadableStream<Uint8Array>({
        start(controller) { put = chunk => controller.enqueue(chunk); fail = error => controller.error(error); },
      }));
      return new Promise(resolve => setTimeout(() => resolve(bytes(8)), 15));
    };
    const pending = prepareMediaExport([item({ id: "partial", storagePath: "install-media/photos/partial.jpg" }), item({ id: "other" })], undefined, { maxBytes: 10 });
    await new Promise(resolve => setTimeout(resolve, 2)); put(new Uint8Array(6));
    await new Promise(resolve => setTimeout(resolve, 2)); fail(new Error("transport failed"));
    const result = await pending;
    expect(result.failed.map(f => f.id)).toEqual(["partial"]);
    expect(result.files.map(f => [f.name, f.size])).toEqual([["photo_2026-10-06_other.jpg", 8]]);
  });
});

it("forwards cancellation to the metadata request and stops before the next page", async () => {
  const ctl = new AbortController();
  db.state.respond = () => { ctl.abort(); return { data: Array.from({ length: 500 }, (_, i) => photoRow(i)), error: null }; };
  await expect(listMediaExportItems({ kind: "photo", projectId: "job1", fromDate: "", throughDate: "" }, undefined, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(db.state.queries).toHaveLength(1);
  expect(db.state.queries[0].ops).toContainEqual(["abortSignal", [ctl.signal]]);
});

describe("names and types", () => {
  it("infers type from the stored path first, then Content-Type, else octet-stream", () => {
    expect(inferMediaType("install-media/x.PNG", "image/jpeg")).toEqual({ ext: "png", mime: "image/png" });
    expect(inferMediaType("install-media/x", "image/webp; q=1")).toEqual({ ext: "webp", mime: "image/webp" });
    expect(inferMediaType("install-media/x", null)).toEqual({ ext: "bin", mime: "application/octet-stream" });
  });

  it("names the zip by kind, job and range, with all-jobs/all-time defaults", () => {
    expect(mediaExportName("photo", "BLACK22", "2026-10-01", "2026-10-06")).toBe(
      "photos_BLACK22_2026-10-01_to_2026-10-06.zip",
    );
    expect(mediaExportName("receipt", "", "", "")).toBe("receipts_all-jobs_all-time.zip");
    expect(mediaExportName("photo", "Ünit #4 / Smith", "2026-10-06", "2026-10-06")).toBe(
      "photos_Unit-4-Smith_2026-10-06.zip",
    );
  });
});

describe("mediaExportZip", () => {
  it("holds exactly the raw files under their names — no manifest, no links", async () => {
    const files = [
      new File([new Uint8Array([1, 2, 3])], "photo_2026-10-06_a.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array([4, 5])], "receipt_2026-10-06_r1.pdf", { type: "application/pdf" }),
    ];
    const blob = await mediaExportZip(files);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["photo_2026-10-06_a.jpg", "receipt_2026-10-06_r1.pdf"]);
    expect([...(await zip.file("photo_2026-10-06_a.jpg")!.async("uint8array"))]).toEqual([1, 2, 3]);
  });

  it("refuses to build an empty zip", async () => {
    await expect(mediaExportZip([])).rejects.toThrow("no_files");
  });
});

describe("share", () => {
  const file = () => new File([new Uint8Array([1])], "a.jpg", { type: "image/jpeg" });

  it("reports no share support without navigator.share/canShare or with no files", () => {
    vi.stubGlobal("navigator", {});
    expect(canShareMediaFiles([file()])).toBe(false);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => true });
    expect(canShareMediaFiles([])).toBe(false);
  });

  it("defers to the browser's own canShare limit", () => {
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => false });
    expect(canShareMediaFiles([file()])).toBe(false);
  });

  it("shares the files and nothing else", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { share, canShare: () => true });
    const files = [file()];
    await shareMediaFiles(files);
    expect(share).toHaveBeenCalledWith({ files });
  });

  it("rejects on cancel so nothing is reported as shared", async () => {
    const cancel = Object.assign(new Error("cancelled"), { name: "AbortError" });
    vi.stubGlobal("navigator", { share: vi.fn(async () => Promise.reject(cancel)), canShare: () => true });
    const err = await shareMediaFiles([file()]).catch((e: unknown) => e);
    expect(isMediaShareCancel(err)).toBe(true);
    expect(isMediaShareCancel(new Error("boom"))).toBe(false);
  });

  it("throws share_unsupported rather than falling back to anything else", async () => {
    vi.stubGlobal("navigator", {});
    await expect(shareMediaFiles([file()])).rejects.toThrow("share_unsupported");
  });
});
