import { describe, expect, it, vi } from "vitest";
import {
  resolveLocationFromScan,
  resolveWindowFromScan,
  type LocationScanLookups,
  type WindowScanLookups,
} from "./scanResolve";
import type { Location, WindowUnit } from "./types";

const unit = (window_id: string): WindowUnit =>
  ({ id: `uuid-${window_id}`, window_id }) as WindowUnit;

const slot = (address: string): Location =>
  ({ id: `uuid-${address}`, address }) as Location;

function windowLookups(overrides: Partial<WindowScanLookups> = {}): WindowScanLookups {
  return {
    getWindowByWindowId: vi.fn(async () => null),
    findWindowByCode: vi.fn(async () => null),
    findWindowBySerial: vi.fn(async () => null),
    ...overrides,
  };
}

function locationLookups(
  overrides: Partial<LocationScanLookups> = {},
): LocationScanLookups {
  return {
    getLocationByAddress: vi.fn(async () => null),
    getLocationBySerial: vi.fn(async () => null),
    ...overrides,
  };
}

describe("resolveWindowFromScan", () => {
  it("resolves a plain window id via getWindowByWindowId", async () => {
    const lookups = windowLookups({
      getWindowByWindowId: vi.fn(async () => unit("W-CAS3050-0042")),
    });
    const res = await resolveWindowFromScan(
      { kind: "window", windowId: "W-CAS3050-0042" },
      lookups,
    );
    expect(res).toEqual({ status: "ok", unit: unit("W-CAS3050-0042") });
    expect(lookups.getWindowByWindowId).toHaveBeenCalledWith("W-CAS3050-0042");
  });

  it("resolves a hand-writable short code via findWindowByCode", async () => {
    const lookups = windowLookups({
      findWindowByCode: vi.fn(async () => unit("W-DH2846-0007")),
    });
    const res = await resolveWindowFromScan(
      { kind: "windowCode", code: "K7M2QX" },
      lookups,
    );
    expect(res).toEqual({ status: "ok", unit: unit("W-DH2846-0007") });
    expect(lookups.findWindowByCode).toHaveBeenCalledWith("K7M2QX");
  });

  it("resolves a permanent serial via findWindowBySerial", async () => {
    const lookups = windowLookups({
      findWindowBySerial: vi.fn(async () => unit("W-SLD-0009")),
    });
    const res = await resolveWindowFromScan(
      { kind: "windowSerial", serial: "WIN-000123" },
      lookups,
    );
    expect(res).toEqual({ status: "ok", unit: unit("W-SLD-0009") });
    expect(lookups.findWindowBySerial).toHaveBeenCalledWith("WIN-000123");
  });

  it("reports not-found with the query that missed", async () => {
    const res = await resolveWindowFromScan(
      { kind: "windowCode", code: "ZZZZZZ" },
      windowLookups(),
    );
    expect(res).toEqual({ status: "not-found", query: "ZZZZZZ" });
  });

  it("flags a slot label scanned where a window was expected", async () => {
    const res = await resolveWindowFromScan(
      { kind: "location", address: "S-03-B" },
      windowLookups(),
    );
    expect(res).toEqual({ status: "not-a-window" });
    const serialRes = await resolveWindowFromScan(
      { kind: "locationSerial", serial: "SLOT-000123" },
      windowLookups(),
    );
    expect(serialRes).toEqual({ status: "not-a-window" });
  });
});

describe("resolveLocationFromScan", () => {
  it("resolves a slot address via getLocationByAddress", async () => {
    const lookups = locationLookups({
      getLocationByAddress: vi.fn(async () => slot("S-03-B")),
    });
    const res = await resolveLocationFromScan(
      { kind: "location", address: "S-03-B" },
      lookups,
    );
    expect(res).toEqual({ status: "ok", location: slot("S-03-B") });
    expect(lookups.getLocationByAddress).toHaveBeenCalledWith("S-03-B");
  });

  it("resolves a slot serial via getLocationBySerial", async () => {
    const lookups = locationLookups({
      getLocationBySerial: vi.fn(async () => slot("S-04-A")),
    });
    const res = await resolveLocationFromScan(
      { kind: "locationSerial", serial: "SLOT-000123" },
      lookups,
    );
    expect(res).toEqual({ status: "ok", location: slot("S-04-A") });
    expect(lookups.getLocationBySerial).toHaveBeenCalledWith("SLOT-000123");
  });

  it("reports not-found when the slot is unknown", async () => {
    const res = await resolveLocationFromScan(
      { kind: "locationSerial", serial: "SLOT-999" },
      locationLookups(),
    );
    expect(res).toEqual({ status: "not-found", query: "SLOT-999" });
  });

  it("flags a window label scanned where a slot was expected", async () => {
    const res = await resolveLocationFromScan(
      { kind: "window", windowId: "W-CAS3050-0042" },
      locationLookups(),
    );
    expect(res).toEqual({ status: "not-a-location" });
  });
});
