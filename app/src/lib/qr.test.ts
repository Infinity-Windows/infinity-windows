import { describe, expect, it } from "vitest";
import { encodeLocationQr, encodeWindowQr, parseQr } from "./qr";

describe("qr payloads", () => {
  it("round-trips window labels", () => {
    const payload = parseQr(encodeWindowQr("W-CAS3050-0042"));
    expect(payload).toEqual({ kind: "window", windowId: "W-CAS3050-0042" });
  });

  it("round-trips location labels", () => {
    const payload = parseQr(encodeLocationQr("S-03-B"));
    expect(payload).toEqual({ kind: "location", address: "S-03-B" });
  });

  it("accepts bare window IDs typed by hand, case-insensitive", () => {
    expect(parseQr("w-cas3050-0042")).toEqual({
      kind: "window",
      windowId: "W-CAS3050-0042",
    });
  });

  it("accepts bare slot addresses including job staging bays", () => {
    expect(parseQr("j-smith-a")).toEqual({
      kind: "location",
      address: "J-SMITH-A",
    });
    expect(parseQr("S-03-B")).toEqual({ kind: "location", address: "S-03-B" });
  });

  it("rejects garbage", () => {
    expect(parseQr("hello world")).toBeNull();
    expect(parseQr("")).toBeNull();
    expect(parseQr("WOPS:X:whatever")).toBeNull();
  });
});
