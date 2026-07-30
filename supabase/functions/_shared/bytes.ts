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
