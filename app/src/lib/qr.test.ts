import { describe, expect, it } from "vitest";
import {
  encodeContainerSerialQr,
  encodeLocationQr,
  encodeLocationSerialQr,
  encodePackageSerialQr,
  encodeWindowQr,
  encodeWindowSerialQr,
  parseQr,
} from "./qr";

describe("qr payloads", () => {
  it("round-trips window labels", () => {
    const payload = parseQr(encodeWindowQr("W-CAS3050-0042"));
    expect(payload).toEqual({ kind: "window", windowId: "W-CAS3050-0042" });
  });

  it("round-trips location labels", () => {
    const payload = parseQr(encodeLocationQr("S-03-B"));
    expect(payload).toEqual({ kind: "location", address: "S-03-B" });
  });

  it("round-trips window serial labels", () => {
    expect(encodeWindowSerialQr("WIN-000123")).toBe("WOPS:WS:WIN-000123");
    expect(parseQr(encodeWindowSerialQr("WIN-000123"))).toEqual({
      kind: "windowSerial",
      serial: "WIN-000123",
    });
  });

  it("round-trips location serial labels", () => {
    expect(encodeLocationSerialQr("SLOT-000123")).toBe("WOPS:LS:SLOT-000123");
    expect(parseQr(encodeLocationSerialQr("SLOT-000123"))).toEqual({
      kind: "locationSerial",
      serial: "SLOT-000123",
    });
  });

  it("round-trips container poster and package sticker labels", () => {
    expect(encodeContainerSerialQr("CTR-000007")).toBe("WOPS:CS:CTR-000007");
    expect(parseQr(encodeContainerSerialQr("CTR-000007"))).toEqual({
      kind: "containerSerial",
      serial: "CTR-000007",
    });
    expect(encodePackageSerialQr("PKG-000123")).toBe("WOPS:PS:PKG-000123");
    expect(parseQr(encodePackageSerialQr("PKG-000123"))).toEqual({
      kind: "packageSerial",
      serial: "PKG-000123",
    });
  });

  it("accepts bare container/package serials typed off a scuffed label", () => {
    expect(parseQr("ctr-000007")).toEqual({
      kind: "containerSerial",
      serial: "CTR-000007",
    });
    expect(parseQr("pkg-000123")).toEqual({
      kind: "packageSerial",
      serial: "PKG-000123",
    });
  });

  it("matches serial (WS/LS) tags before single-letter (W/L) tags", () => {
    // A serial payload must never be mis-parsed as a window/location payload
    // whose id happens to start with S.
    expect(parseQr("WOPS:WS:WIN-000123")).toEqual({
      kind: "windowSerial",
      serial: "WIN-000123",
    });
    expect(parseQr("WOPS:LS:SLOT-000123")).toEqual({
      kind: "locationSerial",
      serial: "SLOT-000123",
    });
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

  it("recognizes hand-writable short codes, case-insensitive", () => {
    expect(parseQr("K7M2QX")).toEqual({ kind: "windowCode", code: "K7M2QX" });
    expect(parseQr("k7m2qx")).toEqual({ kind: "windowCode", code: "K7M2QX" });
  });

  it("does not treat serials as short codes", () => {
    expect(parseQr("W-CAS3050-0042")).toEqual({
      kind: "window",
      windowId: "W-CAS3050-0042",
    });
  });

  it("rejects garbage", () => {
    expect(parseQr("hello world")).toBeNull();
    expect(parseQr("")).toBeNull();
    expect(parseQr("WOPS:X:whatever")).toBeNull();
  });
});

describe("bare window serial typed off the sticker", () => {
  // WIN- was missing while CTR-/PKG- were handled, so the one number printed
  // on the label an installer is holding resolved to nothing.
  it("resolves a bare WIN- serial", () => {
    expect(parseQr("WIN-000123")).toEqual({ kind: "windowSerial", serial: "WIN-000123" });
  });

  it("is case-tolerant, like the other bare serials", () => {
    expect(parseQr("win-000123")).toEqual({ kind: "windowSerial", serial: "WIN-000123" });
  });

  it("still resolves the QR form the same way", () => {
    expect(parseQr("WOPS:WS:WIN-000123")).toEqual({
      kind: "windowSerial",
      serial: "WIN-000123",
    });
  });
});
