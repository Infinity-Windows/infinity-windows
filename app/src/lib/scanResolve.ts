// Single source of truth for turning a scanned/typed QR payload into the thing
// it points at — a physical window unit or a warehouse slot. Every scan surface
// (Scan, CycleCount, WindowDetail, the project hub warehouse tab, and the
// install OpeningSheet) resolved payloads inline with slightly different
// branching; these helpers give them one shared, testable path.
//
// The lookups are injected so this module stays free of the Supabase client and
// can be unit-tested in Node without a live database.

import type { QrPayload } from "./qr";
import type { Location, WindowUnit } from "./types";

export interface WindowScanLookups {
  getWindowByWindowId: (windowId: string) => Promise<WindowUnit | null>;
  findWindowByCode: (code: string) => Promise<WindowUnit | null>;
  findWindowBySerial: (serial: string) => Promise<WindowUnit | null>;
}

export type WindowScanResult =
  | { status: "ok"; unit: WindowUnit }
  | { status: "not-found"; query: string }
  | { status: "not-a-window" };

/**
 * Resolve a scanned payload to a physical window unit. Window IDs, hand-writable
 * short codes, and permanent serials all resolve to the same unit; a slot/
 * location payload returns `not-a-window` so callers can nudge the user.
 */
export async function resolveWindowFromScan(
  payload: QrPayload,
  lookups: WindowScanLookups,
): Promise<WindowScanResult> {
  switch (payload.kind) {
    case "window": {
      const unit = await lookups.getWindowByWindowId(payload.windowId);
      return unit
        ? { status: "ok", unit }
        : { status: "not-found", query: payload.windowId };
    }
    case "windowCode": {
      const unit = await lookups.findWindowByCode(payload.code);
      return unit
        ? { status: "ok", unit }
        : { status: "not-found", query: payload.code };
    }
    case "windowSerial": {
      const unit = await lookups.findWindowBySerial(payload.serial);
      return unit
        ? { status: "ok", unit }
        : { status: "not-found", query: payload.serial };
    }
    default:
      return { status: "not-a-window" };
  }
}

export interface LocationScanLookups {
  getLocationByAddress: (address: string) => Promise<Location | null>;
  getLocationBySerial: (serial: string) => Promise<Location | null>;
}

export type LocationScanResult =
  | { status: "ok"; location: Location }
  | { status: "not-found"; query: string }
  | { status: "not-a-location" };

/**
 * Resolve a scanned payload to a warehouse slot. Both the address label and the
 * permanent serial label resolve to the same slot; a window payload returns
 * `not-a-location`.
 */
export async function resolveLocationFromScan(
  payload: QrPayload,
  lookups: LocationScanLookups,
): Promise<LocationScanResult> {
  switch (payload.kind) {
    case "location": {
      const location = await lookups.getLocationByAddress(payload.address);
      return location
        ? { status: "ok", location }
        : { status: "not-found", query: payload.address };
    }
    case "locationSerial": {
      const location = await lookups.getLocationBySerial(payload.serial);
      return location
        ? { status: "ok", location }
        : { status: "not-found", query: payload.serial };
    }
    default:
      return { status: "not-a-location" };
  }
}
