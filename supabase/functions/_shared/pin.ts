// Runtime-agnostic vault-PIN hashing shared by the Edge Functions (Deno), the
// web client (Vite) and the vitest suite. It uses only Web Crypto + btoa/atob,
// which exist identically in Deno, modern browsers and Node 22, so the same
// implementation hashes and verifies the PIN everywhere.
//
// The PIN is an authorization gate on who may add to the vault — it is NOT
// encryption of the stored notes. Only the salted PBKDF2 hash is ever stored
// or compared; the plaintext PIN is never persisted, logged or returned.

export const PIN_ITERATIONS = 100_000;
const PIN_KEY_BITS = 256;
const SALT_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh, random, base64-encoded 16-byte salt. */
export function generateSaltB64(): string {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

/**
 * PBKDF2-SHA256 derivation of a PIN against a base64 salt. Deterministic given
 * the same (pin, salt, iterations); returns a base64 hash. Async because Web
 * Crypto's deriveBits is async in every runtime.
 */
export async function hashPin(
  pin: string,
  saltB64: string,
  iterations: number = PIN_ITERATIONS,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: base64ToBytes(saltB64),
      iterations,
      hash: "SHA-256",
    },
    key,
    PIN_KEY_BITS,
  );
  return bytesToBase64(new Uint8Array(bits));
}

/** Length-safe constant-time comparison of two base64 strings. */
export function constantTimeEqualB64(a: string, b: string): boolean {
  const ab = base64ToBytes(a);
  const bb = base64ToBytes(b);
  // Compare against the longer length so timing doesn't leak length, but a
  // length mismatch is still a guaranteed non-match.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Verify a candidate PIN against a stored salt+hash. */
export async function verifyPin(
  candidate: string,
  saltB64: string,
  iterations: number,
  expectedHashB64: string,
): Promise<boolean> {
  if (!saltB64 || !expectedHashB64 || !iterations) return false;
  const got = await hashPin(candidate, saltB64, iterations);
  return constantTimeEqualB64(got, expectedHashB64);
}

export interface PinValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate a proposed new PIN: 4–10 characters, digits or letters only. Kept
 * deliberately liberal (crew-friendly) but bounded so it can't be empty or a
 * pasted essay.
 */
export function validateNewPin(pin: unknown): PinValidation {
  if (typeof pin !== "string") return { ok: false, error: "Enter a PIN." };
  const trimmed = pin.trim();
  if (trimmed.length < 4 || trimmed.length > 10) {
    return { ok: false, error: "PIN must be 4–10 characters." };
  }
  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    return { ok: false, error: "PIN can only use letters and numbers." };
  }
  return { ok: true };
}
