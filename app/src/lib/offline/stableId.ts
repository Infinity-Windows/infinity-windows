// A UUID-shaped id that comes out the SAME every time for the same seed.
//
// WHY. The outbox's idempotency key is the entry id, and the server dedupes
// `attachments` on it (`client_id`, 20260720000000 + 20261018000000). That only
// protects against a resend when the id is decided ONCE. Two places used to
// decide it again on every pass: the install outbox handed its media to the
// upload queue with a fresh `crypto.randomUUID()` each time its media stage
// ran, so a crash between "queued the second photo" and "removed the install
// record" queued all three photos again under new ids — three new rows on
// the server, no error anywhere. Anything that can be re-run after a crash has
// to derive its ids from something that was written down before the crash.
//
// `attachments.client_id` is a Postgres `uuid`, so the shape matters: 32 hex
// digits in 8-4-4-4-12 groups. The version and variant nibbles are set the way
// `crypto.randomUUID()` sets them, so a strict UUID check passes too. The
// bits themselves are the front of a SHA-256 of the seed.

function toUuid(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * FNV-1a, run four times with different salts, for the one runtime that has
 * no `crypto.subtle` (a plain-http webview). Weaker than SHA-256 but still
 * deterministic, which is the property that matters here — the seeds are
 * random UUIDs already, so collision strength is not what is being asked of it.
 */
function fallbackDigest(seed: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let part = 0; part < 4; part++) {
    let h = 0x811c9dc5 ^ (part * 0x9e3779b9);
    const s = `${part}:${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[part * 4] = (h >>> 24) & 0xff;
    out[part * 4 + 1] = (h >>> 16) & 0xff;
    out[part * 4 + 2] = (h >>> 8) & 0xff;
    out[part * 4 + 3] = h & 0xff;
  }
  return out;
}

/** The same UUID-shaped id every time for the same seed. Never throws. */
export async function stableId(seed: string): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(seed));
      return toUuid(new Uint8Array(digest));
    } catch {
      // Fall through to the portable digest.
    }
  }
  return toUuid(fallbackDigest(seed));
}
