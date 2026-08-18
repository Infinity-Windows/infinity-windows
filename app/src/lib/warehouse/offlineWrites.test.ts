// The one rule that matters: "no signal" queues, a REAL rejection does not.
// Queueing a genuine error would bury it in the dead-letter and the person
// standing in the conex would never learn they were wrong.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What both take paths must receive — including the key that guards a retry. */
interface KeyedTake {
  supplyId: string;
  projectId: string;
  qty: number;
  clientId: string;
}

const storePackages = vi.fn();
const checkoutPackages = vi.fn();
const bindPackage = vi.fn();
const stagePackages = vi.fn();
const moveContainer = vi.fn();
const takeSupply = vi.fn<(input: KeyedTake) => Promise<unknown>>();
const enqueueStorePackages = vi.fn(async () => "entry-1");
const enqueueCheckoutPackages = vi.fn(async () => "entry-2");
const enqueueTakeSupply = vi.fn<(input: KeyedTake) => Promise<string>>(
  async () => "entry-3",
);
const enqueueBindPackage = vi.fn(async () => "entry-4");
const enqueueStagePackages = vi.fn(async () => "entry-5");
const enqueueMoveContainer = vi.fn(async () => "entry-6");

vi.mock("../storage", () => ({
  storePackages,
  checkoutPackages,
  bindPackage,
  stagePackages,
  moveContainer,
}));
vi.mock("../ops", () => ({ takeSupply }));
vi.mock("../offline/outbox", () => ({
  enqueueStorePackages,
  enqueueCheckoutPackages,
  enqueueTakeSupply,
  enqueueBindPackage,
  enqueueStagePackages,
  enqueueMoveContainer,
}));

const {
  bindPackageOffline,
  checkoutPackagesOffline,
  moveContainerOffline,
  stagePackagesOffline,
  storePackagesOffline,
  takeSupplyOffline,
  tagToast,
  writeToast,
} = await import("./offlineWrites");

/** A tag as the screen builds it: sticker, job, and what is printed on it. */
const TAG = {
  packageId: "pkg-1",
  projectId: "job-1",
  category: "windows" as const,
  note: null,
  marks: ["A1"],
  deliveryId: "del-1",
  partIndex: 2,
  partTotal: 3,
  partType: "frame" as const,
  mfrMark: "16",
};

beforeEach(() => {
  vi.clearAllMocks();
});

/** A package off the truck: tagged, in no container yet. */
const LOOSE = (id: string) => ({ id, status: "received", container_id: null });

describe("with signal", () => {
  it("goes straight to the server and never queues", async () => {
    storePackages.mockResolvedValue(3);
    const r = await storePackagesOffline(
      [LOOSE("a"), LOOSE("b"), LOOSE("c")],
      "conex",
    );
    expect(r).toEqual({ count: 3, queued: false });
    expect(enqueueStorePackages).not.toHaveBeenCalled();
  });

  it("hands back the bound package a tag came home with", async () => {
    bindPackage.mockResolvedValue({ id: "pkg-1", serial: "INF-0001" });
    const r = await bindPackageOffline(TAG);
    expect(r.queued).toBe(false);
    expect(r.package).toEqual({ id: "pkg-1", serial: "INF-0001" });
    expect(enqueueBindPackage).not.toHaveBeenCalled();
  });

  it("sets aside straight through", async () => {
    stagePackages.mockResolvedValue(2);
    const r = await stagePackagesOffline([LOOSE("a"), LOOSE("b")], "job-1");
    expect(r).toEqual({ count: 2, queued: false });
    expect(enqueueStagePackages).not.toHaveBeenCalled();
  });

  // The online set-aside is one round trip and carries NO note, exactly as it
  // was before it went on the queue. The note answers "is this still true
  // after sitting in a queue", and a write that never sat in one has nothing
  // to ask — paying for a bigger body on every live press would be a cost for
  // no answer.
  it("sends no note when it goes straight to the server", async () => {
    stagePackages.mockResolvedValue(2);
    await stagePackagesOffline([LOOSE("a"), LOOSE("b")], "job-1");
    expect(stagePackages).toHaveBeenCalledTimes(1);
    expect(stagePackages).toHaveBeenCalledWith(["a", "b"], "job-1");
  });

  it("moves a container straight through", async () => {
    moveContainer.mockResolvedValue({ id: "crate-1" });
    const r = await moveContainerOffline({
      containerId: "crate-1",
      parentContainerId: "conex-9",
    });
    expect(r.queued).toBe(false);
    expect(enqueueMoveContainer).not.toHaveBeenCalled();
  });
});

describe("no signal", () => {
  it("queues a check-in and reports the work as done", async () => {
    storePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await storePackagesOffline([LOOSE("a"), LOOSE("b")], "conex");
    expect(r).toEqual({ count: 2, queued: true });
    expect(enqueueStorePackages).toHaveBeenCalledWith(["a", "b"], "conex", {
      a: { status: "received", container: null },
      b: { status: "received", container: null },
    });
  });

  it("queues what it BELIEVED about each package, not a blank note", async () => {
    // The whole of F2. Without this note the write says only "put these in
    // Conex 7", so when it finally goes up it lands on top of whatever
    // happened while the phone was in the conex — a checkout made one minute
    // ago loses to a tap made ten minutes ago, silently.
    storePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    await storePackagesOffline(
      [
        { id: "a", status: "stored", container_id: "conex-3" },
        { id: "b", status: "checked_out", container_id: null },
      ],
      "conex-7",
    );
    expect(enqueueStorePackages).toHaveBeenCalledWith(["a", "b"], "conex-7", {
      a: { status: "stored", container: "conex-3" },
      b: { status: "checked_out", container: null },
    });
  });

  it("queues a check-out with its reason and job", async () => {
    checkoutPackages.mockRejectedValue(new Error("Network error"));
    const r = await checkoutPackagesOffline(["a"], "install day", "job-1");
    expect(r.queued).toBe(true);
    expect(enqueueCheckoutPackages).toHaveBeenCalledWith({
      packageIds: ["a"],
      reason: "install day",
      projectId: "job-1",
    });
  });

  it("queues a tag with everything printed on the sticker", async () => {
    bindPackage.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await bindPackageOffline(TAG);
    expect(r.queued).toBe(true);
    // No row to hand back: the server never answered, so there is no serial,
    // no bound_at and no id from it. The screen must use what it already has.
    expect(r.package).toBeNull();
    expect(enqueueBindPackage).toHaveBeenCalledWith(TAG);
  });

  it("queues a set-aside with its job", async () => {
    stagePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await stagePackagesOffline([LOOSE("a"), LOOSE("b")], "job-1");
    expect(r).toEqual({ count: 2, queued: true });
    expect(enqueueStagePackages).toHaveBeenCalledWith(["a", "b"], "job-1", {
      a: { status: "received", container: null, location: null },
      b: { status: "received", container: null, location: null },
    });
  });

  // Set-aside got put on the queue by F3, which handed it the very race F2
  // had just closed for check-in. Without this note the write says only "put
  // these on BLACK22's shelf", so when it finally goes up it lands on top of
  // whatever happened while the phone was in the conex.
  //
  // The SHELF is in the note and is not in check-in's, and that is the whole
  // difference: a package already set aside on another job's bay has the same
  // status and the same empty container — only the shelf moved. A note
  // without it waves that straight through and drags PECAN14's material onto
  // BLACK22's shelf in the record.
  it("queues the shelf it believed as well as the box", async () => {
    stagePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    await stagePackagesOffline(
      [
        { id: "a", status: "stored", container_id: "conex-3", location_id: null },
        { id: "b", status: "stored", container_id: null, location_id: "bay-pecan14" },
      ],
      "job-1",
    );
    expect(enqueueStagePackages).toHaveBeenCalledWith(["a", "b"], "job-1", {
      a: { status: "stored", container: "conex-3", location: null },
      b: { status: "stored", container: null, location: "bay-pecan14" },
    });
  });

  // A row read from a database the shelf-column migration hasn't reached has
  // no location_id at all. "No key" has to mean "on no shelf" and not
  // "undefined", or the note stops being JSON the database can compare.
  it("reads a row with no shelf column as being on no shelf", async () => {
    stagePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    await stagePackagesOffline([{ id: "a", status: "received", container_id: null }], "job-1");
    expect(enqueueStagePackages).toHaveBeenCalledWith(["a"], "job-1", {
      a: { status: "received", container: null, location: null },
    });
  });

  it("queues a container move with where it was headed", async () => {
    moveContainer.mockRejectedValue(new Error("Network error"));
    const r = await moveContainerOffline({
      containerId: "crate-1",
      parentContainerId: "conex-9",
    });
    expect(r.queued).toBe(true);
    expect(enqueueMoveContainer).toHaveBeenCalledWith({
      containerId: "crate-1",
      parentContainerId: "conex-9",
    });
  });

  it("queues a supply take", async () => {
    takeSupply.mockRejectedValue(new Error("failed to fetch"));
    const r = await takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 3 });
    expect(r).toEqual({ count: 3, queued: true });
    expect(enqueueTakeSupply).toHaveBeenCalled();
  });

  // Warehouse audit F1, and the whole point of the fix. A dead connection and
  // "the server took it but the answer never came back" look identical from
  // here, so this fallback fires in BOTH cases. If the queued copy carried a
  // new key, the second case would subtract the tubes twice.
  it("sends the queued copy of a take under the same key the live try used", async () => {
    takeSupply.mockRejectedValue(new TypeError("Failed to fetch"));
    await takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 4 });

    expect(takeSupply).toHaveBeenCalledTimes(1);
    expect(enqueueTakeSupply).toHaveBeenCalledTimes(1);
    const live = takeSupply.mock.calls[0][0];
    const queued = enqueueTakeSupply.mock.calls[0][0];
    expect(typeof live.clientId).toBe("string");
    expect(live.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(queued.clientId).toBe(live.clientId);
  });

  it("gives two separate takes two different keys", async () => {
    takeSupply.mockRejectedValue(new TypeError("Failed to fetch"));
    await takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 1 });
    await takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 1 });
    const first = enqueueTakeSupply.mock.calls[0][0];
    const second = enqueueTakeSupply.mock.calls[1][0];
    expect(first.clientId).not.toBe(second.clientId);
  });
});

describe("a real rejection is NOT queued", () => {
  it("surfaces 'container not found' instead of burying it", async () => {
    storePackages.mockRejectedValue(new Error("container not found or inactive"));
    await expect(storePackagesOffline([LOOSE("a")], "gone")).rejects.toThrow(
      "container not found",
    );
    expect(enqueueStorePackages).not.toHaveBeenCalled();
  });

  it("surfaces a missing reason", async () => {
    checkoutPackages.mockRejectedValue(
      new Error("pick a reason for taking the material"),
    );
    await expect(checkoutPackagesOffline(["a"], "", "job-1")).rejects.toThrow();
    expect(enqueueCheckoutPackages).not.toHaveBeenCalled();
  });

  // The sticker rule, and the one a queued tag must never bury: a sticker is
  // bound to one package for life, so "already assigned" means somebody has
  // to fetch a fresh sticker — standing there, now, not tomorrow off a
  // dead-letter screen.
  it("surfaces an already-assigned sticker instead of queueing it", async () => {
    bindPackage.mockRejectedValue(
      new Error(
        "that sticker is already assigned — a package ID never moves to another package",
      ),
    );
    await expect(bindPackageOffline(TAG)).rejects.toThrow("already assigned");
    expect(enqueueBindPackage).not.toHaveBeenCalled();
  });

  it("surfaces a job with no staging bay", async () => {
    stagePackages.mockRejectedValue(new Error("this job has no staging bay yet"));
    await expect(stagePackagesOffline([LOOSE("a")], "job-1")).rejects.toThrow(
      "no staging bay",
    );
    expect(enqueueStagePackages).not.toHaveBeenCalled();
  });

  it("surfaces a move into a container that is gone", async () => {
    moveContainer.mockRejectedValue(
      new Error("destination container not found or inactive"),
    );
    await expect(
      moveContainerOffline({ containerId: "crate-1", parentContainerId: "gone" }),
    ).rejects.toThrow("not found");
    expect(enqueueMoveContainer).not.toHaveBeenCalled();
  });

  it("surfaces a permission failure rather than retrying it forever", async () => {
    takeSupply.mockRejectedValue(new Error("permission denied for supplies"));
    await expect(
      takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 1 }),
    ).rejects.toThrow("permission denied");
    expect(enqueueTakeSupply).not.toHaveBeenCalled();
  });
});

describe("what the person is told", () => {
  it("says plainly when it is only on the phone", () => {
    expect(writeToast({ count: 2, queued: true }, "2 packages checked in")).toBe(
      "2 packages checked in — not sent yet, no signal in here.",
    );
  });

  it("says nothing extra when it landed", () => {
    expect(writeToast({ count: 2, queued: false }, "2 packages checked in")).toBe(
      "2 packages checked in",
    );
  });
});

// Tagging gets its own line because the QUEUED state changes what is true,
// not just where the write got to. "Permanent" is a fact about the database:
// bind_package refuses a second bind forever after. Until the tag lands there
// is nothing permanent about it, and saying otherwise is how somebody decides
// a sticker is spent and reaches for the next one.
describe("what a tag says", () => {
  it("claims permanence only once the server has it", () => {
    expect(tagToast("INF-0001", false)).toBe(
      "INF-0001 assigned — sticker is now permanent.",
    );
  });

  it("does not call a queued tag permanent", () => {
    const line = tagToast("INF-0001", true);
    expect(line).not.toContain("is now permanent");
  });

  // And it must not say the opposite either. "The sticker is not permanent
  // until it goes up" reads, to somebody holding the roll, as "this one is
  // still free" — and CONTEXT.md's sticker rule is that one is bound to one
  // package for its whole life and never reused. There is nothing to act on:
  // a queued tag cannot be edited or called back from any screen (StuckWrites
  // only lists writes that have already given up), so the line says where it
  // got to and that it sends itself.
  it("never suggests a queued sticker is still free", () => {
    const line = tagToast("INF-0001", true);
    expect(line).not.toContain("not permanent");
    expect(line).toBe(
      "INF-0001 assigned — saved on this phone and not sent yet. " +
        "It goes up on its own when you have signal.",
    );
  });
});
