import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../../supabase/functions/_shared/bytes.ts";

// Job photos are sent to Claude as base64 now, rather than as signed URLs. The
// size is the whole point of this helper: the obvious one-line implementation
// spreads every byte into an argument list and blows the call stack on anything
// bigger than a thumbnail, which is exactly what a phone camera produces.

describe("bytesToBase64", () => {
  it("encodes short input the same as btoa would", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe(btoa("hello"));
  });

  it("encodes an empty array to an empty string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("handles the full byte range, not just ASCII", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = atob(bytesToBase64(bytes));
    expect(decoded.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(decoded.charCodeAt(i)).toBe(i);
  });

  it("survives a photo-sized buffer without overflowing the stack", () => {
    const bytes = new Uint8Array(3_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const out = bytesToBase64(bytes);
    // 4 base64 characters per 3 bytes, exactly, since 3,000,000 divides by 3.
    expect(out.length).toBe(4_000_000);
    expect(atob(out.slice(0, 8)).charCodeAt(0)).toBe(0);
  });
});
