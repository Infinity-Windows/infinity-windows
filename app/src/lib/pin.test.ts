import { describe, expect, it } from "vitest";
import {
  constantTimeEqualB64,
  generateSaltB64,
  hashPin,
  PIN_ITERATIONS,
  validateNewPin,
  verifyPin,
} from "../../../supabase/functions/_shared/pin";

// A fixed salt keeps the derivation deterministic across runs.
const SALT = "MTIzNDU2Nzg5MGFiY2RlZg=="; // base64 of "1234567890abcdef"

describe("hashPin", () => {
  it("is deterministic given the same pin, salt and iterations", async () => {
    const a = await hashPin("1234", SALT, 10_000);
    const b = await hashPin("1234", SALT, 10_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("changes when the pin changes", async () => {
    const a = await hashPin("1234", SALT, 10_000);
    const b = await hashPin("1235", SALT, 10_000);
    expect(a).not.toBe(b);
  });

  it("changes when the salt changes", async () => {
    const a = await hashPin("1234", SALT, 10_000);
    const b = await hashPin("1234", generateSaltB64(), 10_000);
    expect(a).not.toBe(b);
  });
});

describe("verifyPin", () => {
  it("accepts the correct pin and rejects a wrong one", async () => {
    const salt = generateSaltB64();
    const hash = await hashPin("secret42", salt, PIN_ITERATIONS);
    expect(await verifyPin("secret42", salt, PIN_ITERATIONS, hash)).toBe(true);
    expect(await verifyPin("secret43", salt, PIN_ITERATIONS, hash)).toBe(false);
  });

  it("rejects when salt/hash/iterations are missing", async () => {
    expect(await verifyPin("x", "", PIN_ITERATIONS, "abc")).toBe(false);
    expect(await verifyPin("x", SALT, 0, "abc")).toBe(false);
    expect(await verifyPin("x", SALT, PIN_ITERATIONS, "")).toBe(false);
  });
});

describe("constantTimeEqualB64", () => {
  it("is true for equal base64 and false for different / different-length", () => {
    expect(constantTimeEqualB64("YWJj", "YWJj")).toBe(true); // "abc"
    expect(constantTimeEqualB64("YWJj", "YWJk")).toBe(false); // "abc" vs "abd"
    expect(constantTimeEqualB64("YWJj", "YWJjZA==")).toBe(false); // "abc" vs "abcd"
  });
});

describe("validateNewPin", () => {
  it("accepts 4–10 alphanumeric characters", () => {
    expect(validateNewPin("1234").ok).toBe(true);
    expect(validateNewPin("abcABC1234").ok).toBe(true);
  });

  it("rejects too short, too long, non-alphanumeric and non-strings", () => {
    expect(validateNewPin("123").ok).toBe(false);
    expect(validateNewPin("12345678901").ok).toBe(false);
    expect(validateNewPin("12 4").ok).toBe(false);
    expect(validateNewPin("12-4").ok).toBe(false);
    expect(validateNewPin(1234 as unknown).ok).toBe(false);
    expect(validateNewPin("").ok).toBe(false);
  });
});
