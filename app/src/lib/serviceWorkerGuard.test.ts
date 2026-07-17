import { describe, expect, it, vi } from "vitest";
import {
  purgeStaleServiceWorkers,
  type ServiceWorkerGuardEnv,
} from "./serviceWorkerGuard";

function makeEnv(overrides: Partial<ServiceWorkerGuardEnv> = {}): {
  env: ServiceWorkerGuardEnv;
  reload: ReturnType<typeof vi.fn>;
  markReloaded: ReturnType<typeof vi.fn>;
} {
  const reload = vi.fn();
  const markReloaded = vi.fn();
  const env: ServiceWorkerGuardEnv = {
    getRegistrations: () => Promise.resolve([]),
    cacheKeys: () => Promise.resolve([]),
    deleteCache: () => Promise.resolve(true),
    hasReloaded: () => false,
    markReloaded,
    reload,
    ...overrides,
  };
  return { env, reload, markReloaded };
}

describe("purgeStaleServiceWorkers", () => {
  it("does nothing (no reload) when there are no service workers or caches", async () => {
    const { env, reload } = makeEnv();
    const result = await purgeStaleServiceWorkers(env);
    expect(result).toEqual({ unregistered: 0, clearedCaches: 0, reloaded: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it("unregisters every worker, clears every cache, and reloads once", async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const deleteCache = vi.fn().mockResolvedValue(true);
    const { env, reload, markReloaded } = makeEnv({
      getRegistrations: () =>
        Promise.resolve([{ unregister }, { unregister }]),
      cacheKeys: () => Promise.resolve(["a", "b", "c"]),
      deleteCache,
    });

    const result = await purgeStaleServiceWorkers(env);

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ unregistered: 2, clearedCaches: 3, reloaded: true });
    expect(markReloaded).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload if a worker was killed but we already reloaded this session", async () => {
    const { env, reload } = makeEnv({
      getRegistrations: () =>
        Promise.resolve([{ unregister: () => Promise.resolve(true) }]),
      hasReloaded: () => true,
    });

    const result = await purgeStaleServiceWorkers(env);

    expect(result.unregistered).toBe(1);
    expect(result.reloaded).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("clears caches even when no worker was present, without reloading", async () => {
    const { env, reload } = makeEnv({
      cacheKeys: () => Promise.resolve(["stale-v1"]),
    });

    const result = await purgeStaleServiceWorkers(env);

    expect(result.clearedCaches).toBe(1);
    expect(result.reloaded).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
