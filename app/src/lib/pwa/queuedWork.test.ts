// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every queue is a real module with its own store; here each is a double so
// the composition — sum the waiting, OR the in-flight flags, skip what has
// failed, read an unreadable queue as empty — is what is under test.
const q = vi.hoisted(() => ({
  outboxPending: 0,
  outboxDraining: false,
  installsPending: 0,
  installsFlushing: false,
  uploadsPending: 0,
  uploadsFlushing: false,
  work: [] as Array<{ error?: string }>,
  service: [] as Array<{ error?: string }>,
  media: [] as Array<{ error?: string }>,
  outboxListeners: new Set<() => void>(),
  installListeners: new Set<() => void>(),
  throwOn: new Set<string>(),
}));

const maybeThrow = (name: string) => {
  if (q.throwOn.has(name)) throw new Error(`${name} unreadable`);
};

vi.mock("../offline/outbox", () => ({
  isDraining: () => q.outboxDraining,
  pendingWriteCount: async () => {
    maybeThrow("outbox");
    return q.outboxPending;
  },
  subscribe: (cb: () => void) => {
    q.outboxListeners.add(cb);
    return () => q.outboxListeners.delete(cb);
  },
}));
vi.mock("../install/installOutbox", () => ({
  isFlushingInstalls: () => q.installsFlushing,
  pendingInstallCount: async () => {
    maybeThrow("installs");
    return q.installsPending;
  },
  subscribeSyncListeners: (cb: () => void) => {
    q.installListeners.add(cb);
    return () => q.installListeners.delete(cb);
  },
}));
vi.mock("../install/queue", () => ({
  isFlushingUploads: () => q.uploadsFlushing,
  pendingUploadCount: async () => {
    maybeThrow("uploads");
    return q.uploadsPending;
  },
}));
vi.mock("../customWork/queue", () => ({
  WORK_QUEUE_EVENT: "forge:custom-work-queue",
  readWorkQueue: () => {
    maybeThrow("work");
    return q.work;
  },
}));
vi.mock("../servicing/queue", () => ({
  SERVICE_QUEUE_EVENT: "forge:service-queue",
  readServiceQueue: () => {
    maybeThrow("service");
    return q.service;
  },
}));
vi.mock("../servicing/mediaQueue", () => ({
  pendingServiceMedia: async () => {
    maybeThrow("media");
    return q.media;
  },
}));

import { blocksReload, readQueuedWork, subscribeQueuedWork } from "./queuedWork";

beforeEach(() => {
  q.outboxPending = 0;
  q.outboxDraining = false;
  q.installsPending = 0;
  q.installsFlushing = false;
  q.uploadsPending = 0;
  q.uploadsFlushing = false;
  q.work = [];
  q.service = [];
  q.media = [];
  q.throwOn.clear();
});

afterEach(() => {
  q.outboxListeners.clear();
  q.installListeners.clear();
});

describe("readQueuedWork", () => {
  it("reads an idle phone as nothing queued", async () => {
    const r = await readQueuedWork("crew-1");
    expect(r).toEqual({ waiting: 0, sending: false });
    expect(blocksReload(r)).toBe(false);
  });

  it("adds up every queue, the legacy upload queue included", async () => {
    // The sync pill never counted wops-upload-queue; a reload does not care
    // which pill a photo is missing from.
    q.outboxPending = 1;
    q.installsPending = 2;
    q.uploadsPending = 3;
    q.work = [{}];
    q.service = [{}, {}];
    q.media = [{}];
    const r = await readQueuedWork("crew-1");
    expect(r.waiting).toBe(10);
    expect(blocksReload(r)).toBe(true);
  });

  it.each([
    ["the main outbox", () => (q.outboxDraining = true)],
    ["the install outbox", () => (q.installsFlushing = true)],
    ["the upload queue", () => (q.uploadsFlushing = true)],
  ])("reports %s draining even when every count is zero", async (_label, arrange) => {
    // A drain that has just removed its last row is still a drain: the
    // server may hold the write while the phone has not finished recording
    // that it was taken.
    arrange();
    const r = await readQueuedWork("crew-1");
    expect(r).toEqual({ waiting: 0, sending: true });
    expect(blocksReload(r)).toBe(true);
  });

  it("does not count what has given up", async () => {
    // A refused command, a failed transcription: stopped trying, so a reload
    // cannot resend it, and a stuck row must not block updates forever.
    q.work = [{ error: "refused" }];
    q.service = [{ error: "refused" }];
    q.media = [{ error: "transcription failed" }];
    expect((await readQueuedWork("crew-1")).waiting).toBe(0);
  });

  it("skips the per-person queues with nobody signed in", async () => {
    q.work = [{}];
    q.service = [{}];
    q.media = [{}];
    expect((await readQueuedWork(null)).waiting).toBe(0);
  });

  it.each(["outbox", "installs", "uploads", "work", "service", "media"])(
    "reads a queue it cannot open (%s) as empty rather than failing the whole read",
    async (name) => {
      q.throwOn.add(name);
      q.outboxPending = q.installsPending = q.uploadsPending = 1;
      q.work = [{}];
      q.service = [{}];
      q.media = [{}];
      const r = await readQueuedWork("crew-1");
      expect(r.waiting).toBe(5);
    },
  );
});

describe("subscribeQueuedWork", () => {
  it("hears every queue that announces itself, until unsubscribed", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQueuedWork(listener);
    // The servicing event name is loaded lazily.
    await new Promise((r) => setTimeout(r, 0));

    for (const cb of q.outboxListeners) cb();
    for (const cb of q.installListeners) cb();
    window.dispatchEvent(new Event("forge:custom-work-queue"));
    window.dispatchEvent(new Event("forge:service-queue"));
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    expect(q.outboxListeners.size).toBe(0);
    expect(q.installListeners.size).toBe(0);
    window.dispatchEvent(new Event("forge:custom-work-queue"));
    window.dispatchEvent(new Event("forge:service-queue"));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
