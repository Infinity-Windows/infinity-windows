import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// Storage signing is controllable per path (it can hang, fail, or record
// order); fetch is stubbed per test. Sizes are tiny stand-ins for the real
// 20 MiB / 200-file / 50 MiB limits, which the session takes as test options.
const store = vi.hoisted(() => {
  const state = {
    signed: [] as string[],
    sign: (path: string): Promise<{ data: unknown; error: unknown }> =>
      Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null }),
  };
  const supabase = {
    from: () => {
      throw new Error("no table reads in session tests");
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string) => {
          state.signed.push(`${bucket}/${path}`);
          return state.sign(`${bucket}/${path}`);
        },
      }),
    },
  };
  return { state, supabase };
});

vi.mock("./supabase", () => ({ supabase: store.supabase }));

import {
  createPhotoExportSession,
  downloadPhotoPart,
  groupPhotoExportItems,
  photoExportFolders,
  type PhotoExportSessionOptions,
  type PreparedPhotoPart,
} from "./groupedPhotoExport";
import { prepareMediaExport, type MediaExportItem } from "./mediaExport";

const sizes = new Map<string, number>();
let onFetch: (url: string, init?: RequestInit) => Promise<Response> | Response;
const fetchMock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(onFetch(url, init)));

function item(id: string, projectId: string | null, size = 10, over: Partial<MediaExportItem> = {}): MediaExportItem {
  sizes.set(id, size);
  return {
    id,
    projectId,
    date: "2026-10-06",
    label: "2026-10-06",
    storagePath: `install-media/photos/${id}.jpg`,
    documentPath: null,
    kind: "photo",
    jobCode: null,
    ...over,
  };
}

function idOf(url: string) {
  return /photos\/([^/?]+)\.jpg/.exec(url)![1];
}

const labels = new Map([
  ["11111111-aaaa", "BLACK22 Black Desert"],
  ["22222222-bbbb", "ALPHA1 Alpine"],
]);

function options(over: Partial<PhotoExportSessionOptions> = {}): PhotoExportSessionOptions {
  return {
    signal: new AbortController().signal,
    isCurrent: () => true,
    projectLabels: labels,
    archiveBaseName: "photos_all-jobs_all-time.zip",
    targetBytes: 100,
    maxFiles: 3,
    maxFileBytes: 250,
    timeoutMs: 1000,
    ...over,
  };
}

async function entries(part: PreparedPhotoPart): Promise<string[]> {
  const zip = await JSZip.loadAsync(await part.zip.arrayBuffer());
  return Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort();
}

function invariant(s: ReturnType<ReturnType<typeof createPhotoExportSession>["summary"]>) {
  expect(s.packaged + s.failed.length + s.remaining).toBe(s.selected);
}

async function drain(session: ReturnType<typeof createPhotoExportSession>) {
  const parts: { part: PreparedPhotoPart; names: string[] }[] = [];
  for (;;) {
    const part = await session.nextPart();
    invariant(session.summary());
    if (!part) break;
    parts.push({ part, names: await entries(part) });
    session.releasePart(part.token);
  }
  return parts;
}

beforeEach(() => {
  sizes.clear();
  store.state.signed = [];
  store.state.sign = (path) =>
    Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null });
  onFetch = (url) => new Response(new Uint8Array(sizes.get(idOf(url)) ?? 1).fill(7), { headers: { "content-type": "image/jpeg" } });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Session = ReturnType<typeof createPhotoExportSession>;

/** Drain to exhaustion, tolerating non-abort ZIP errors; ids come from the
 * ZIP BYTES (entry names), cross-checked against part.itemIds. */
async function drainAll(session: Session) {
  const zipIds: string[] = [];
  const errors: unknown[] = [];
  for (let guard = 0; guard < 100; guard++) {
    let part: PreparedPhotoPart | null;
    try {
      part = await session.nextPart();
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw err;
      errors.push(err);
      invariant(session.summary());
      continue;
    }
    invariant(session.summary());
    if (!part) break;
    const ids = (await entries(part)).map((n) => /photo_[^_]+_(.+)\.[a-z]+$/.exec(n)![1]);
    expect(ids.sort()).toEqual([...part.itemIds].sort());
    zipIds.push(...ids);
    session.releasePart(part.token);
  }
  return { zipIds, errors };
}

/** Identity, not arithmetic: every selected id is in exactly one ZIP or failed. */
function expectCoverage(session: Session, selectedIds: string[], zipIds: string[]) {
  const s = session.summary();
  const failedIds = s.failed.map((f) => f.id);
  expect(s.remaining).toBe(0);
  expect(new Set(zipIds).size).toBe(zipIds.length);
  expect(new Set(failedIds).size).toBe(failedIds.length);
  expect(zipIds.filter((id) => failedIds.includes(id))).toEqual([]);
  expect([...zipIds, ...failedIds].sort()).toEqual([...selectedIds].sort());
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("folders", () => {
  it("names one safe, unique folder per project id; only null is Unassigned", () => {
    const folders = photoExportFolders(
      [null, "abcdefgh-1", "abcdefgh-2", "x9", "evil", "unassigned-id", "11111111-aaaa"],
      new Map([
        ["abcdefgh-1", "Smith"],
        ["abcdefgh-2", "SMITH"],
        ["evil", "../../etc/passwd"],
        ["unassigned-id", "Unassigned"],
        ["11111111-aaaa", "BLACK22 Black Desert"],
      ]),
    );
    expect(folders.get(null)).toBe("Unassigned");
    expect(folders.get("x9")).toBe("Job-x9");
    expect(folders.get("evil")).toBe("etc-passwd_evil");
    expect(folders.get("unassigned-id")).toBe("Unassigned_unassign");
    expect(folders.get("11111111-aaaa")).toBe("BLACK22-Black-Desert_11111111");
    const smiths = [folders.get("abcdefgh-1"), folders.get("abcdefgh-2")];
    expect(smiths[0]).toBe("Smith_abcdefgh");
    expect(smiths[1]).toBe("SMITH_abcdefgh-2"); // case-insensitive clash widened to the full id
    const all = [...folders.values()].map((f) => f.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
    for (const f of folders.values()) expect(f).toMatch(/^[A-Za-z0-9_-]+$/);
    // Deterministic regardless of input order.
    expect(photoExportFolders([...folders.keys()].reverse(), new Map([["x9", ""]])).get("x9")).toBe("Job-x9");
  });

  it("groups alphabetically by job label with Unassigned last", () => {
    const groups = groupPhotoExportItems(
      [item("a", null), item("b", "11111111-aaaa"), item("c", "22222222-bbbb"), item("d", "11111111-aaaa")],
      labels,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["ALPHA1 Alpine", ["c"]],
      ["BLACK22 Black Desert", ["b", "d"]],
      ["Unassigned", ["a"]],
    ]);
  });
});

describe("createPhotoExportSession", () => {
  it("packs a small selection into ONE ZIP with job folders and Unassigned", async () => {
    const session = createPhotoExportSession(
      [item("p1", "11111111-aaaa"), item("p2", null), item("p3", "22222222-bbbb")],
      options(),
    );
    const parts = await drain(session);
    expect(parts).toHaveLength(1);
    expect(parts[0].part).toMatchObject({ number: 1, name: "photos_all-jobs_all-time.zip", last: true });
    expect(parts[0].names).toEqual([
      "ALPHA1-Alpine_22222222/photo_2026-10-06_p3.jpg",
      "BLACK22-Black-Desert_11111111/photo_2026-10-06_p1.jpg",
      "Unassigned/photo_2026-10-06_p2.jpg",
    ]);
    expect(session.summary()).toEqual({ selected: 3, packaged: 3, failed: [], remaining: 0, partsPrepared: 1, state: "complete" });
  });

  it("splits a large selection into numbered parts holding every id exactly once", async () => {
    const selected = Array.from({ length: 40 }, (_, i) =>
      item(`p${String(i).padStart(2, "0")}`, i % 3 === 0 ? null : i % 3 === 1 ? "11111111-aaaa" : "22222222-bbbb", 30 + (i % 4) * 10),
    );
    // Duplicates in the snapshot are packed once.
    const session = createPhotoExportSession([...selected, selected[5], selected[6]], options());
    const parts = await drain(session);
    const ids = parts.flatMap((p) => p.part.itemIds);
    expect(ids).toHaveLength(40);
    expect(new Set(ids)).toEqual(new Set(selected.map((i) => i.id)));
    expect(parts.length).toBeGreaterThan(10);
    parts.forEach(({ part, names }, i) => {
      expect(part.number).toBe(i + 1);
      expect(part.name).toBe(`photos_all-jobs_all-time_part-${String(i + 1).padStart(2, "0")}.zip`);
      expect(part.last).toBe(i === parts.length - 1);
      expect(names.length).toBeLessThanOrEqual(3);
      expect(names).toHaveLength(part.itemIds.length);
      expect(part.zip.size).toBeGreaterThan(0);
    });
    // Each photo fetched once: a carried photo is not fetched again.
    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect(session.summary()).toMatchObject({ selected: 40, packaged: 40, remaining: 0, state: "complete" });
    expect(session.summary().partsPrepared).toBe(parts.length);
  });

  it("rolls a photo that does not fit into the next part, and gives an over-target photo its own", async () => {
    const session = createPhotoExportSession(
      [item("a", null, 60), item("b", null, 60), item("c", null, 150), item("d", null, 20), item("e", null, 20)],
      options(),
    );
    const parts = await drain(session);
    expect(parts.map((p) => p.part.itemIds)).toEqual([["a"], ["b"], ["c"], ["d", "e"]]);
    expect(session.summary().failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fails an oversized photo explicitly (declared or unknown length) and keeps going", async () => {
    onFetch = (url) => {
      const id = idOf(url);
      if (id === "streamed") {
        // No content-length: the cap applies while streaming.
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(100)); c.close(); },
        }));
      }
      if (id === "missing") return new Response("no", { status: 404 });
      return new Response(new Uint8Array(sizes.get(id)!).fill(1), { headers: { "content-length": String(sizes.get(id)) } });
    };
    const session = createPhotoExportSession(
      [item("big", "11111111-aaaa", 300), item("streamed", "11111111-aaaa"), item("missing", null), item("ok", null, 10)],
      options(),
    );
    const parts = await drain(session);
    expect(parts.map((p) => p.part.itemIds)).toEqual([["ok"]]);
    expect(parts[0].part.last).toBe(true);
    expect(session.summary()).toEqual({
      selected: 4,
      packaged: 1,
      failed: [
        { id: "big", projectId: "11111111-aaaa", label: "2026-10-06", reason: "too_large" },
        { id: "streamed", projectId: "11111111-aaaa", label: "2026-10-06", reason: "too_large" },
        { id: "missing", projectId: null, label: "2026-10-06", reason: "http_404" },
      ],
      remaining: 0,
      partsPrepared: 1,
      state: "partial",
    });
  });

  it("forbids a concurrent request and advancing while the current part is retained", async () => {
    const session = createPhotoExportSession([item("a", null, 60), item("b", null, 60)], options());
    const first = session.nextPart();
    await expect(session.nextPart()).rejects.toThrow("export_busy");
    const part = (await first)!;
    await expect(session.nextPart()).rejects.toThrow("part_retained");
    session.releasePart("someone-else");
    await expect(session.nextPart()).rejects.toThrow("part_retained");
    // A retained part can be downloaded/shared again: same bytes, same name.
    expect(part.zip.size).toBeGreaterThan(0);
    session.releasePart(part.token);
    await expect(session.nextPart()).resolves.toMatchObject({ number: 2, itemIds: ["b"], last: true });
  });

  it("cancels during a hung sign: rejects AbortError, never fetches, keeps the totals honest", async () => {
    store.state.sign = () => new Promise(() => {});
    const session = createPhotoExportSession([item("a", null), item("b", null)], options());
    const pending = session.nextPart();
    await vi.waitFor(() => expect(store.state.signed).toHaveLength(1));
    session.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    const s = session.summary();
    expect(s).toMatchObject({ selected: 2, packaged: 0, failed: [], remaining: 2, state: "canceled" });
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts with the caller's signal", async () => {
    const ctl = new AbortController();
    store.state.sign = () => new Promise(() => {});
    const session = createPhotoExportSession([item("a", null)], options({ signal: ctl.signal }));
    const pending = session.nextPart();
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(session.summary().state).toBe("canceled");
  });

  it("stops at the owner fence when it goes stale after signing — no fetch, no part", async () => {
    let current = true;
    store.state.sign = async (path) => {
      current = false; // a reset happened while the URL was being minted
      return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null };
    };
    const session = createPhotoExportSession([item("a", null)], options({ isCurrent: () => current }));
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.summary()).toMatchObject({ state: "canceled", failed: [], remaining: 1 });
  });

  it("drops a part that finishes after its owner went stale", async () => {
    let current = true;
    onFetch = (url) => {
      const res = new Response(new Uint8Array(5));
      current = false;
      void url;
      return res;
    };
    const session = createPhotoExportSession([item("a", null)], options({ isCurrent: () => current }));
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
    expect(session.summary().packaged).toBe(0);
  });

  it("fails a hung sign at the per-file deadline and moves on", async () => {
    store.state.sign = (path) =>
      path.includes("hang")
        ? new Promise(() => {})
        : Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null });
    const session = createPhotoExportSession([item("hang", null), item("ok", null)], options({ timeoutMs: 20 }));
    const part = await session.nextPart();
    expect(part!.itemIds).toEqual(["ok"]);
    expect(session.summary().failed).toEqual([{ id: "hang", projectId: null, label: "2026-10-06", reason: "timeout" }]);
  });

  it("puts nothing but the photos in a ZIP — no manifest, no links", async () => {
    const session = createPhotoExportSession([item("a", "11111111-aaaa"), item("b", null)], options());
    const part = (await session.nextPart())!;
    const zip = await JSZip.loadAsync(await part.zip.arrayBuffer());
    const names = Object.keys(zip.files);
    expect(names.every((n) => /^(Unassigned|BLACK22-Black-Desert_11111111)\/(photo_2026-10-06_[ab]\.jpg)?$/.test(n))).toBe(true);
    expect(JSON.stringify(part)).not.toMatch(/token=|https?:/);
  });

  it("reports progress without letting a throwing callback stop the export", async () => {
    const seen: number[] = [];
    const session = createPhotoExportSession(
      [item("a", null), item("b", null)],
      options({ onProgress: (p) => { seen.push(p.processed); throw new Error("ui bug"); } }),
    );
    await expect(session.nextPart()).resolves.toMatchObject({ itemIds: ["a", "b"] });
    expect(seen.at(-1)).toBe(2);
  });
});

describe("ZIP failure accounting", () => {
  it("records a failed generation's photos once and still packs the carried photo next", async () => {
    vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(() => Promise.reject(new Error("zip_boom")));
    const session = createPhotoExportSession([item("a", null, 60), item("b", null, 60), item("c", null, 20)], options());
    const { zipIds, errors } = await drainAll(session);
    expect(errors).toEqual([new Error("zip_boom")]);
    expect(session.summary().failed).toEqual([{ id: "a", projectId: null, label: "2026-10-06", reason: "zip_failed" }]);
    expect(zipIds.sort()).toEqual(["b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(3); // the carried photo was not lost or refetched
    expectCoverage(session, ["a", "b", "c"], zipIds);
    expect(session.summary().state).toBe("partial");
  });

  it("fails every photo of a part whose buffer read fails mid-way, exactly once", async () => {
    let reads = 0;
    const original = Blob.prototype.arrayBuffer;
    vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      if (this.type === "image/jpeg" && ++reads === 2) return Promise.reject(new Error("read_failed"));
      return original.call(this);
    });
    const session = createPhotoExportSession([item("a", null), item("b", null), item("c", null), item("d", null)], options());
    const { zipIds, errors } = await drainAll(session);
    expect(errors).toHaveLength(1);
    expect(session.summary().failed.map((f) => [f.id, f.reason])).toEqual([
      ["a", "zip_failed"], ["b", "zip_failed"], ["c", "zip_failed"],
    ]);
    expect(zipIds).toEqual(["d"]);
    expectCoverage(session, ["a", "b", "c", "d"], zipIds);
  });

  it("treats a ZIP File construction failure as zip_failed and continues with the carry", async () => {
    const RealFile = File;
    let failZip = 1;
    vi.stubGlobal("File", class extends RealFile {
      constructor(bits: BlobPart[], name: string, opts?: FilePropertyBag) {
        if (opts?.type === "application/zip" && failZip-- > 0) throw new Error("file_failed");
        super(bits, name, opts);
      }
    });
    const session = createPhotoExportSession([item("a", null, 60), item("b", null, 60)], options());
    const { zipIds, errors } = await drainAll(session);
    expect(errors).toEqual([new Error("file_failed")]);
    expect(zipIds).toEqual(["b"]);
    expectCoverage(session, ["a", "b"], zipIds);
  });

  it("covers every selected id by identity across many parts", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `q${String(i).padStart(2, "0")}`);
    const session = createPhotoExportSession(
      ids.map((id, i) => item(id, i % 2 ? "11111111-aaaa" : null, id === "q07" ? 300 : 20 + (i % 5) * 15)),
      options(),
    );
    const { zipIds } = await drainAll(session);
    expectCoverage(session, ids, zipIds);
    expect(session.summary().failed).toEqual([{ id: "q07", projectId: "11111111-aaaa", label: "2026-10-06", reason: "too_large" }]);
  });
});

describe("cancellation races", () => {
  it("rejects promptly when canceled during a hung ZIP generation; the late ZIP is never published", async () => {
    const zip = deferred<Blob>();
    const gen = vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(() => zip.promise as never);
    const session = createPhotoExportSession([item("a", null), item("b", null)], options());
    const pending = session.nextPart();
    await vi.waitFor(() => expect(gen).toHaveBeenCalledTimes(1));
    session.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    zip.resolve(new Blob([new Uint8Array(4)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(session.summary()).toEqual({ selected: 2, packaged: 0, failed: [], remaining: 2, partsPrepared: 0, state: "canceled" });
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects promptly on the caller's abort during a hung ZIP generation", async () => {
    const ctl = new AbortController();
    const zip = deferred<Blob>();
    const gen = vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(() => zip.promise as never);
    const session = createPhotoExportSession([item("a", null)], options({ signal: ctl.signal }));
    const pending = session.nextPart();
    await vi.waitFor(() => expect(gen).toHaveBeenCalledTimes(1));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    zip.resolve(new Blob([new Uint8Array(4)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(session.summary()).toMatchObject({ packaged: 0, partsPrepared: 0, state: "canceled" });
  });

  it("rejects promptly when canceled during a hung buffer read", async () => {
    const read = deferred<ArrayBuffer>();
    const original = Blob.prototype.arrayBuffer;
    const spy = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      return this.type === "image/jpeg" ? read.promise : original.call(this);
    });
    const session = createPhotoExportSession([item("a", null)], options());
    const pending = session.nextPart();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    session.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    read.resolve(new ArrayBuffer(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(session.summary()).toMatchObject({ packaged: 0, state: "canceled" });
  });

  it("treats the caller's abort with a ready part and a carry as a cancel", async () => {
    const ctl = new AbortController();
    const session = createPhotoExportSession([item("a", null, 60), item("b", null, 60)], options({ signal: ctl.signal }));
    const part = await session.nextPart();
    expect(part!.itemIds).toEqual(["a"]);
    ctl.abort();
    expect(session.summary()).toMatchObject({ packaged: 1, remaining: 1, state: "canceled" });
    // Not "part_retained": the ready part and carry were dropped by the cancel.
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels at once for a signal already aborted at creation", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const session = createPhotoExportSession([item("a", null)], options({ signal: ctl.signal }));
    expect(session.summary().state).toBe("canceled");
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
    expect(store.state.signed).toEqual([]);
  });

  it("gives a stale owner AbortError, not part_retained", async () => {
    let current = true;
    const session = createPhotoExportSession([item("a", null, 60), item("b", null, 60)], options({ isCurrent: () => current }));
    await session.nextPart();
    current = false;
    await expect(session.nextPart()).rejects.toMatchObject({ name: "AbortError" });
    expect(session.summary().state).toBe("canceled");
  });
});

describe("prepareMediaExport isCurrent guard", () => {
  it("never fetches once the owner goes stale, and is unchanged when no guard is given", async () => {
    let current = true;
    store.state.sign = async (path) => {
      current = false;
      return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null };
    };
    const out = await prepareMediaExport([item("a", null)], undefined, { isCurrent: () => current });
    expect(out).toEqual({ files: [], failed: [{ id: "a", label: "2026-10-06", reason: "aborted" }] });
    expect(fetchMock).not.toHaveBeenCalled();

    const plain = await prepareMediaExport([item("b", null)]);
    expect(plain.failed).toEqual([]);
    expect(plain.files.map((f) => f.name)).toEqual(["photo_2026-10-06_b.jpg"]);
  });

  it("stops reading a body mid-stream once stale", async () => {
    let current = true;
    let canceled = false;
    let pulls = 0;
    onFetch = () =>
      new Response(new ReadableStream<Uint8Array>({
        // The first pull runs at construction; go stale only once reading.
        pull(c) { c.enqueue(new Uint8Array(4)); if (++pulls > 2) current = false; },
        cancel() { canceled = true; },
      }));
    const out = await prepareMediaExport([item("a", null)], undefined, { isCurrent: () => current });
    expect(out.failed).toEqual([{ id: "a", label: "2026-10-06", reason: "aborted" }]);
    await vi.waitFor(() => expect(canceled).toBe(true));
  });
});

describe("prepareMediaExport late response disposal", () => {
  /** A declared-length response whose body cancel is spied and NEVER settles. */
  function hangingCancelResponse() {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const res = new Response(new Uint8Array(8), { headers: { "content-length": "8" } });
    Object.defineProperty(res, "body", { value: { cancel } });
    return { res, cancel };
  }

  it("cancels the body of a response that arrives after the guard went stale", async () => {
    let current = true;
    const { res, cancel } = hangingCancelResponse();
    onFetch = () => { current = false; return res; };
    const out = await prepareMediaExport([item("a", null)], undefined, { isCurrent: () => current });
    expect(out).toEqual({ files: [], failed: [{ id: "a", label: "2026-10-06", reason: "aborted" }] });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the body of a response that resolves after abort already rejected the read", async () => {
    const ctl = new AbortController();
    const { res, cancel } = hangingCancelResponse();
    let arrive!: (r: Response) => void;
    onFetch = () => new Promise<Response>((resolve) => { arrive = resolve; }); // ignores its signal
    const pending = prepareMediaExport([item("a", null)], undefined, { signal: ctl.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    ctl.abort();
    // Settles promptly — not held by the fetch nor by a never-settling cancel.
    await expect(pending).resolves.toEqual({ files: [], failed: [{ id: "a", label: "2026-10-06", reason: "aborted" }] });
    expect(cancel).not.toHaveBeenCalled();
    arrive(res);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("cancels a timed-out late response the same way", async () => {
    const { res, cancel } = hangingCancelResponse();
    let arrive!: (r: Response) => void;
    onFetch = () => new Promise<Response>((resolve) => { arrive = resolve; });
    const out = await prepareMediaExport([item("a", null)], undefined, { timeoutMs: 10 });
    expect(out.failed).toEqual([{ id: "a", label: "2026-10-06", reason: "timeout" }]);
    arrive(res);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});

describe("downloadPhotoPart", () => {
  it.each(["append", "click"])("revokes exactly once when the initial %s throws", (where) => {
    const click = vi.fn(() => { if (where === "click") throw new Error("click_failed"); });
    const anchor = { click, remove: vi.fn(), style: {} as Record<string, string> } as Record<string, unknown>;
    const appendChild = vi.fn(() => { if (where === "append") throw new Error("append_failed"); });
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:part");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    expect(() => downloadPhotoPart({ zip: new File([new Uint8Array(3)], "p.zip"), name: "p.zip" })).toThrow(`${where}_failed`);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith("blob:part");
    expect(click).toHaveBeenCalledTimes(where === "click" ? 1 : 0);
  });

  it("clicks once and holds the URL until the caller revokes it", () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), style: {} as Record<string, string> } as Record<string, unknown>;
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:part");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.useFakeTimers();
    const handle = downloadPhotoPart({ zip: new File([new Uint8Array(3)], "p.zip"), name: "p.zip" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe("p.zip");
    expect(revoked).not.toHaveBeenCalled();
    // Retries reuse the one live URL and never revoke an earlier save.
    expect(handle.download()).toBe(true);
    expect(handle.download()).toBe(true);
    expect(click).toHaveBeenCalledTimes(3);
    expect(created).toHaveBeenCalledTimes(1);
    expect(anchor.href).toBe("blob:part");
    expect(revoked).not.toHaveBeenCalled();
    handle.revoke();
    handle.revoke();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith("blob:part");
    // After revoke: a harmless refusal, no click.
    expect(handle.download()).toBe(false);
    expect(click).toHaveBeenCalledTimes(3);
    expect(created).toHaveBeenCalledTimes(1);
    created.mockRestore();
    revoked.mockRestore();
  });
});
