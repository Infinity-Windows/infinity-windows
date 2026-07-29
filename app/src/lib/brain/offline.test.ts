import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRAIN_QUESTIONS } from "./questions";

/**
 * Proof that the brain answers with the network gone.
 *
 * Not "we think it's offline-safe" — this test rips out every way a browser can
 * reach the network (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon),
 * makes each one throw, tells the page it is offline, and only then loads the
 * brain and asks all 28 questions. If any part of answering needed a round trip,
 * these tests fail loudly instead of quietly degrading in a basement.
 */

type Global = typeof globalThis & Record<string, unknown>;
const g = globalThis as Global;

const saved: Record<string, unknown> = {};
const NETWORK_APIS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];

function offline(): never {
  throw new Error("network disabled: the brain must not need a round trip");
}

beforeAll(() => {
  for (const key of NETWORK_APIS) {
    saved[key] = g[key];
    g[key] = offline;
  }
  saved.navigator = g.navigator;
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: { onLine: false, sendBeacon: offline, userAgent: "offline-proof" },
  });
});

afterAll(() => {
  for (const key of NETWORK_APIS) g[key] = saved[key];
  Object.defineProperty(g, "navigator", { configurable: true, value: saved.navigator });
});

describe("with the network disabled", () => {
  it("every network API really is gone", () => {
    expect(() => (g.fetch as unknown as () => void)()).toThrow(/network disabled/);
    expect(() => new (g.XMLHttpRequest as unknown as new () => unknown)()).toThrow(
      /network disabled/,
    );
    expect(navigator.onLine).toBe(false);
  });

  it("answers the same 22 of 28 questions it does online", async () => {
    // Imported inside the test so the modules load in the offline environment.
    const { askBrain, getBrainIndex } = await import("./answer");
    const index = getBrainIndex();
    let correct = 0;
    const wrong: string[] = [];
    for (const q of BRAIN_QUESTIONS) {
      const out = askBrain(index, q.question);
      const ids = out.kind === "answers" ? out.hits.map((h) => h.entry.id) : [];
      if (ids.length > 0 && new Set(q.correct ?? []).has(ids[0])) correct += 1;
      else if (!q.expectMiss) wrong.push(`Q${q.n} ${q.question}`);
    }
    expect(correct, `offline misses: ${wrong.join("; ")}`).toBe(22);
  });

  it("answers a type question with no signal — the old code needed the server", async () => {
    const { askBrain, getBrainIndex } = await import("./answer");
    const out = askBrain(getBrainIndex(), "single hung tips");
    expect(out.kind).toBe("answers");
    if (out.kind !== "answers") return;
    expect(out.hits[0].entry.id).toBe("type:SH3252");
    expect(out.hits[0].entry.body).toContain("drain slots");
  });

  it("reads the whole bundled catalog without touching the network", async () => {
    const { currentCatalog } = await import("./catalogCache");
    const { types, fromCache } = currentCatalog();
    expect(types).toHaveLength(102);
    expect(fromCache).toBe(false);
  });

  it("does not try to refresh the catalog when there is no signal", async () => {
    const { refreshCatalogCache } = await import("./catalogCache");
    // Would throw if it reached for fetch/XHR.
    await expect(refreshCatalogCache()).resolves.toHaveLength(102);
  });

  it("holds an offline question in local storage instead of losing it", async () => {
    const store = new Map<string, string>();
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const { logAskedQuestion } = await import("./askLog");
    await logAskedQuestion("what torque on anchors?", { kind: "miss", message: "" });
    const queued = JSON.parse(store.get("iw.askLog.pending") ?? "[]");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ question: "what torque on anchors?", answered: false });
  });
});
