import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallOutboxRecord } from "../install/installOutbox";

vi.mock("../signedIn", () => ({ signedInUserId: vi.fn() }));
vi.mock("../offline/outbox", () => ({ pendingPhotoEntries: vi.fn() }));
vi.mock("../install/installOutbox", () => ({ listMyInstalls: vi.fn() }));
vi.mock("../offline/stableId", () => ({ stableId: vi.fn(async (key: string) => `derived:${key}`) }));

import { signedInUserId } from "../signedIn";
import { pendingPhotoEntries } from "../offline/outbox";
import { listMyInstalls } from "../install/installOutbox";
import { pendingWorkPhotos } from "./pendingWorkPhotos";

const old = Date.parse("2026-09-29T08:00:00Z");
function install(over: Partial<InstallOutboxRecord> = {}): InstallOutboxRecord {
  return {
    id: "install-1", status: "pending", step: "queued", installEventId: null,
    attemptCount: 0, nextAttemptAt: 0, lastError: null,
    payload: {
      clientKey: "install-key", openingId: "opening", projectId: "job", openingCode: "7",
      assignedWindowId: null, createdBy: "worker", ownerId: "worker",
      submitParams: {} as InstallOutboxRecord["payload"]["submitParams"], points: null,
      createdAt: new Date(old).toISOString(),
      media: [
        { bucket: "install-media", path: "p1", contentType: "image/jpeg", kind: "photo", clientId: "photo-1" },
        { bucket: "install-media", path: "v1", contentType: "audio/mp4", kind: "voice_memo" },
      ],
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(signedInUserId).mockReturnValue("worker");
  vi.mocked(pendingPhotoEntries).mockResolvedValue([]);
  vi.mocked(listMyInstalls).mockResolvedValue([]);
});

describe("Work photo heads-up across both offline queues", () => {
  it("counts pending install photos before the upload handoff, never audio", async () => {
    vi.mocked(listMyInstalls).mockResolvedValue([install()]);
    expect(await pendingWorkPhotos()).toEqual({ count: 1, oldestAt: old });
  });

  it("counts the same photo once during an interrupted handoff", async () => {
    vi.mocked(pendingPhotoEntries).mockResolvedValue([{ id: "photo-1", createdAt: old + 1000 }]);
    vi.mocked(listMyInstalls).mockResolvedValue([install()]);
    expect(await pendingWorkPhotos()).toEqual({ count: 1, oldestAt: old });
  });

  it("excludes failed or completed installs and derives old media IDs", async () => {
    vi.mocked(listMyInstalls).mockResolvedValue([
      install({ id: "failed", status: "failed" }),
      install({ id: "complete", step: "media_done" }),
      install({ payload: { ...install().payload, media: [{ bucket: "install-media", path: "p2", contentType: "image/jpeg", kind: "photo" }] } }),
    ]);
    expect(await pendingWorkPhotos()).toEqual({ count: 1, oldestAt: old });
  });

  it("shows nothing if the phone changes accounts during the read", async () => {
    vi.mocked(signedInUserId).mockReturnValueOnce("worker").mockReturnValueOnce("other");
    vi.mocked(listMyInstalls).mockResolvedValue([install()]);
    expect(await pendingWorkPhotos()).toEqual({ count: 0, oldestAt: null });
  });

  it("still warns about uploads if the install store cannot open", async () => {
    vi.mocked(pendingPhotoEntries).mockResolvedValue([{ id: "uploaded-next", createdAt: old }]);
    vi.mocked(listMyInstalls).mockRejectedValue(new Error("IndexedDB unavailable"));
    expect(await pendingWorkPhotos()).toEqual({ count: 1, oldestAt: old });
  });
});
