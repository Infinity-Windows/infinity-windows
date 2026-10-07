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
