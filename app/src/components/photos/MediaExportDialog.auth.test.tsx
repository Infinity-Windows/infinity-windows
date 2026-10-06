// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../../lib/signedIn";

const api = vi.hoisted(() => ({
  list: vi.fn(), projects: vi.fn(), prepare: vi.fn(), zip: vi.fn(), download: vi.fn(), share: vi.fn(), preview: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: api.projects }));
vi.mock("../../lib/photos", () => ({ signedMedia: api.preview }));
vi.mock("../../lib/mediaExport", () => ({
  listMediaExportItems: api.list, prepareMediaExport: api.prepare, mediaExportZip: api.zip,
  downloadMediaBlob: api.download, shareMediaFiles: api.share, canShareMediaFiles: () => true,
  mediaExportRangeError: () => null, mediaExportName: () => "photos.zip",
  isMediaShareCancel: (e: { name?: string }) => e?.name === "AbortError",
  MediaExportDataError: class extends Error {},
}));
import MediaExportDialog from "./MediaExportDialog";

const ALICE = { user: { id: "alice", email: "alice@example.test" } };
const BOB = { user: { id: "bob", email: "bob@example.test" } };
const row = { id: "alice-photo", projectId: "job1", date: "2026-10-05", label: "Alice photo", storagePath: "install-media/alice.jpg", documentPath: null, kind: "photo" };
let root: Root | null;
let host: HTMLDivElement;
let client: QueryClient;
let close = vi.fn<() => void>();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function button(name: string) { const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent?.trim() === name); if (!b) throw new Error(`Missing button ${name}`); return b; }
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 2)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await tick(); expect(check()).toBe(true); }
async function mount(key = "dialog", wait = true) {
  await act(async () => { root!.render(<QueryClientProvider client={client}><MediaExportDialog key={key} kind="photo" projectId="job1" onClose={close} /></QueryClientProvider>); });
  if (wait) await until(() => !!host.querySelector("button") && !button("Prepare export").disabled);
}
async function prepare() { await act(async () => { button("Prepare export").click(); }); await until(() => host.textContent?.includes("files ready") === true); }
beforeEach(() => {
  rememberSignedIn(ALICE); close = vi.fn<() => void>();
  for (const mock of Object.values(api)) mock.mockReset();
  api.projects.mockResolvedValue([{ id: "job1", job_code: "JOB1", name: "Job one" }]);
  api.list.mockResolvedValue([row]);
  api.prepare.mockResolvedValue({ files: [new File(["private Alice photo"], "alice.jpg", { type: "image/jpeg" })], failed: [] });
  api.zip.mockResolvedValue(new Blob(["zip"])); api.share.mockResolvedValue(undefined); api.preview.mockResolvedValue("https://fixture.test/alice.jpg");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); client.clear(); host.remove(); rememberSignedIn(null); });

for (const boundary of ["different person", "sign out", "same person new sign-in", "unmount"] as const) {
  it(`does not publish a deferred ZIP after ${boundary}`, async () => {
    const zip = deferred<Blob>(); api.zip.mockReturnValue(zip.promise);
    await mount(); await prepare(); await act(async () => { button("Download ZIP").click(); });
    expect(api.zip).toHaveBeenCalledOnce();
    await act(async () => {
      if (boundary === "different person") rememberSignedIn(BOB);
      else if (boundary === "sign out") rememberSignedIn(null);
      else if (boundary === "same person new sign-in") { rememberSignedIn(null); rememberSignedIn(ALICE); }
      else { root!.unmount(); root = null; }
    });
    zip.resolve(new Blob(["Alice private ZIP"])); await tick();
    expect(api.download).not.toHaveBeenCalled();
  });
}

it("retained buttons refuse sharing and individual downloads before the auth render commits", async () => {
  await mount(); await prepare();
  const share = button("Share / Email");
  const one = host.querySelector<HTMLButtonElement>('button[aria-label="Download alice.jpg"]')!;
  await act(async () => { rememberSignedIn(BOB); share.click(); one.click(); });
  expect(api.share).not.toHaveBeenCalled(); expect(api.download).not.toHaveBeenCalled();
});

it("discards a deferred prepare and forwards auth cancellation", async () => {
  const pending = deferred<{ files: File[]; failed: never[] }>(); api.prepare.mockReturnValue(pending.promise);
  await mount(); await act(async () => { button("Prepare export").click(); });
  const signal = api.prepare.mock.calls[0][2].signal as AbortSignal;
  await act(async () => { rememberSignedIn(BOB); });
  expect(signal.aborted).toBe(true);
  pending.resolve({ files: [new File(["private"], "alice.jpg")], failed: [] }); await tick();
  expect(host.textContent).not.toContain("alice.jpg"); expect(api.download).not.toHaveBeenCalled();
});

it("discards a preview URL that arrives after an account change", async () => {
  const pending = deferred<string>(); api.preview.mockReturnValue(pending.promise);
  await mount(); await act(async () => { button("Preview").click(); });
  await act(async () => { rememberSignedIn(BOB); });
  pending.resolve("https://fixture.test/private-alice.jpg"); await tick();
  expect(host.querySelector('img[src="https://fixture.test/private-alice.jpg"]')).toBeNull();
});

it("still downloads and shares for the unchanged person, including token refresh", async () => {
  await mount(); await prepare(); await act(async () => { rememberSignedIn(ALICE); button("Download ZIP").click(); }); await tick();
  expect(api.download).toHaveBeenCalledOnce();
  await act(async () => { button("Share / Email").click(); }); expect(api.share).toHaveBeenCalledOnce();
});

it("a retained Prepare button cannot start an old selection after the auth boundary", async () => {
  await mount(); const start = button("Prepare export");
  await act(async () => { rememberSignedIn(BOB); start.click(); });
  expect(api.prepare).not.toHaveBeenCalled();
});

it("a fresh Bob dialog receives neither Alice files nor Alice's export-list cache", async () => {
  await mount(); await prepare(); await act(async () => { rememberSignedIn(BOB); });
  api.list.mockResolvedValue([{ ...row, id: "bob-photo", label: "Bob photo", storagePath: "install-media/bob.jpg" }]);
  await mount("bob");
  expect(host.textContent).toContain("Bob photo"); expect(host.textContent).not.toContain("Alice photo"); expect(host.textContent).not.toContain("alice.jpg");
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("late metadata is aborted and never reaches a fresh Bob dialog", async () => {
  const pending = deferred<typeof row[]>(); api.list.mockReturnValueOnce(pending.promise);
  await mount("alice", false); await until(() => api.list.mock.calls.length === 1);
  const oldSignal = api.list.mock.calls[0][2] as AbortSignal;
  await act(async () => { rememberSignedIn(BOB); }); expect(oldSignal.aborted).toBe(true);
  api.list.mockResolvedValue([{ ...row, id: "bob-photo", label: "Bob photo" }]);
  await mount("bob"); pending.resolve([row]); await tick();
  expect(host.textContent).toContain("Bob photo"); expect(host.textContent).not.toContain("Alice photo");
});
