import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// The folder is a fake in-memory file system: every step (getFileHandle,
// createWritable, write, close) can be held open or made to fail, so the tests
// see exactly what has happened at each await. Real photo bytes and ZIPs come
// from the real grouped session with fetch stubbed, as in its own tests.
const store = vi.hoisted(() => ({
  supabase: {
    from: () => { throw new Error("no table reads in folder tests"); },
    storage: { from: (bucket: string) => ({ createSignedUrl: (path: string) => Promise.resolve({ data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t` }, error: null }) }) },
  },
}));
vi.mock("./supabase", () => ({ supabase: store.supabase }));

import { createPhotoExportSession, type PreparedPhotoPart } from "./groupedPhotoExport";
import type { MediaExportItem } from "./mediaExport";
import {
  abortable,
  canSaveZipsToFolder,
  createExportFolder,
  createFolderSaveTally,
  exportFolderName,
  FolderExportError,
  pickExportFolder,
  saveSessionToFolder,
  writePartToFolder,
  type ExportFolderHandle,
  type FolderWritable,
} from "./photoFolderExport";

function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const named = (name: string) => Object.assign(new Error(name), { name });

type Hook = (name: string) => Promise<void> | void;
interface FakeFolder {
  handle: ExportFolderHandle;
  log: string[];
  files: Map<string, Blob>;
  children: Map<string, FakeFolder>;
  writers: (FolderWritable & { aborted: boolean })[];
  hooks: { getFile?: Hook; create?: Hook; write?: Hook; close?: Hook; closeThrowsSync?: boolean };
  /** Names that exist on "disk" — closed files, plus empty files made by create. */
  present: Set<string>;
}
/** Fake folder. `files` holds only CLOSED files — a writer's data commits on
 * close, as with the real swap-file behaviour. Lookups log `look:`, creating
 * lookups log `file:`. */
function fakeFolder(name = "Downloads", existing: string[] = [], existingFolders: string[] = []): FakeFolder {
  const log: string[] = [];
  const files = new Map<string, Blob>();
  const present = new Set<string>();
  const children = new Map<string, FakeFolder>();
  const writers: FakeFolder["writers"] = [];
  const hooks: FakeFolder["hooks"] = {};
  for (const e of existing) { files.set(e, new Blob(["unrelated"])); present.add(e); }
  for (const f of existingFolders) children.set(f, fakeFolder(f));
  const handle: ExportFolderHandle = {
    name,
    async getDirectoryHandle(child, opts) {
      log.push(`dir:${child}:${opts?.create ? "create" : "look"}`);
      const found = children.get(child);
      if (found) return found.handle;
      if (present.has(child)) throw named("TypeMismatchError");
      if (!opts?.create) throw named("NotFoundError");
      const made = fakeFolder(child); children.set(child, made); return made.handle;
    },
    async getFileHandle(file, opts) {
      log.push(`${opts?.create ? "file" : "look"}:${file}`);
      await hooks.getFile?.(file);
      if (children.has(file)) throw named("TypeMismatchError");
      if (!opts?.create && !present.has(file)) throw named("NotFoundError");
      present.add(file);
      return {
        async createWritable() {
          log.push(`open:${file}`);
          await hooks.create?.(file);
          let data: Blob | null = null;
          const writer = {
            aborted: false,
            async write(blob: Blob) { log.push(`write:${file}`); await hooks.write?.(file); data = blob; },
            // Like a real stream, an abort after close() was invoked cannot stop the commit.
            close() {
              log.push(`close:${file}`);
              if (hooks.closeThrowsSync) throw new Error("close threw");
              const committing = writer.aborted ? null : data;
              return (async () => { await hooks.close?.(file); if (committing) files.set(file, committing); })();
            },
            async abort() { log.push(`abort:${file}`); writer.aborted = true; data = null; },
          };
          writers.push(writer);
          return writer;
        },
      };
    },
  };
  return { handle, log, files, children, writers, hooks, present };
}

function guard(over: Partial<{ signal: AbortSignal; isCurrent: () => boolean }> = {}) {
  return { signal: new AbortController().signal, isCurrent: () => true, ...over };
}

function zipPart(n: number, over: Partial<PreparedPhotoPart> = {}): PreparedPhotoPart {
  const name = `photos_part-0${n}.zip`;
  return { token: `t-${n}`, number: n, name, zip: new File([`zip ${n}`], name), itemIds: [`a${n}`, `b${n}`], last: false, ...over };
}

/** A scripted session: hands out `parts` in order, enforces release-before-next
 * like the real one, and records calls. */
function scriptedSession(parts: (PreparedPhotoPart | Error | Promise<PreparedPhotoPart | null>)[]) {
  const calls: string[] = [];
  let retained: string | null = null;
  let i = 0;
  return {
    calls,
    nextPart: vi.fn(async () => {
      calls.push("next");
      if (retained) throw new Error("part_retained");
      const step = parts[i++];
      if (step === undefined) return null;
      if (step instanceof Error) throw step;
      const part = await step;
      retained = part?.token ?? null;
      return part;
    }),
    releasePart: vi.fn((token: string) => { calls.push(`release:${token}`); if (retained === token) retained = null; }),
  };
}

describe("capability and picker", () => {
  it("needs a secure page with showDirectoryPicker", () => {
    expect(canSaveZipsToFolder({ isSecureContext: true, showDirectoryPicker: () => null })).toBe(true);
    expect(canSaveZipsToFolder({ isSecureContext: false, showDirectoryPicker: () => null })).toBe(false);
    expect(canSaveZipsToFolder({ isSecureContext: true })).toBe(false);
    expect(canSaveZipsToFolder(null)).toBe(false);
  });

  it("asks for a read-write folder synchronously and rejects when unsupported", async () => {
    const picker = vi.fn(() => Promise.resolve(fakeFolder().handle));
    void pickExportFolder({ isSecureContext: true, showDirectoryPicker: picker });
    expect(picker).toHaveBeenCalledWith({ mode: "readwrite", startIn: "downloads" }); // before any await
    await expect(pickExportFolder({ isSecureContext: true })).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("export folder", () => {
  it("names each run uniquely with safe characters", () => {
    const at = new Date(2026, 9, 7, 9, 5, 3);
    expect(exportFolderName("photos_all jobs/../x.zip", at, "a1b2c3d4")).toBe("photos_all-jobs-..-x_2026-10-07_090503_a1b2c3d4");
    expect(exportFolderName("x", at)).not.toBe(exportFolderName("x", at));
  });

  it("uses a full 128-bit random suffix that a long base name never shortens", () => {
    const at = new Date(2026, 9, 7, 9, 5, 3);
    const name = exportFolderName("p".repeat(300), at);
    expect(name).toMatch(/^p{80}_2026-10-07_090503_[0-9a-f]{32}$/);
    const suffixes = new Set(Array.from({ length: 50 }, () => exportFolderName("x", at).slice(-32)));
    expect(suffixes.size).toBe(50);
  });

  it("creates a fresh subfolder and refuses an existing folder or file of that name", async () => {
    const root = fakeFolder("Downloads", ["taken-file"]);
    const made = await createExportFolder(root.handle, "fresh", guard());
    expect(made.name).toBe("fresh");
    expect(root.log).toEqual(["dir:fresh:look", "dir:fresh:create"]);

    root.log.length = 0;
    await expect(createExportFolder(root.handle, "fresh", guard())).rejects.toMatchObject({ code: "folder_exists" });
    await expect(createExportFolder(root.handle, "taken-file", guard())).rejects.toMatchObject({ code: "folder_exists" });
    expect(root.log.filter((l) => l.endsWith(":create"))).toEqual([]);
  });

  it("stops without creating when canceled during the existence check", async () => {
    const held = deferred<ExportFolderHandle>();
    const ctl = new AbortController();
    const parent = { name: "D", getDirectoryHandle: vi.fn(() => held.promise), getFileHandle: vi.fn() } as unknown as ExportFolderHandle;
    const creating = createExportFolder(parent, "x", guard({ signal: ctl.signal }));
    await flush(); ctl.abort();
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });
    held.reject(named("NotFoundError")); await flush();
    expect(parent.getDirectoryHandle).toHaveBeenCalledTimes(1);
  });
});

describe("writing one ZIP", () => {
  it("resolves only after close, and commits nothing before it", async () => {
    const folder = fakeFolder();
    const write = deferred(); const close = deferred();
    folder.hooks.write = () => write.promise; folder.hooks.close = () => close.promise;
    let done = false;
    const writing = writePartToFolder(folder.handle, zipPart(1), guard()).then(() => { done = true; });
    await flush();
    expect(folder.log).toEqual(["look:photos_part-01.zip", "file:photos_part-01.zip", "open:photos_part-01.zip", "write:photos_part-01.zip"]);
    write.resolve(); await flush();
    expect(folder.log.at(-1)).toBe("close:photos_part-01.zip");
    expect(done).toBe(false); expect(folder.files.size).toBe(0);
    close.resolve(); await writing;
    expect(await folder.files.get("photos_part-01.zip")!.text()).toBe("zip 1");
  });

  it("aborts a writer that is created after cancel, and never writes with it", async () => {
    const folder = fakeFolder(); const create = deferred();
    folder.hooks.create = () => create.promise;
    const ctl = new AbortController();
    const writing = writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }));
    await flush(); ctl.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    create.resolve(); await flush(); await flush();
    expect(folder.writers).toHaveLength(1); expect(folder.writers[0].aborted).toBe(true);
    expect(folder.log).not.toContain("write:photos_part-01.zip");
  });

  it("aborts a writer that arrives after the owner went stale", async () => {
    const folder = fakeFolder(); let live = true;
    folder.hooks.create = () => { live = false; };
    await expect(writePartToFolder(folder.handle, zipPart(1), guard({ isCurrent: () => live }))).rejects.toMatchObject({ name: "AbortError" });
    expect(folder.writers[0].aborted).toBe(true); expect(folder.log).not.toContain("write:photos_part-01.zip");
  });

  it("cancel during a hung write answers at once and discards the unfinished file", async () => {
    const folder = fakeFolder(); folder.hooks.write = () => new Promise(() => {});
    const ctl = new AbortController();
    const writing = writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }));
    await flush(); ctl.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(folder.writers[0].aborted).toBe(true);
    expect(folder.log).not.toContain("close:photos_part-01.zip"); expect(folder.files.size).toBe(0);
  });

  it("cancel during close answers at once and sends a best-effort abort; the close may still commit", async () => {
    const folder = fakeFolder(); const close = deferred();
    folder.hooks.close = () => close.promise;
    const ctl = new AbortController();
    const writing = writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }));
    await flush(); ctl.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(folder.writers[0].aborted).toBe(true);
    close.resolve(); await flush();
    expect(folder.files.has("photos_part-01.zip")).toBe(true); // why the UI says "may have finished saving"
  });

  it("a late close rejection after cancel is caught", async () => {
    const folder = fakeFolder(); const close = deferred();
    folder.hooks.close = () => close.promise;
    const ctl = new AbortController();
    const writing = writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }));
    await flush(); ctl.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    close.reject(new Error("disk gone")); await flush(); // an unhandled rejection would fail the run
  });

  it("wraps file-system failures as write_failed and aborts the writer", async () => {
    const folder = fakeFolder(); folder.hooks.write = () => { throw named("QuotaExceededError"); };
    const err = await writePartToFolder(folder.handle, zipPart(1), guard()).catch((e) => e);
    expect(err).toBeInstanceOf(FolderExportError); expect(err.code).toBe("write_failed");
    expect(err.cause).toMatchObject({ name: "QuotaExceededError" });
    expect(folder.writers[0].aborted).toBe(true);
  });

  it("abortable rejects immediately when already aborted", async () => {
    const ctl = new AbortController(); ctl.abort();
    await expect(abortable(Promise.resolve(1), ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("saving the session to a folder", () => {
  it("never prepares the next ZIP until the current close succeeded", async () => {
    const folder = fakeFolder(); const close = deferred();
    folder.hooks.close = (f) => (f.endsWith("01.zip") ? close.promise : undefined);
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally(); const saved: string[] = [];
    const run = saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, onSaved: (p) => saved.push(p.token) });
    await flush(); await flush();
    expect(session.nextPart).toHaveBeenCalledTimes(1);
    expect(tally.parts).toBe(0); expect(saved).toEqual([]); expect(session.releasePart).not.toHaveBeenCalled();
    close.resolve();
    await expect(run).resolves.toEqual({ status: "done" });
    expect(session.calls).toEqual(["next", "release:t-1", "next", "release:t-2"]);
    expect(saved).toEqual(["t-1", "t-2"]);
    expect(tally).toMatchObject({ parts: 2, files: 4 });
    expect([...folder.files.keys()]).toEqual(["photos_part-01.zip", "photos_part-02.zip"]);
  });

  for (const step of ["write", "close"] as const) {
    it(`a ${step} failure keeps the same part unreleased and uncounted; retry writes the same bytes once`, async () => {
      const folder = fakeFolder(); let fail = true;
      folder.hooks[step] = (f) => { if (fail && f.endsWith("02.zip")) throw new Error(`${step} broke`); };
      const second = zipPart(2);
      const session = scriptedSession([zipPart(1), second, zipPart(3, { last: true })]);
      const tally = createFolderSaveTally();
      const first = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally });
      expect(first).toMatchObject({ status: "write_failed", part: second, error: { code: "write_failed" } });
      expect(session.nextPart).toHaveBeenCalledTimes(2);
      expect(session.releasePart).toHaveBeenCalledTimes(1);
      expect(tally).toMatchObject({ parts: 1, files: 2 });
      expect(folder.files.has("photos_part-02.zip")).toBe(false);

      fail = false;
      if (first.status !== "write_failed") throw new Error("unreachable");
      const retried = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, retained: first.part });
      expect(retried).toEqual({ status: "done" });
      expect(session.calls).toEqual(["next", "release:t-1", "next", "release:t-2", "next", "release:t-3"]); // part 2 never rebuilt
      expect(await folder.files.get("photos_part-02.zip")!.text()).toBe("zip 2");
      expect(tally).toMatchObject({ parts: 3, files: 6 });
    });
  }

  it("a part saved twice is counted once", async () => {
    const folder = fakeFolder(); const tally = createFolderSaveTally();
    const part = zipPart(1, { last: true });
    await saveSessionToFolder({ ...guard(), session: scriptedSession([part]), folder: folder.handle, tally });
    await saveSessionToFolder({ ...guard(), session: scriptedSession([]), folder: folder.handle, tally, retained: part });
    expect(tally).toMatchObject({ parts: 1, files: 2 });
  });

  it("a ZIP that cannot be built stops the run with the session's error and saves nothing after it", async () => {
    const folder = fakeFolder();
    const session = scriptedSession([zipPart(1), new Error("zip_failed"), zipPart(3, { last: true })]);
    const tally = createFolderSaveTally();
    await expect(saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally })).rejects.toThrow("zip_failed");
    expect(tally.parts).toBe(1); expect(session.nextPart).toHaveBeenCalledTimes(2);
  });

  it("nothing prepared is a done run with zero saved, never a fake success count", async () => {
    const tally = createFolderSaveTally();
    await expect(saveSessionToFolder({ ...guard(), session: scriptedSession([]), folder: fakeFolder().handle, tally })).resolves.toEqual({ status: "done" });
    expect(tally.parts).toBe(0);
  });

  it("going stale while the next ZIP is prepared publishes nothing and writes nothing", async () => {
    const folder = fakeFolder(); const later = deferred<PreparedPhotoPart | null>();
    let live = true; const onPart = vi.fn();
    const session = scriptedSession([zipPart(1), later.promise]);
    const run = saveSessionToFolder({ ...guard({ isCurrent: () => live }), session, folder: folder.handle, tally: createFolderSaveTally(), onPart });
    await flush(); await flush();
    expect(session.nextPart).toHaveBeenCalledTimes(2);
    live = false; later.resolve(zipPart(2, { last: true }));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(onPart).toHaveBeenCalledTimes(1); expect(folder.files.has("photos_part-02.zip")).toBe(false);
  });

  it("a close that commits after going stale is not counted or released", async () => {
    const folder = fakeFolder(); const close = deferred(); let live = true;
    folder.hooks.close = () => close.promise;
    const session = scriptedSession([zipPart(1)]); const tally = createFolderSaveTally();
    const run = saveSessionToFolder({ ...guard({ isCurrent: () => live }), session, folder: folder.handle, tally });
    await flush(); await flush();
    live = false; close.resolve();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(tally.parts).toBe(0); expect(session.releasePart).not.toHaveBeenCalled();
  });
});

describe("stop boundaries in the gap before each file-system call", () => {
  it("a stop right after the call starts reaches no file-system method", async () => {
    const folder = fakeFolder(); const ctl = new AbortController();
    const writing = writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }));
    ctl.abort(); // same task: before the deferred getFileHandle microtask
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(folder.log).toEqual([]);

    const parent = fakeFolder(); const ctl2 = new AbortController();
    const creating = createExportFolder(parent.handle, "x", guard({ signal: ctl2.signal }));
    ctl2.abort();
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(parent.log).toEqual([]);
  });

  /** One two-part run where the k-th owner check either reports stale from
   * then on, or queues an abort for the very next microtask — which lands in
   * the gap between an outer check and a deferred file-system call. */
  async function run(stopAt: number, mode: "stale" | "abort") {
    const folder = fakeFolder(); const ctl = new AbortController();
    let calls = 0; let logAtStop = -1; let publishedAtStop = "";
    const published = () => `${tally.parts}/${session.releasePart.mock.calls.length}/${saved.length}`;
    const stop = () => { if (logAtStop < 0) { logAtStop = folder.log.length; publishedAtStop = published(); } };
    const isCurrent = () => {
      calls++;
      if (mode === "stale") { if (calls >= stopAt) stop(); return logAtStop < 0; }
      if (calls === stopAt) queueMicrotask(() => { stop(); ctl.abort(); });
      return true;
    };
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally(); const saved: string[] = [];
    const outcome = await saveSessionToFolder({ signal: ctl.signal, isCurrent, session, folder: folder.handle, tally, onSaved: (p) => saved.push(p.token) })
      .then((r) => r, (e: unknown) => e);
    await flush(); await flush();
    return { outcome, calls, after: logAtStop < 0 ? [] : folder.log.slice(logAtStop), publishedAfterStop: logAtStop >= 0 && published() !== publishedAtStop, tally, session, saved, folder };
  }

  for (const mode of ["stale", "abort"] as const) {
    it(`${mode} at every owner check: no file-system call after it, and counts match releases`, async () => {
      const full = await run(Number.POSITIVE_INFINITY, mode);
      expect(full.outcome).toEqual({ status: "done" });
      expect(full.tally.parts).toBe(2);
      expect(full.calls).toBeGreaterThan(10);
      for (let k = 1; k <= full.calls; k++) {
        const r = await run(k, mode);
        const label = `${mode} at check ${k}`;
        expect(r.after.filter((l) => !l.startsWith("abort:")), label).toEqual([]);
        // Nothing is counted, released or announced once the stop has landed.
        expect(r.publishedAfterStop, label).toBe(false);
        expect(r.session.releasePart.mock.calls.map(([t]) => t), label).toEqual([...r.tally.tokens]);
        expect(r.saved, label).toEqual([...r.tally.tokens]);
        if ((r.outcome as { status?: string }).status === "done") expect(r.tally.parts, label).toBe(2);
        else expect(r.outcome, label).toMatchObject({ name: "AbortError" });
      }
    });
  }

  it("a stop between write and close never invokes close and aborts the writer", async () => {
    const folder = fakeFolder(); const ctl = new AbortController();
    folder.hooks.write = async () => { queueMicrotask(() => ctl.abort()); };
    await expect(writePartToFolder(folder.handle, zipPart(1), guard({ signal: ctl.signal }))).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(folder.log).not.toContain("close:photos_part-01.zip");
    expect(folder.writers[0].aborted).toBe(true);
  });
});

describe("existing names and owned handles", () => {
  it("refuses a ZIP name that is already taken on the first attempt and leaves it untouched", async () => {
    const folder = fakeFolder("export", ["photos_part-01.zip"]);
    const err = await writePartToFolder(folder.handle, zipPart(1), guard()).catch((e) => e);
    expect(err).toMatchObject({ code: "file_exists" });
    expect(folder.log).toEqual(["look:photos_part-01.zip"]); // never opened for writing
    expect(await folder.files.get("photos_part-01.zip")!.text()).toBe("unrelated");

    const withFolder = fakeFolder("export", [], ["photos_part-01.zip"]);
    await expect(writePartToFolder(withFolder.handle, zipPart(1), guard())).rejects.toMatchObject({ code: "file_exists" });
  });

  it("a taken name stops the run with the same part retained", async () => {
    const folder = fakeFolder("export", ["photos_part-02.zip"]);
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally();
    const result = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally });
    expect(result).toMatchObject({ status: "write_failed", part: { token: "t-2" }, error: { code: "file_exists" } });
    expect(session.releasePart.mock.calls).toEqual([["t-1"]]); expect(tally.parts).toBe(1);
    expect(await folder.files.get("photos_part-02.zip")!.text()).toBe("unrelated");
  });

  it("retries of the same token reuse the one handle Forge created; success forgets it", async () => {
    const folder = fakeFolder(); let failures = 2;
    folder.hooks.write = () => { if (failures-- > 0) throw new Error("write broke"); };
    const part = zipPart(1, { last: true });
    const session = scriptedSession([part]);
    const tally = createFolderSaveTally();
    let result = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally });
    expect(result.status).toBe("write_failed");
    const handle = tally.owned?.file;
    expect(tally.owned).toMatchObject({ token: "t-1", name: "photos_part-01.zip" });
    for (let i = 0; i < 2; i++) {
      result = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, retained: part });
      if (i === 0) { expect(result.status).toBe("write_failed"); expect(tally.owned?.file).toBe(handle); }
    }
    expect(result).toEqual({ status: "done" });
    // One existence check and one create for three attempts.
    expect(folder.log.filter((l) => l.startsWith("look:") || l.startsWith("file:"))).toEqual(["look:photos_part-01.zip", "file:photos_part-01.zip"]);
    expect(tally.owned).toBeNull(); expect(tally.parts).toBe(1);
  });

  it("a different token with the same name gets a fresh check, never the old handle", async () => {
    const folder = fakeFolder(); folder.hooks.write = () => { throw new Error("broke"); };
    const tally = createFolderSaveTally();
    await expect(writePartToFolder(folder.handle, zipPart(1), guard(), tally)).rejects.toMatchObject({ code: "write_failed" });
    // The empty file the failed attempt created is now a taken name for anyone else.
    await expect(writePartToFolder(folder.handle, zipPart(1, { token: "other" }), guard(), tally)).rejects.toMatchObject({ code: "file_exists" });
    expect(tally.owned?.token).toBe("t-1");
  });

  for (const how of ["rejects", "throws synchronously"] as const) {
    it(`a close that ${how} aborts the writer and keeps the part retryable`, async () => {
      const folder = fakeFolder();
      if (how === "rejects") folder.hooks.close = () => { throw new Error("close broke"); };
      else folder.hooks.closeThrowsSync = true;
      const session = scriptedSession([zipPart(1, { last: true })]);
      const tally = createFolderSaveTally();
      const result = await saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally });
      expect(result).toMatchObject({ status: "write_failed", part: { token: "t-1" } });
      expect(folder.writers[0].aborted).toBe(true);
      expect(session.releasePart).not.toHaveBeenCalled(); expect(tally.parts).toBe(0);
    });
  }
});

describe("observers", () => {
  it("nested item ID mutations cannot change saved photo counts or the part snapshot", async () => {
    const folder = fakeFolder();
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally();
    const observedIds: string[][] = [];
    const onPart = (part: PreparedPhotoPart) => {
      try { part.itemIds.length = 0; } catch { /* frozen */ }
      try { part.itemIds.push("forged"); } catch { /* frozen */ }
      observedIds.push([...part.itemIds]);
    };
    await expect(saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, onPart })).resolves.toEqual({ status: "done" });
    expect(tally.files).toBe(4);
    expect(observedIds).toEqual([["a1", "b1"], ["a2", "b2"]]);
    expect(session.releasePart.mock.calls).toEqual([["t-1"], ["t-2"]]);
    expect(await folder.files.get("photos_part-01.zip")!.text()).toBe("zip 1");
    expect(await folder.files.get("photos_part-02.zip")!.text()).toBe("zip 2");
  });

  it("an abort queued by onSaved prevents asking the session for another part", async () => {
    const ctl = new AbortController();
    const folder = fakeFolder();
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally();
    const onSaved = vi.fn(() => queueMicrotask(() => ctl.abort()));
    await expect(saveSessionToFolder({ ...guard({ signal: ctl.signal }), session, folder: folder.handle, tally, onSaved })).rejects.toMatchObject({ name: "AbortError" });
    expect(session.nextPart).toHaveBeenCalledTimes(1);
    expect(session.releasePart.mock.calls).toEqual([["t-1"]]);
    expect(tally.parts).toBe(1);
    expect(tally.files).toBe(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect([...folder.files.keys()]).toEqual(["photos_part-01.zip"]);
  });

  it("an onSaved that throws cannot strand a counted part or stop the run", async () => {
    const folder = fakeFolder();
    const session = scriptedSession([zipPart(1), zipPart(2, { last: true })]);
    const tally = createFolderSaveTally();
    const onSaved = vi.fn(() => { throw new Error("render broke"); });
    await expect(saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, onSaved })).resolves.toEqual({ status: "done" });
    expect(session.releasePart.mock.calls).toEqual([["t-1"], ["t-2"]]);
    expect(tally.parts).toBe(2); expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("onSaved runs only after the part is released", async () => {
    const session = scriptedSession([zipPart(1, { last: true })]);
    const order: string[] = [];
    session.releasePart.mockImplementation((t: string) => { order.push(`release:${t}`); });
    await saveSessionToFolder({ ...guard(), session, folder: fakeFolder().handle, tally: createFolderSaveTally(), onSaved: (p) => order.push(`saved:${p.token}`) });
    expect(order).toEqual(["release:t-1", "saved:t-1"]);
  });

  it("an onPart that throws or mutates the part cannot change what is written, counted or released", async () => {
    const folder = fakeFolder();
    const first = zipPart(1); const second = zipPart(2, { last: true });
    const session = scriptedSession([first, second]);
    const tally = createFolderSaveTally();
    const onPart = vi.fn((p: PreparedPhotoPart) => {
      try { Object.assign(p, { name: "../evil.zip", token: "evil", zip: new File(["evil"], "evil.zip"), last: true }); } catch { /* frozen */ }
      Object.assign(first, { name: "../evil.zip", token: "evil", zip: new File(["evil"], "evil.zip"), last: true });
      throw new Error("observer broke");
    });
    await expect(saveSessionToFolder({ ...guard(), session, folder: folder.handle, tally, onPart })).resolves.toEqual({ status: "done" });
    expect([...folder.files.keys()]).toEqual(["photos_part-01.zip", "photos_part-02.zip"]);
    expect(await folder.files.get("photos_part-01.zip")!.text()).toBe("zip 1");
    expect(session.releasePart.mock.calls).toEqual([["t-1"], ["t-2"]]);
    expect([...tally.tokens]).toEqual(["t-1", "t-2"]);
  });
});

describe("real ZIP bytes", () => {
  const sizes = new Map<string, number>();
  beforeEach(() => {
    sizes.clear();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(new Uint8Array(sizes.get(/photos\/([^/?]+)\.jpg/.exec(url)![1]) ?? 1).fill(7), { headers: { "content-type": "image/jpeg" } }))));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function item(id: string, projectId: string | null, size = 40): MediaExportItem {
    sizes.set(id, size);
    return { id, projectId, date: "2026-10-06", label: "2026-10-06", storagePath: `install-media/photos/${id}.jpg`, documentPath: null, kind: "photo", jobCode: null };
  }

  it("saves several independent ZIPs with every selected photo in its job folder exactly once", async () => {
    const labels = new Map([["job-a", "BLACK22 Black Desert"], ["job-b", "ALPHA1 Alpine"]]);
    const items = [item("a1", "job-a"), item("a2", "job-a"), item("a3", "job-a"), item("b1", "job-b"), item("b2", "job-b"), item("u1", null), item("a1", "job-a")];
    const ctl = new AbortController();
    const session = createPhotoExportSession(items, { signal: ctl.signal, isCurrent: () => true, projectLabels: labels, archiveBaseName: "photos_all-jobs.zip", targetBytes: 100, maxFiles: 2, maxFileBytes: 250, timeoutMs: 1000 });
    const root = fakeFolder();
    const sub = await createExportFolder(root.handle, exportFolderName("photos_all-jobs", new Date(2026, 9, 7), "r1"), guard());
    const folder = root.children.get(sub.name)!;
    const tally = createFolderSaveTally();
    await expect(saveSessionToFolder({ signal: ctl.signal, isCurrent: () => true, session, folder: sub, tally })).resolves.toEqual({ status: "done" });

    expect(folder.files.size).toBeGreaterThan(1);
    expect(tally.parts).toBe(folder.files.size);
    const seen: string[] = [];
    for (const [name, blob] of folder.files) {
      expect(name).toMatch(/^photos_all-jobs_part-\d\d\.zip$/);
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      for (const entry of Object.values(zip.files).filter((f) => !f.dir)) {
        expect(entry.name).toMatch(/^(ALPHA1-Alpine_job-b|BLACK22-Black-Desert_job-a|Unassigned)\/photo_2026-10-06_[a-z0-9]+\.jpg$/);
        expect((await entry.async("uint8array")).length).toBe(40);
        seen.push(entry.name);
      }
    }
    expect(seen).toHaveLength(6); expect(new Set(seen).size).toBe(6);
    expect(tally.files).toBe(6);
    expect(session.summary()).toMatchObject({ selected: 6, packaged: 6, failed: [], remaining: 0 });
    expect(root.files.size).toBe(0); // nothing written beside the fresh folder
  });
});
