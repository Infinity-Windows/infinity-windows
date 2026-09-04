/**
 * Byte helpers shared by edge functions. Pure and platform-free (Web APIs
 * only), so the browser test suite can exercise them.
 */

/**
 * Base64-encode raw bytes.
 *
 * Chunked deliberately. The obvious one-liner —
 * `btoa(String.fromCharCode(...bytes))` — spreads every byte into an argument
 * list, and a job photo is a couple of million bytes, which overflows the call
 * stack. Anthropic wants images as base64, so this runs on real photos.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * A response body, or null the moment it goes over `max` bytes.
 *
 * READ IN CHUNKS, NOT IN ONE GO. `res.arrayBuffer()` has no ceiling: it buffers
 * whatever arrives and only then can anything be measured, so a size check
 * after it is a check on a file that is already resident in an edge runtime.
 * This is the ceiling itself. It matters most where a stated size is blindest —
 * a `content-length` a server never sent, or metadata that says null — because
 * that is exactly the case where "check afterwards" means no limit at all.
 *
 * Refusing rather than truncating: half a file that looks like a whole file is
 * worse than no file, and the caller can tell the person to add it by hand.
 */
export async function readBodyCapped(
  res: { body: ReadableStream<Uint8Array> | null },
  max: number,
): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // Stop the download rather than letting the rest of it arrive.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
