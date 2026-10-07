// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../../lib/signedIn";

const api = vi.hoisted(() => ({
  list: vi.fn(), projects: vi.fn(), create: vi.fn(), next: vi.fn(), cancel: vi.fn(), release: vi.fn(),
  download: vi.fn(), redownload: vi.fn(), revoke: vi.fn(), share: vi.fn(), preview: vi.fn(),
  receiptList: vi.fn(), receiptPrepare: vi.fn(), receiptZip: vi.fn(), receiptDownload: vi.fn(), summary: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: api.projects }));
vi.mock("../../lib/photos", () => ({ signedMedia: api.preview }));
vi.mock("../../lib/groupedPhotoExport", () => ({
  listGroupedPhotoExportItems: api.list, createPhotoExportSession: api.create,
  downloadPhotoPart: api.download, canSharePhotoPart: () => true, sharePhotoPart: api.share,
}));
vi.mock("../../lib/mediaExport", () => ({
  listMediaExportItems: api.receiptList, prepareMediaExport: api.receiptPrepare, mediaExportZip: api.receiptZip,
  downloadMediaBlob: api.receiptDownload, shareMediaFiles: api.share, canShareMediaFiles: () => true,
  mediaExportRangeError: () => null, mediaExportName: () => "photos.zip",
  isMediaShareCancel: (e: { name?: string }) => e?.name === "AbortError",
  MediaExportDataError: class extends Error {},
}));
import MediaExportDialog from "./MediaExportDialog";

const ALICE = { user: { id: "alice", email: "alice@example.test" } };
const BOB = { user: { id: "bob", email: "bob@example.test" } };
const row = { id: "alice-photo", projectId: "job1", date: "2026-10-05", label: "Alice photo", storagePath: "install-media/alice.jpg", documentPath: null, kind: "photo" };
const part = { token: "part-1", number: 1, name: "photos-part-1.zip", zip: new File(["private Alice ZIP"], "photos-part-1.zip"), itemIds: [row.id], last: true };
let root: Root | null;
let host: HTMLDivElement;
let client: QueryClient;
let close = vi.fn<() => void>();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function button(name: string) { const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent?.trim() === name); if (!b) throw new Error(`Missing button ${name}; text=${host.textContent?.slice(0, 500)}`); return b; }
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 2)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await tick(); expect(check()).toBe(true); }
async function mount(key = "dialog", wait = true, kind: "photo" | "receipt" = "photo") {
  await act(async () => { root!.render(<QueryClientProvider client={client}><MediaExportDialog key={key} kind={kind} projectId="job1" onClose={close} /></QueryClientProvider>); });
  if (wait) await until(() => { const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent?.trim() === (kind === "photo" ? "Export selected job" : "Prepare export")); return !!b && !b.disabled; });
}
async function prepare() { await act(async () => { button("Export selected job").click(); }); await until(() => !!host.textContent?.includes("1 of 1 selected photos prepared")); }
beforeEach(() => {
  rememberSignedIn(ALICE); close = vi.fn<() => void>();
  for (const mock of Object.values(api)) mock.mockReset();
  api.projects.mockResolvedValue([{ id: "job1", job_code: "JOB1", name: "Job one" }]);
  api.list.mockResolvedValue([row]); api.receiptList.mockResolvedValue([{ ...row, kind: "receipt" }]); api.next.mockResolvedValue(part);
  api.receiptPrepare.mockResolvedValue({ files: [new File(["receipt"], "receipt.jpg")], failed: [] });
  api.receiptZip.mockResolvedValue(new Blob(["receipt zip"]));
  api.summary.mockReturnValue({ selected: 1, packaged: 1, failed: [], remaining: 0, partsPrepared: 1, state: "complete" });
  api.create.mockImplementation(() => ({ nextPart: api.next, cancel: api.cancel, releasePart: api.release, summary: api.summary }));
  api.download.mockImplementation(() => ({ download: api.redownload, revoke: api.revoke }));
  api.share.mockResolvedValue(undefined); api.preview.mockResolvedValue("https://fixture.test/alice.jpg");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); client.clear(); host.remove(); rememberSignedIn(null); });

for (const boundary of ["different person", "sign out", "same person new sign-in", "unmount"] as const) {
  it(`discards a prepared part after ${boundary}`, async () => {
    const pending = deferred<typeof part>(); api.next.mockReturnValue(pending.promise);
    await mount(); await act(async () => { button("Export selected job").click(); });
    expect(api.create).toHaveBeenCalledOnce();
    const opts = api.create.mock.calls[0][1];
    await act(async () => {
      if (boundary === "different person") rememberSignedIn(BOB);
      else if (boundary === "sign out") rememberSignedIn(null);
      else if (boundary === "same person new sign-in") { rememberSignedIn(null); rememberSignedIn(ALICE); }
      else { root!.unmount(); root = null; }
    });
    expect(opts.signal.aborted).toBe(true); expect(opts.isCurrent()).toBe(false);
    expect(api.cancel).toHaveBeenCalled();
    pending.resolve(part); await tick();
    expect(api.download).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("private Alice ZIP");
  });
}

it("retained Download and Share buttons refuse a changed viewer before rerender", async () => {
  await mount(); await prepare();
  const download = button("Download ZIP"); const share = button("Share ZIP");
  await act(async () => { rememberSignedIn(BOB); download.click(); share.click(); });
  expect(api.download).not.toHaveBeenCalled(); expect(api.share).not.toHaveBeenCalled();
});

it("retries one part using its live URL and revokes it on close", async () => {
  await mount(); await prepare();
  await act(async () => { button("Download ZIP").click(); button("Download ZIP").click(); });
  expect(api.download).toHaveBeenCalledOnce(); expect(api.redownload).toHaveBeenCalledOnce();
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
  expect(api.revoke).toHaveBeenCalledOnce(); expect(api.cancel).toHaveBeenCalled();
});

it("discards a preview URL after an account change", async () => {
  const pending = deferred<string>(); api.preview.mockReturnValue(pending.promise);
  await mount(); await act(async () => { button("Expand").click(); });
  await act(async () => { button("Preview").click(); });
  await act(async () => { rememberSignedIn(BOB); });
  pending.resolve("https://fixture.test/private-alice.jpg"); await tick();
  expect(host.querySelector('img[src="https://fixture.test/private-alice.jpg"]')).toBeNull();
});

it("same-viewer selection change invalidates a late prepared part", async () => {
  const pending = deferred<typeof part>(); api.next.mockReturnValue(pending.promise);
  await mount(); await act(async () => { button("Export selected job").click(); });
  await act(async () => { button("Cancel preparation").click(); });
  pending.resolve(part); await tick();
  expect(host.textContent).not.toContain("1 of 1 selected photos prepared");
  expect(api.cancel).toHaveBeenCalled();
});

it("fresh Bob gets a separate private listing and no Alice part", async () => {
  await mount(); await prepare(); await act(async () => { rememberSignedIn(BOB); });
  api.list.mockResolvedValue([{ ...row, id: "bob-photo", label: "Bob photo", storagePath: "install-media/bob.jpg" }]);
  await mount("bob");
  await act(async () => { button("Expand").click(); });
  expect(host.textContent).toContain("Bob photo"); expect(host.textContent).not.toContain("Alice photo");
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("late private metadata is aborted before another viewer mounts", async () => {
  const pending = deferred<typeof row[]>(); api.list.mockReturnValueOnce(pending.promise);
  await mount("alice", false); await until(() => api.list.mock.calls.length === 1);
  const oldSignal = api.list.mock.calls[0][2] as AbortSignal;
  await act(async () => { rememberSignedIn(BOB); }); expect(oldSignal.aborted).toBe(true);
  api.list.mockResolvedValue([{ ...row, id: "bob-photo", label: "Bob photo" }]);
  await mount("bob"); pending.resolve([row]); await tick();
  expect(host.textContent).not.toContain("Alice photo");
});

it("old part buttons cannot download or share while the next part is pending", async () => {
  const first = { ...part, last: false };
  const pending = deferred<typeof part>();
  api.next.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
  await mount(); await prepare();
  const oldDownload = button("Download ZIP"); const oldShare = button("Share ZIP");
  await act(async () => { oldDownload.click(); });
  const next = button("I saved this part — prepare next");
  await act(async () => { next.click(); next.click(); oldDownload.click(); oldShare.click(); });
  expect(api.release).toHaveBeenCalledOnce();
  expect(api.next).toHaveBeenCalledTimes(2);
  expect(api.download).toHaveBeenCalledOnce();
  expect(api.redownload).not.toHaveBeenCalled();
  expect(api.share).not.toHaveBeenCalled();
  expect(api.revoke).toHaveBeenCalledOnce();
  pending.resolve({ ...part, token: "part-2", number: 2, last: true });
  await tick();
});


it("selection change discards a ready photo part and its download URL", async () => {
  await mount(); await prepare();
  await act(async () => { button("Download ZIP").click(); button("Clear selection").click(); });
  expect(api.cancel).toHaveBeenCalled(); expect(api.revoke).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("1 of 1 selected photos prepared");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.trim() === "Download ZIP")).toBe(false);
});

it("a same-viewer token refresh keeps the prepared part usable", async () => {
  await mount(); await prepare();
  await act(async () => { rememberSignedIn(ALICE); button("Download ZIP").click(); });
  expect(api.download).toHaveBeenCalledOnce();
});

it("a receipt ZIP resolving after sign-out cannot download", async () => {
  const pending = deferred<Blob>(); api.receiptZip.mockReturnValue(pending.promise);
  await mount("receipt", true, "receipt");
  await act(async () => { button("Prepare export").click(); });
  await until(() => host.textContent?.includes("files ready") === true);
  await act(async () => { button("Download ZIP").click(); });
  await act(async () => { rememberSignedIn(BOB); });
  pending.resolve(new Blob(["private receipt ZIP"])); await tick();
  expect(api.receiptDownload).not.toHaveBeenCalled();
});

it("a deferred preview cannot appear after same-viewer selection reset", async () => {
  const pending = deferred<string>(); api.preview.mockReturnValue(pending.promise);
  await mount(); await act(async () => { button("Expand").click(); });
  await act(async () => { button("Preview").click(); });
  await act(async () => { button("Clear selection").click(); });
  pending.resolve("https://fixture.test/stale-preview.jpg"); await tick();
  expect(host.querySelector('img[src="https://fixture.test/stale-preview.jpg"]')).toBeNull();
});


it("canceling a pending later part revokes the prior URL and rejects its late result", async () => {
  const first = { ...part, last: false };
  const pending = deferred<typeof part>();
  api.next.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
  await mount(); await prepare();
  await act(async () => { button("Download ZIP").click(); });
  await act(async () => { button("I saved this part — prepare next").click(); });
  expect(api.revoke).toHaveBeenCalledOnce();
  await act(async () => { button("Cancel preparation").click(); });
  expect(api.cancel).toHaveBeenCalled();
  expect(host.textContent).toContain("Preparation was canceled.");
  pending.resolve({ ...part, token: "late-part", number: 2, last: true }); await tick();
  expect(host.textContent).not.toContain("late-part");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.trim() === "Download ZIP")).toBe(false);
  expect(api.download).toHaveBeenCalledOnce();
});


it("reports failed later ZIP photos and resumes remaining photos in the same session", async () => {
  const first = { ...part, last: false };
  const second = { ...part, token: "part-3", number: 3, itemIds: ["carried", "remaining"], last: true };
  const failed = { selected: 4, packaged: 1, failed: [{ id: "bad", projectId: "job1", label: "Bad photo", reason: "zip_failed" }], remaining: 2, partsPrepared: 1, state: "active" };
  const complete = { ...failed, packaged: 3, remaining: 0, partsPrepared: 2, state: "partial" };
  api.next.mockResolvedValueOnce(first).mockImplementationOnce(async () => { api.summary.mockReturnValue(failed); throw new Error("ZIP generator broke"); })
    .mockImplementationOnce(async () => { api.summary.mockReturnValue(complete); return second; });
  await mount(); await prepare();
  await act(async () => { button("Download ZIP").click(); });
  await act(async () => { button("I saved this part — prepare next").click(); });
  expect(api.revoke).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("1 of 4 selected photos prepared");
  expect(host.textContent).toContain("2 photos remain queued");
  expect(host.textContent).toContain("Bad photo: This ZIP part could not be built.");
  expect(host.textContent).toContain("A ZIP part could not be prepared.");
  expect(api.create).toHaveBeenCalledOnce();
  await act(async () => { button("Prepare next part").click(); });
  expect(api.create).toHaveBeenCalledOnce(); expect(api.next).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("3 of 4 selected photos prepared");
  expect(host.textContent).not.toContain("photos remain queued");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.trim() === "Download ZIP")).toBe(true);
  expect(api.download).toHaveBeenCalledOnce(); // the old saved part was never downloaded again
});

// ------------------------------------------------- save all ZIPs to a folder
// The real photoFolderExport runs against a fake folder whose every step
// (getFileHandle, createWritable, write, close) can be held or made to fail.

type Step = "getFile" | "create" | "write" | "close";
function fakeFs() {
  const log: string[] = [];
  const hold: Partial<Record<Step, Promise<void>>> = {};
  const fail: Partial<Record<Step, boolean>> = {};
  const reached = new Set<Step>();
  const writers: { aborted: boolean; data: Blob | null }[] = [];
  const saved = new Map<string, Blob>();
  const present = new Set<string>();
  const step = async (name: Step) => { reached.add(name); log.push(name); if (hold[name]) await hold[name]; if (fail[name]) throw new Error(`${name} failed`); };
  const sub = {
    name: "",
    getDirectoryHandle: async () => { throw new Error("no nested folders"); },
    getFileHandle: async (file: string, opts?: { create?: boolean }) => {
      await step("getFile");
      if (!opts?.create && !present.has(file)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      present.add(file);
      return { createWritable: async () => {
        await step("create");
        const w = { aborted: false, data: null as Blob | null,
          write: async (b: Blob) => { await step("write"); w.data = b; },
          close: async () => { await step("close"); if (!w.aborted && w.data) saved.set(file, w.data); },
          abort: async () => { w.aborted = true; log.push("abort"); } };
        writers.push(w); return w;
      } };
    },
  };
  const root = {
    name: "Downloads",
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      log.push(opts?.create ? "dir:create" : "dir:look");
      if (!opts?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      sub.name = name; return sub;
    },
    getFileHandle: async () => { throw new Error("never write beside the export folder"); },
  };
  return { root, sub, log, hold, fail, reached, writers, saved, present };
}
function enableFolders(picker: () => Promise<unknown>) {
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("showDirectoryPicker", picker);
}
afterEach(() => { vi.unstubAllGlobals(); });
function radio(text: string) { const l = [...host.querySelectorAll("label")].find(e => e.textContent?.includes(text)); if (!l) throw new Error(`Missing option ${text}`); return l.querySelector("input")!; }
async function folderMode() {
  await act(async () => { radio("Save all ZIPs to a folder").click(); });
  await until(() => { const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent?.trim() === "Choose folder and start"); return !!b && !b.disabled; });
}
const part1 = { ...part, token: "f-1", number: 1, name: "photos_part-01.zip", zip: new File(["ZIP ONE"], "photos_part-01.zip"), itemIds: ["p1", "p2"], last: false };
const part2 = { ...part, token: "f-2", number: 2, name: "photos_part-02.zip", zip: new File(["ZIP TWO"], "photos_part-02.zip"), itemIds: ["p3"], last: true };

it("an unsupported browser keeps one ZIP at a time and says why", async () => {
  await mount();
  expect(radio("Save all ZIPs to a folder").disabled).toBe(true);
  expect(radio("One ZIP at a time").checked).toBe(true);
  expect(host.textContent).toContain("This browser can't save straight to a folder");
  await prepare();
  expect(button("Download ZIP")).toBeTruthy();
});

it("opens the picker straight from the tap, once, even on a double click", async () => {
  const picker = vi.fn(() => new Promise(() => {})); enableFolders(picker);
  await mount(); await folderMode();
  expect(host.textContent).toContain("Keep Forge open while ZIPs save. Each ZIP opens separately.");
  await act(async () => {
    const start = button("Choose folder and start");
    start.click(); expect(picker).toHaveBeenCalledOnce(); // synchronously, inside the tap
    start.click();
  });
  expect(picker).toHaveBeenCalledOnce(); expect(api.create).not.toHaveBeenCalled();
});

it("closing the picker is not an error and the export can start again", async () => {
  const picker = vi.fn(() => Promise.reject(new DOMException("closed", "AbortError"))); enableFolders(picker);
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); }); await tick();
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(api.create).not.toHaveBeenCalled();
  await until(() => !button("Choose folder and start").disabled);
  await act(async () => { button("Choose folder and start").click(); });
  expect(picker).toHaveBeenCalledTimes(2);
});

it("saves each ZIP into a fresh folder and prepares the next only after close", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  const close = deferred<void>(); fs.hold.close = close.promise;
  api.next.mockResolvedValueOnce(part1).mockResolvedValueOnce(part2);
  api.summary.mockReturnValue({ selected: 3, packaged: 3, failed: [], remaining: 0, partsPrepared: 2, state: "complete" });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => fs.reached.has("close"));
  expect(fs.log.slice(0, 2)).toEqual(["dir:look", "dir:create"]);
  expect(fs.sub.name).toMatch(/^photos_\d{4}-\d\d-\d\d_\d{6}_[0-9a-f]{32}$/);
  expect(api.next).toHaveBeenCalledOnce(); expect(api.release).not.toHaveBeenCalled();
  expect(host.textContent).toContain("0 ZIPs (0 photos)");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.trim() === "I saved this part — prepare next")).toBe(false);
  fs.hold.close = undefined; close.resolve();
  await until(() => !!host.textContent?.includes("All ZIPs are saved in the folder."));
  expect(host.textContent).toContain(`Saved in folder Downloads/${fs.sub.name}: 2 ZIPs (3 photos).`);
  expect(api.release.mock.calls).toEqual([["f-1"], ["f-2"]]); expect(api.next).toHaveBeenCalledTimes(2);
  expect([...fs.saved.keys()]).toEqual(["photos_part-01.zip", "photos_part-02.zip"]);
  expect(api.download).not.toHaveBeenCalled();
});

for (const failing of ["write", "close"] as const) {
  it(`a ${failing} failure keeps the same ZIP for retry or manual download without rebuilding`, async () => {
    const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail[failing] = true;
    api.next.mockResolvedValueOnce({ ...part1, last: true });
    await mount(); await folderMode();
    await act(async () => { button("Choose folder and start").click(); });
    await until(() => !!host.textContent?.includes("This ZIP was not saved."));
    expect(host.textContent).toContain("0 ZIPs (0 photos)"); expect(api.release).not.toHaveBeenCalled();
    await act(async () => { button("Download this ZIP instead").click(); });
    expect(api.download).toHaveBeenCalledOnce(); expect(api.download.mock.calls[0][0].zip).toBe(part1.zip);
    fs.fail[failing] = false;
    await act(async () => { button("Try saving this ZIP again").click(); });
    await until(() => !!host.textContent?.includes("All ZIPs are saved in the folder."));
    expect(await fs.saved.get("photos_part-01.zip")!.text()).toBe("ZIP ONE");
    expect(host.textContent).toContain("1 ZIP (2 photos)");
    expect(api.next).toHaveBeenCalledOnce(); expect(api.create).toHaveBeenCalledOnce();
    expect(api.release.mock.calls).toEqual([["f-1"]]); expect(api.revoke).toHaveBeenCalledOnce();
    // The retry reopened the handle Forge created: one lookup + one create in total.
    expect(fs.log.filter(l => l === "getFile")).toHaveLength(2);
  });
}

it("a ZIP name already taken in the export folder is not replaced and can be downloaded", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  fs.present.add("photos_part-01.zip");
  api.next.mockResolvedValueOnce({ ...part1, last: true });
  await mount(); await folderMode();
  expect(host.textContent).toContain("into a new export subfolder inside the folder you choose.");
  expect(host.textContent).not.toContain("Nothing already there");
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("Forge did not replace it."));
  expect(fs.reached.has("create")).toBe(false); expect(fs.saved.size).toBe(0);
  expect(api.release).not.toHaveBeenCalled();
  await act(async () => { button("Download this ZIP instead").click(); });
  expect(api.download.mock.calls[0][0].zip).toBe(part1.zip);
});

it("a double click on retry writes the held ZIP once", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail.write = true;
  api.next.mockResolvedValueOnce({ ...part1, last: true });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("This ZIP was not saved."));
  fs.fail.write = false; const writes = fs.log.filter(l => l === "write").length;
  await act(async () => { const retry = button("Try saving this ZIP again"); retry.click(); retry.click(); });
  await until(() => !!host.textContent?.includes("All ZIPs are saved in the folder."));
  expect(fs.log.filter(l => l === "write").length).toBe(writes + 1);
});

it("a ZIP that cannot be built lists its photos and continues only when asked", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  const failed = { selected: 3, packaged: 2, failed: [{ id: "bad", projectId: "job1", label: "Bad photo", reason: "zip_failed" }], remaining: 0, partsPrepared: 1, state: "partial" };
  api.next.mockResolvedValueOnce(part1).mockImplementationOnce(async () => { api.summary.mockReturnValue({ ...failed, remaining: 1, state: "active" }); throw new Error("ZIP broke"); })
    .mockImplementationOnce(async () => { api.summary.mockReturnValue(failed); return null; });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("A ZIP part could not be prepared."));
  expect(host.textContent).toContain("Bad photo: This ZIP part could not be built.");
  expect(api.next).toHaveBeenCalledTimes(2);
  await act(async () => { button("Continue saving remaining photos").click(); });
  await until(() => !!host.textContent?.includes("Finished. The photos listed below could not be included."));
  expect(api.next).toHaveBeenCalledTimes(3); expect(host.textContent).toContain("1 ZIP (2 photos)");
});

it("no saved ZIP is never reported as success", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  api.next.mockResolvedValueOnce(null);
  api.summary.mockReturnValue({ selected: 1, packaged: 0, failed: [{ id: "x", projectId: "job1", label: "Gone photo", reason: "network" }], remaining: 0, partsPrepared: 0, state: "partial" });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("No selected photos could be saved to the folder."));
  expect(host.textContent).not.toContain("All ZIPs are saved");
});

it("Stop during close says the current ZIP may have saved and prepares nothing more", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  const close = deferred<void>(); fs.hold.close = close.promise;
  api.next.mockResolvedValueOnce(part1).mockResolvedValueOnce(part2);
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => fs.reached.has("close"));
  await act(async () => { button("Stop saving").click(); });
  expect(host.textContent).toContain("Stopped; the current ZIP may have finished saving.");
  expect(fs.writers[0].aborted).toBe(true); // best effort: an invoked close may still commit
  close.resolve(); await tick(); await tick();
  expect(api.next).toHaveBeenCalledOnce(); expect(api.release).not.toHaveBeenCalled();
  expect(host.textContent).toContain("0 ZIPs (0 photos)"); expect(api.cancel).toHaveBeenCalled();
  expect(button("Start over in a new folder").disabled).toBe(false);
});

for (const stage of ["picker", "getFile", "create", "write", "close"] as const) {
  for (const boundary of ["sign out", "different person", "unmount", "stop"] as const) {
    it(`${boundary} while waiting on ${stage} writes and publishes nothing more`, async () => {
      const fs = fakeFs(); const picked = deferred<unknown>(); const held = deferred<void>();
      enableFolders(() => (stage === "picker" ? picked.promise : Promise.resolve(fs.root)));
      if (stage !== "picker") fs.hold[stage] = held.promise;
      api.next.mockResolvedValueOnce(part1).mockResolvedValueOnce(part2);
      await mount(); await folderMode();
      await act(async () => { button("Choose folder and start").click(); });
      if (stage !== "picker") await until(() => fs.reached.has(stage));
      await act(async () => {
        if (boundary === "sign out") rememberSignedIn(null);
        else if (boundary === "different person") rememberSignedIn(BOB);
        else if (boundary === "unmount") { root!.unmount(); root = null; }
        else button(stage === "picker" ? "Cancel preparation" : "Stop saving").click();
      });
      if (boundary === "sign out" || boundary === "different person") expect(close).toHaveBeenCalled();
      picked.resolve(fs.root); held.resolve(); await tick(); await tick();
      if (stage === "picker") { expect(fs.log).toEqual([]); expect(api.create).not.toHaveBeenCalled(); }
      expect(api.next.mock.calls.length).toBeLessThanOrEqual(1); expect(api.release).not.toHaveBeenCalled();
      // A writer that arrived late, or was writing or closing, is aborted — never left open.
      if (stage === "create" || stage === "write" || stage === "close") expect(fs.writers[0].aborted).toBe(true);
      if (stage === "create") expect(fs.log).not.toContain("write");
      if (stage !== "close") expect(fs.saved.size).toBe(0);
      expect(host.textContent).not.toContain("All ZIPs are saved");
      expect(host.textContent).not.toMatch(/[1-9] ZIPs? \(/);
    });
  }
}


it("manual fallback then folder saving counts and labels each delivery separately", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail.write = true;
  api.next.mockResolvedValueOnce(part1).mockResolvedValueOnce(part2);
  api.summary.mockReturnValue({ selected: 3, packaged: 3, failed: [], remaining: 0, partsPrepared: 2, state: "complete" });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("This ZIP was not saved."));
  expect(() => button("I saved this ZIP — continue with the rest")).toThrow();
  await act(async () => { button("Download this ZIP instead").click(); });
  fs.fail.write = false;
  await act(async () => { button("I saved this ZIP — continue with the rest").click(); });
  await until(() => !!host.textContent?.includes("Folder saving finished."));
  expect(host.textContent).toContain("1 ZIP (1 photo)");
  expect(host.textContent).toContain("You confirmed 1 ZIP was saved separately.");
  expect(host.textContent).not.toContain("All ZIPs are saved in the folder.");
  expect([...fs.saved.keys()]).toEqual([part2.name]);
  expect(api.release.mock.calls).toEqual([[part1.token], [part2.token]]);
  expect(api.revoke).toHaveBeenCalledOnce(); expect(api.create).toHaveBeenCalledOnce();
});

it("acknowledged manual completion of the only ZIP is not folder-save success or failure", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail.write = true;
  api.next.mockResolvedValueOnce({ ...part1, last: true }).mockResolvedValueOnce(null);
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("This ZIP was not saved."));
  await act(async () => { button("Download this ZIP instead").click(); });
  await act(async () => { button("I saved this ZIP — continue with the rest").click(); });
  await until(() => !!host.textContent?.includes("You confirmed 1 ZIP was saved separately."));
  expect(host.textContent).toContain("No ZIPs finished saving to this folder.");
  expect(host.textContent).not.toContain("No selected photos could be saved to the folder.");
  expect(host.textContent).not.toContain("All ZIPs are saved in the folder.");
  expect(fs.saved.size).toBe(0); expect(api.release.mock.calls).toEqual([[part1.token]]);
  expect(api.revoke).toHaveBeenCalledOnce();
});

it("failure on the second ZIP retries that ZIP without re-saving the first", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root));
  api.next.mockResolvedValueOnce(part1).mockResolvedValueOnce(part2);
  api.release.mockImplementation(token => { if (token === part1.token) fs.fail.write = true; });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("This ZIP was not saved."));
  const first = fs.saved.get(part1.name);
  expect(first).toBeDefined(); expect(host.textContent).toContain("1 ZIP (2 photos)");
  expect(api.release.mock.calls).toEqual([[part1.token]]);
  fs.fail.write = false;
  await act(async () => { button("Try saving this ZIP again").click(); });
  await until(() => !!host.textContent?.includes("All ZIPs are saved in the folder."));
  expect(host.textContent).toContain("2 ZIPs (3 photos)");
  expect(fs.saved.get(part1.name)).toBe(first);
  expect([...fs.saved.keys()]).toEqual([part1.name, part2.name]);
  expect(api.release.mock.calls).toEqual([[part1.token], [part2.token]]);
  expect(api.next).toHaveBeenCalledTimes(2); expect(fs.log.filter(l => l === "write")).toHaveLength(3);
});

it("repeated failed retries keep the manual acknowledgement and reuse the same URL", async () => {
  const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail.write = true;
  api.next.mockResolvedValueOnce({ ...part1, last: true });
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("This ZIP was not saved."));
  await act(async () => { button("Download this ZIP instead").click(); });
  await act(async () => { button("Try saving this ZIP again").click(); });
  await until(() => !button("Try saving this ZIP again").disabled);
  expect(button("I saved this ZIP — continue with the rest")).toBeDefined();
  await act(async () => { button("Download this ZIP instead").click(); });
  expect(api.download).toHaveBeenCalledOnce(); expect(api.redownload).toHaveBeenCalledOnce();
  expect(api.release).not.toHaveBeenCalled(); expect(api.next).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("0 ZIPs (0 photos)");
});

for (const change of ["selection", "mode", "kind"] as const) {
  it(`${change} change during a failed folder save clears the held ZIP and its URL`, async () => {
    const fs = fakeFs(); enableFolders(() => Promise.resolve(fs.root)); fs.fail.write = true;
    api.next.mockResolvedValueOnce({ ...part1, last: true });
    await mount(); await folderMode();
    await act(async () => { button("Choose folder and start").click(); });
    await until(() => !!host.textContent?.includes("This ZIP was not saved."));
    await act(async () => { button("Download this ZIP instead").click(); });
    await act(async () => {
      if (change === "selection") button("Clear selection").click();
      else if (change === "mode") radio("One ZIP at a time").click();
      else { const select = host.querySelector<HTMLSelectElement>("select")!; select.value = "receipt"; select.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    expect(api.cancel).toHaveBeenCalledOnce(); expect(api.revoke).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Saved in folder");
    expect(host.textContent).not.toContain("Download this ZIP instead");
    expect(api.next).toHaveBeenCalledOnce(); expect(api.release).not.toHaveBeenCalled();
  });
}

it("an existing export subfolder is refused before any export session or file write", async () => {
  const fs = fakeFs(); const rootFolder = { ...fs.root, getDirectoryHandle: vi.fn(async () => fs.sub) };
  enableFolders(() => Promise.resolve(rootFolder));
  await mount(); await folderMode();
  await act(async () => { button("Choose folder and start").click(); });
  await until(() => !!host.textContent?.includes("Forge did not use it."));
  expect(api.create).not.toHaveBeenCalled(); expect(api.next).not.toHaveBeenCalled();
  expect(rootFolder.getDirectoryHandle).toHaveBeenCalledOnce(); expect(fs.writers).toHaveLength(0);
});

it("receipt exports stay manual after toggling photo folder mode", async () => {
  const fs = fakeFs(); const picker = vi.fn(() => Promise.resolve(fs.root)); enableFolders(picker);
  await mount(); await folderMode();
  await act(async () => { const select = host.querySelector<HTMLSelectElement>("select")!; select.value = "receipt"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => { try { return !button("Prepare export").disabled; } catch { return false; } });
  expect(host.textContent).not.toContain("Save all ZIPs to a folder");
  await act(async () => { button("Prepare export").click(); });
  await until(() => !!host.textContent?.includes("1 files ready"));
  await act(async () => { button("Download ZIP").click(); });
  await until(() => api.receiptDownload.mock.calls.length === 1);
  expect(api.receiptPrepare).toHaveBeenCalledOnce(); expect(api.create).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled(); expect(fs.writers).toHaveLength(0);
});
