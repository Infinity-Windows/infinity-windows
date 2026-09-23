/** Claim → delete → finish for unreferenced Forge AI recordings. Pure over a
 * minimal client shape so the app's Vitest suite drives it without Deno. */
export const MEMO_BUCKET = "ai-field-memos";
export const SWEEP_BATCH = 50;
export const SWEEP_REQUEST_TIMEOUT_MS = 30_000;
/** Every request ends well before the one-hour cleanup lease can be reclaimed. */
export function boundedSweepFetch(fetcher: typeof fetch = fetch, timeoutMs = SWEEP_REQUEST_TIMEOUT_MS): typeof fetch {
  return (input, init) => fetcher(input, {
    ...init,
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]),
  });
}

export interface SweepClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  storage: { from(bucket: string): { remove(paths: string[]): PromiseLike<{ data: { name: string }[] | null; error: { message: string } | null }> } };
}

export async function sweepOrphanMemos(client: SweepClient, lease: string, limit = SWEEP_BATCH): Promise<{ claimed: number; removed: number; retry: number }> {
  const claimed = await client.rpc("ai_field_claim_orphan_memos", { p_lease: lease, p_limit: limit });
  if (claimed.error) throw new Error(claimed.error.message);
  const names = (Array.isArray(claimed.data) ? claimed.data : [])
    .map((r) => (typeof r === "string" ? r : (r as { ai_field_claim_orphan_memos?: string; name?: string })?.ai_field_claim_orphan_memos ?? (r as { name?: string })?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const failed: Record<string, string> = {};
  if (names.length) {
    const { error } = await client.storage.from(MEMO_BUCKET).remove(names);
    // A failed batch leaves every marker in place; finish frees the lease and
    // the next run retries. Nothing claimed is ever reported as removed unless
    // the object is really gone (finish checks storage itself).
    if (error) for (const n of names) failed[n] = error.message.slice(0, 200);
  }
  const done = await client.rpc("ai_field_finish_memo_cleanup", { p_lease: lease, p_failed: failed });
  if (done.error) throw new Error(done.error.message);
  const summary = (done.data ?? {}) as { removed?: number; retry?: number };
  return { claimed: names.length, removed: summary.removed ?? 0, retry: summary.retry ?? 0 };
}
