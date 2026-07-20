import { describe, expect, it, vi } from "vitest";
import {
  notifyLocalWith,
  planNotification,
  type LocalNotification,
  type NotifyEnv,
} from "./notifyLocal";

describe("planNotification", () => {
  it("is a no-op unless permission is granted", () => {
    const empty = new Set<string>();
    expect(planNotification("default", "a", empty)).toEqual({
      show: false,
      reason: "not-granted",
    });
    expect(planNotification("denied", "a", empty)).toEqual({
      show: false,
      reason: "not-granted",
    });
    expect(planNotification(null, "a", empty)).toEqual({
      show: false,
      reason: "not-granted",
    });
  });

  it("shows once then dedupes by tag", () => {
    expect(planNotification("granted", "tag1", new Set())).toEqual({
      show: true,
      reason: "show",
    });
    expect(planNotification("granted", "tag1", new Set(["tag1"]))).toEqual({
      show: false,
      reason: "duplicate",
    });
  });
});

function makeEnv(over: Partial<NotifyEnv> = {}): {
  env: NotifyEnv;
  showNotification: ReturnType<typeof vi.fn>;
  constructNotification: ReturnType<typeof vi.fn>;
} {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const constructNotification = vi.fn();
  const env: NotifyEnv = {
    getPermission: () => "granted",
    getRegistration: async () =>
      ({ showNotification }) as unknown as ServiceWorkerRegistration,
    canConstructNotification: () => true,
    constructNotification,
    ...over,
  };
  return { env, showNotification, constructNotification };
}

const opts: LocalNotification = { title: "Hi", body: "there", tag: "t" };

describe("notifyLocalWith", () => {
  it("does nothing when permission is not granted", async () => {
    const { env, showNotification, constructNotification } = makeEnv({
      getPermission: () => "denied",
    });
    const plan = await notifyLocalWith(env, new Set(), opts);
    expect(plan.show).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it("delivers via the service-worker registration when present", async () => {
    const { env, showNotification, constructNotification } = makeEnv();
    const seen = new Set<string>();
    const plan = await notifyLocalWith(env, seen, opts);
    expect(plan.show).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(constructNotification).not.toHaveBeenCalled();
    expect(seen.has("t")).toBe(true);
  });

  it("falls back to the Notification constructor with no SW", async () => {
    const { env, constructNotification } = makeEnv({
      getRegistration: async () => null,
    });
    await notifyLocalWith(env, new Set(), opts);
    expect(constructNotification).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeats of the same tag", async () => {
    const { env, showNotification } = makeEnv();
    const seen = new Set<string>();
    await notifyLocalWith(env, seen, opts);
    const second = await notifyLocalWith(env, seen, opts);
    expect(second.reason).toBe("duplicate");
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("never throws when delivery fails", async () => {
    const { env } = makeEnv({
      getRegistration: async () => {
        throw new Error("boom");
      },
    });
    await expect(notifyLocalWith(env, new Set(), opts)).resolves.toBeTruthy();
  });
});
