/**
 * The GC link's token, on the Deno side.
 *
 * A token is 32 random bytes rendered base64url — 43 characters of
 * [A-Za-z0-9_-] — minted by create_gc_link (migration 20260981000000) and
 * handed to a general contractor in a text message or an email. The database
 * stores only sha256(token) as hex, so the plaintext exists in exactly two
 * places: the link the GC holds, and the one response create_gc_link returned
 * to the foreman who pressed the button.
 *
 * THE HASH MUST MATCH POSTGRES BYTE FOR BYTE. `encode(digest(token, 'sha256'),
 * 'hex')` hashes the token's UTF-8 bytes and prints lowercase hex; so does
 * this. There is no salt and none is wanted: a salt defends a low-entropy
 * secret against a precomputed table, and a 256-bit random token has nothing to
 * precompute against. What the hash buys is that a database backup, a support
 * query or a screenshot of the table hands nobody a working link.
 *
 * app/src/lib/gcToken.ts holds the SHAPE check in TypeScript for the browser's
 * router, and its test names this file. Two copies because Deno cannot import
 * from the app bundle; keep them the same rule.
 */

/** [A-Za-z0-9_-], the base64url alphabet with the padding stripped. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

/**
 * Is this even shaped like one of our tokens?
 *
 * Checked BEFORE hashing so junk cannot be used to make the function work: a
 * hash is cheap, but a refusal is cheaper, and an endpoint a stranger can reach
 * should do the least possible for a request that was never going to be valid.
 */
export function looksLikeGcToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** sha256 of the token's UTF-8 bytes, lowercase hex — Postgres' own answer. */
export async function hashGcToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
