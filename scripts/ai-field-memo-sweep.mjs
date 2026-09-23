// Nightly removal of Forge AI recordings that no request refers to and that are
// older than the 90-day grace. Run by .github/workflows/ai-field-memo-sweep.yml
// with the repository's existing SUPABASE_SERVICE_ROLE_KEY — the only caller the
// two SQL functions accept. SQL decides what may go and marks each recording
// under the same lock a request attaches it with; this deletes the bytes through
// the Storage API (a storage.objects row delete would leave the file) and
// reports failures so they are retried. Never prints the key or headers.
//
//   node --experimental-strip-types scripts/ai-field-memo-sweep.mjs [--dry-run]
import { createClient } from "@supabase/supabase-js";
import { boundedSweepFetch, sweepOrphanMemos } from "../supabase/functions/_shared/memoSweep.ts";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (process.argv.includes("--dry-run")) {
  console.log("Dry run: credentials present; nothing claimed or deleted.");
  process.exit(0);
}
const client = createClient(url, key, { global: { fetch: boundedSweepFetch() }, auth: { persistSession: false, autoRefreshToken: false } });
let total = { claimed: 0, removed: 0, retry: 0 };
// Bounded: at most 10 batches of 50 per night.
for (let batch = 0; batch < 10; batch++) {
  const result = await sweepOrphanMemos(client, crypto.randomUUID());
  total = { claimed: total.claimed + result.claimed, removed: total.removed + result.removed, retry: total.retry + result.retry };
  if (result.claimed === 0 || result.retry > 0) break;
}
console.log(`Forge AI recording sweep: claimed ${total.claimed}, removed ${total.removed}, kept for retry ${total.retry}.`);
if (total.retry > 0) process.exitCode = 1;
