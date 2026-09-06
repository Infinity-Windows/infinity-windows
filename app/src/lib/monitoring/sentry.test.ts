// @vitest-environment happy-dom
//
// The gate, and what goes out once it is open.
//
// The first two tests are the ones that matter most for a feature nobody has
// switched on yet: with no DSN the SDK is not merely inert, it is never
// IMPORTED — so the chunk is never fetched and a phone on a bad connection
// downloads nothing extra. The rest pin what the settings actually are, because
// every one of them is a privacy decision: no replay, no tracing, errors only,
// and a scrubber in front of the pipe.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const imported = vi.fn();
  const init = vi.fn();
  const captureException = vi.fn();
  const setTag = vi.fn();
  const setContext = vi.fn();
  const withScope = vi.fn((fn: (s: unknown) => void) => fn({ setTag, setContext }));
  return { imported, init, captureException, setTag, setContext, withScope };
});

vi.mock("@sentry/react", () => {
  // Called only if something really imports the module — which is the whole
  // assertion of the first test.
  sdk.imported();
  return {
    init: sdk.init,
    captureException: sdk.captureException,
    withScope: sdk.withScope,
    makeFetchTransport: () => "fetch-transport",
    makeBrowserOfflineTransport: (inner: unknown) => () => ({ inner, offline: true }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fresh copy of the module, with its memoised init reset. */
async function load() {
  return await import("./sentry");
}

describe("with no DSN — the shipping state", () => {
  it("never even imports the SDK", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const m = await load();
    expect(await m.startCrashMonitoring()).toBeNull();
    expect(sdk.imported).not.toHaveBeenCalled();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only value as no DSN at all", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "   \n");
    const m = await load();
    expect(m.crashMonitoringDsn()).toBe("");
    expect(await m.startCrashMonitoring()).toBeNull();
    expect(sdk.imported).not.toHaveBeenCalled();
  });

  it("a crash still reports everywhere else, and says the monitor took nothing", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const m = await load();
    expect(await m.captureCrash(new Error("boom"), null, "K7F3Q")).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe("with a DSN", () => {
  const DSN = "https://abc123@o1.ingest.sentry.io/42";

  it("starts once, however many times it is asked", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    await Promise.all([m.startCrashMonitoring(), m.startCrashMonitoring()]);
    await m.startCrashMonitoring();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("sends errors only: no replay, no tracing, the offline transport", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    await m.startCrashMonitoring();
    const opts = sdk.init.mock.calls[0][0];
    expect(opts.dsn).toBe(DSN);
    expect(opts.sampleRate).toBe(1);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.sendDefaultPii).toBe(false);
    // A dead-zone crash is stored and sent when signal returns.
    expect(opts.transport()).toMatchObject({ offline: true });
    // Whatever the SDK ships by default, replay and tracing are taken back out.
    const kept = opts.integrations([
      { name: "Replay" },
      { name: "ReplayCanvas" },
      { name: "BrowserTracing" },
      { name: "GlobalHandlers" },
    ]);
    expect(kept.map((i: { name: string }) => i.name)).toEqual(["GlobalHandlers"]);
  });

  it("tags every event with role, build and whether the phone was offline", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    await m.startCrashMonitoring();
    m.setMonitoringRole("installer");
    const { beforeSend } = sdk.init.mock.calls[0][0];

    const online = beforeSend({ message: "finish_unit failed" });
    expect(online.tags.role).toBe("installer");
    expect(online.tags.offline).toBe("false");
    expect(typeof online.tags.build).toBe("string");

    // Offline is read at CAPTURE time, not at init — that is the difference
    // between a crash in a dead zone and one in the warehouse.
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    try {
      expect(beforeSend({ message: "finish_unit failed" }).tags.offline).toBe("true");
    } finally {
      if (onLine) Object.defineProperty(Navigator.prototype, "onLine", onLine);
    }
  });

  it("a role that has not loaded yet reports as unknown, never as a blank", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    await m.startCrashMonitoring();
    m.setMonitoringRole(null);
    const { beforeSend } = sdk.init.mock.calls[0][0];
    expect(beforeSend({}).tags.role).toBe("unknown");
  });

  it("runs the scrubber on the way out — the tags are not an exception", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    await m.startCrashMonitoring();
    const { beforeSend, beforeBreadcrumb } = sdk.init.mock.calls[0][0];

    const out = beforeSend({
      message: "receipt for ben@stgwindows.com failed",
      user: { email: "ben@stgwindows.com" },
      extra: { lat: 30.267153, caption: "before shot" },
    });
    expect(out.message).toBe("receipt for [email] failed");
    expect(out.user).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("30.267153");
    expect(JSON.stringify(out)).not.toContain("before shot");

    const crumb = beforeBreadcrumb({
      category: "fetch",
      data: {
        method: "POST",
        url: "https://x.supabase.co/rest/v1/units?id=eq.1&select=notes",
        body: '{"notes":"sill was wet"}',
      },
    });
    expect(crumb.data).toEqual({
      method: "POST",
      url: "https://x.supabase.co/rest/v1/units",
    });
  });

  it("puts the crew's five-character code on the report as a tag", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const m = await load();
    const err = new Error("Cannot access 'jobCodeMap' before initialization");
    expect(await m.captureCrash(err, "\n    at JobMaterials", "K7F3Q")).toBe(true);
    expect(sdk.setTag).toHaveBeenCalledWith("crash_code", "K7F3Q");
    expect(sdk.setContext).toHaveBeenCalledWith("react", {
      componentStack: "\n    at JobMaterials",
    });
    expect(sdk.captureException).toHaveBeenCalledWith(err);
  });

  it("never throws out of the crash path, whatever the SDK does", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    sdk.withScope.mockImplementationOnce(() => {
      throw new Error("the SDK fell over");
    });
    const m = await load();
    await expect(m.captureCrash(new Error("boom"), null, "K7F3Q")).resolves.toBe(false);
  });
});

describe("monitoringEnvironment", () => {
  it("is production only on the crew's real domain", async () => {
    const m = await load();
    expect(m.monitoringEnvironment("app.forgewd.com")).toBe("production");
    expect(m.monitoringEnvironment("infinity-windows.github.io")).toBe("preview");
    expect(m.monitoringEnvironment("localhost")).toBe("preview");
  });
});
