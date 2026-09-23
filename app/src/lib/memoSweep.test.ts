import { describe, expect, it } from "vitest";
import { boundedSweepFetch, MEMO_BUCKET, SWEEP_REQUEST_TIMEOUT_MS, sweepOrphanMemos, type SweepClient } from "../../../supabase/functions/_shared/memoSweep";

function fake(claimed: string[], removeError: string | null) {
  const log: string[] = [];
  const client: SweepClient = {
    rpc: async (name, args) => {
      log.push(`${name}:${JSON.stringify(args)}`);
      if (name === "ai_field_claim_orphan_memos") return { data: claimed.map((n) => ({ ai_field_claim_orphan_memos: n })), error: null };
      return { data: { removed: removeError ? 0 : claimed.length, retry: removeError ? claimed.length : 0 }, error: null };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { log.push(`remove:${bucket}:${paths.join(",")}`); return { data: removeError ? null : paths.map((name) => ({ name })), error: removeError ? { message: removeError } : null }; } }) },
  };
  return { client, log };
}

describe("unsent recording sweep", () => {
  it("claims, deletes through the Storage API, then finishes under the same lease", async () => {
    const { client, log } = fake(["u/r1/memo.webm"], null);
    expect(await sweepOrphanMemos(client, "lease-1")).toEqual({ claimed: 1, removed: 1, retry: 0 });
    expect(log).toEqual([
      'ai_field_claim_orphan_memos:{"p_lease":"lease-1","p_limit":50}',
      `remove:${MEMO_BUCKET}:u/r1/memo.webm`,
      'ai_field_finish_memo_cleanup:{"p_lease":"lease-1","p_failed":{}}',
    ]);
  });
  it("a failed deletion is reported for retry, never as removed", async () => {
    const { client, log } = fake(["u/r1/memo.webm", "u/r2/memo.webm"], "storage unavailable");
    expect(await sweepOrphanMemos(client, "lease-2")).toEqual({ claimed: 2, removed: 0, retry: 2 });
    expect(log.at(-1)).toContain('"u/r1/memo.webm":"storage unavailable"');
  });
  it("nothing claimed means nothing deleted", async () => {
    const { client, log } = fake([], null);
    await sweepOrphanMemos(client, "lease-3");
    expect(log.some((l) => l.startsWith("remove:"))).toBe(false);
  });
});


describe("sweep request deadline", () => {
  it("aborts a stuck request well before a lease can be reclaimed", async () => {
    expect(SWEEP_REQUEST_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
    const waiting = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch;
    await expect(boundedSweepFetch(waiting, 5)("https://example.invalid")).rejects.toThrow();
  });
  it("keeps an upstream abort signal as well as its own timeout", async () => {
    const controller = new AbortController(); controller.abort();
    let aborted = false;
    const observe = (async (_input: RequestInfo | URL, init?: RequestInit) => { aborted = init!.signal!.aborted; return new Response("ok"); }) as typeof fetch;
    await boundedSweepFetch(observe)("https://example.invalid", { signal: controller.signal });
    expect(aborted).toBe(true);
  });
});
