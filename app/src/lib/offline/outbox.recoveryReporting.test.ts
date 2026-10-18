// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

vi.mock("../supabase", () => ({ supabase: {}, clientWithToken: vi.fn(), supabaseConfigured: true }));
vi.mock("../install/legacyUploadQueue", () => ({ migrateLegacyUploads: vi.fn() }));
vi.mock("./outboxStore", async importOriginal => {
  const actual = await importOriginal<typeof import("./outboxStore")>();
  const fixtureStore = new actual.MemoryOutboxStore();
  return { ...actual, createDefaultStore: () => fixtureStore, fixtureStore };
});
let outbox: typeof import("./outbox");
let store: import("./outbox-core").OutboxStore;
let events: typeof import("./telemetry");
let migrate: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const storage = await import("./outboxStore") as unknown as { fixtureStore: typeof store };
  store = storage.fixtureStore;
  migrate = vi.mocked((await import("../install/legacyUploadQueue")).migrateLegacyUploads);
  migrate.mockReset().mockResolvedValue({ moved: 0, left: 0, dropped: 0 });
  (await import("../signedIn")).rememberSignedIn({ user: { id: "owner", email: "owner@example.test" } });
  events = await import("./telemetry");
  outbox = await import("./outbox");
});
afterEach(() => { outbox.stopOutboxAutoFlush(); vi.restoreAllMocks(); });
const recovery = () => events.getOfflineEvents().filter(e => e.scope === "recovery");
const photo = (id: string): OutboxEntry => ({ id, op: "photo_upload", ownerId: "owner", payload: { kind: "photo", createdBy: "owner@example.test", path: `${id}.jpg` }, createdAt: 1, status: "failed", attemptCount: 8, lastError: "Load failed", hasBlob: true, nextAttemptAt: 99_999, dependsOn: null });

it("reports a legacy read failure without logging raw errors or replaying migration on ordinary wakes", async () => {
  migrate.mockRejectedValue(new Error("private secret and path"));
  await outbox.recoverAndDrain(); await outbox.drain();
  expect(recovery()).toEqual([expect.objectContaining({ message: expect.stringContaining("Legacy upload recovery could not finish") })]);
  expect(JSON.stringify(events.getOfflineEvents())).not.toContain("private secret");
  expect(migrate).toHaveBeenCalledTimes(1);
});

it("distinguishes unresolved legacy uploads from rows removed by the existing importer", async () => {
  migrate.mockResolvedValue({ moved: 1, left: 2, dropped: 1 });
  await outbox.recoverAndDrain();
  expect(recovery()).toEqual([expect.objectContaining({ count: 3, message: expect.stringContaining("2 legacy uploads remain unresolved; 1 unreadable legacy rows were removed") })]);
});

it("reports a saved-write read failure rather than treating it as an empty successful recovery", async () => {
  vi.spyOn(store, "getAll").mockRejectedValueOnce(new Error("storage unavailable"));
  await outbox.recoverAndDrain();
  expect(recovery()).toEqual([expect.objectContaining({ message: expect.stringContaining("Saved-write recovery could not finish") })]);
});

it("aggregates unreadable or missing originals while preserving other photos and foreign work", async () => {
  const missing = photo("missing"), broken = photo("broken"), good = photo("good");
  const foreign = { ...photo("foreign"), ownerId: "other" };
  await store.put(missing); await store.put(broken, new Blob(["broken original"]));
  await store.put(good, new Blob(["good original"])); await store.put(foreign);
  const read = store.getBlob.bind(store);
  vi.spyOn(store, "getBlob").mockImplementation(id => id === broken.id ? Promise.reject(new Error("private path")) : read(id));
  await outbox.recoverAndDrain();
  expect(recovery()).toEqual([expect.objectContaining({ count: 2, message: expect.stringContaining("Photo recovery is incomplete") })]);
  const rows = await store.getAll();
  expect(rows.find(e => e.id === good.id)).toMatchObject({ status: "queued", id: good.id, payload: good.payload });
  for (const e of [missing, broken, foreign]) expect(rows.find(r => r.id === e.id)).toEqual(e);
  expect(await (await read(broken.id))!.text()).toBe("broken original");
  expect(await (await read(good.id))!.text()).toBe("good original");
  expect(JSON.stringify(recovery())).not.toContain("private path");
});
