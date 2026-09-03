// setMyLanguage() is a thin call-through to the set_my_language RPC — the real
// rules (own-row only, valid language) are enforced server-side
// (20260968000000_profile_language.sql). What THIS proves is the payload shape:
// the RPC name and the argument name (p_lang) the SQL function actually
// declares, and that a rejection surfaces rather than being swallowed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
  supabaseConfigured: true,
}));

const { setMyLanguage } = await import("../install/api");

beforeEach(() => {
  rpc.mockReset();
});

describe("setMyLanguage", () => {
  it("calls set_my_language with p_lang", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setMyLanguage("es");
    expect(rpc).toHaveBeenCalledWith("set_my_language", { p_lang: "es" });
  });

  it("sends the exact chosen language", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setMyLanguage("en");
    expect(rpc).toHaveBeenCalledWith("set_my_language", { p_lang: "en" });
  });

  it("throws when the RPC returns an error, never swallows it", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(setMyLanguage("es")).rejects.toBeTruthy();
  });
});
