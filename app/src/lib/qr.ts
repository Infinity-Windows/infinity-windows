// QR payload format for Window Ops labels.
// Window labels:   WOPS:W:<window_id>   e.g. WOPS:W:W-CAS3050-0042
// Location labels: WOPS:L:<address>     e.g. WOPS:L:S-03-B
//
// Newer labels encode a PERMANENT serial instead of the human name/address, so
// renaming a slot or window never breaks a printed QR:
// Window serial:   WOPS:WS:<serial>     e.g. WOPS:WS:WIN-000123
// Location serial: WOPS:LS:<serial>     e.g. WOPS:LS:SLOT-000123
//
// Payloads use human-readable identifiers (not UUIDs) so labels survive
// database rebuilds and can be read by eye. Both formats are supported forever
// for backward compatibility — old labels keep scanning.

// Storage tracking labels (containers + license-plate packages) are
// serial-only — they were born after the serial migration, so there is no
// legacy name-encoded form to support:
// Container poster: WOPS:CS:<serial>   e.g. WOPS:CS:CTR-000007
// Package sticker:  WOPS:PS:<serial>   e.g. WOPS:PS:PKG-000123

export type QrPayload =
  | { kind: "window"; windowId: string }
  | { kind: "location"; address: string }
  | { kind: "windowCode"; code: string }
  | { kind: "windowSerial"; serial: string }
  | { kind: "locationSerial"; serial: string }
  | { kind: "containerSerial"; serial: string }
  | { kind: "packageSerial"; serial: string };

// Short hand-writable code: 6 chars from a no-ambiguous alphabet (no O/0/I/1).
const SHORT_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export function encodeWindowQr(windowId: string): string {
  return `WOPS:W:${windowId}`;
}

export function encodeLocationQr(address: string): string {
  return `WOPS:L:${address}`;
}

export function encodeWindowSerialQr(serial: string): string {
  return `WOPS:WS:${serial}`;
}

export function encodeLocationSerialQr(serial: string): string {
  return `WOPS:LS:${serial}`;
}

export function encodeContainerSerialQr(serial: string): string {
  return `WOPS:CS:${serial}`;
}

export function encodePackageSerialQr(serial: string): string {
  return `WOPS:PS:${serial}`;
}

export function parseQr(raw: string): QrPayload | null {
  const text = raw.trim();
  // Serial-encoded labels (permanent format). Match the two-letter WS/LS tags
  // BEFORE the single-letter W/L tags so they can't be mis-parsed.
  const serialMatch = /^WOPS:(WS|LS|CS|PS):(.+)$/.exec(text);
  if (serialMatch) {
    switch (serialMatch[1]) {
      case "WS":
        return { kind: "windowSerial", serial: serialMatch[2] };
      case "LS":
        return { kind: "locationSerial", serial: serialMatch[2] };
      case "CS":
        return { kind: "containerSerial", serial: serialMatch[2] };
      default:
        return { kind: "packageSerial", serial: serialMatch[2] };
    }
  }
  const match = /^WOPS:(W|L):(.+)$/.exec(text);
  if (match) {
    return match[1] === "W"
      ? { kind: "window", windowId: match[2] }
      : { kind: "location", address: match[2] };
  }
  // Tolerate bare IDs typed by hand or from older labels.
  if (/^W-[A-Z0-9]+-\d{4}$/i.test(text)) {
    return { kind: "window", windowId: text.toUpperCase() };
  }
  if (/^[RJSD]-[A-Z0-9]+-[A-Z]$/i.test(text)) {
    return { kind: "location", address: text.toUpperCase() };
  }
  // Bare serials typed by hand off a scuffed label.
  //
  // WIN- was missing here while CTR-/PKG- were handled, so a window serial
  // read straight off its own sticker resolved to nothing — the one number
  // printed on the label the installer is holding. The Scan page used to
  // paper over it with a second lookup on a second typed box; that box is
  // gone (one box does more), so the tolerance belongs here where every
  // typed and scanned path shares it.
  if (/^WIN-\d{6}$/i.test(text)) {
    return { kind: "windowSerial", serial: text.toUpperCase() };
  }
  if (/^CTR-\d{6}$/i.test(text)) {
    return { kind: "containerSerial", serial: text.toUpperCase() };
  }
  if (/^PKG-\d{6}$/i.test(text)) {
    return { kind: "packageSerial", serial: text.toUpperCase() };
  }
  // Hand-writable short code stamped on the unit alongside the serial.
  if (SHORT_CODE_RE.test(text.toUpperCase())) {
    return { kind: "windowCode", code: text.toUpperCase() };
  }
  return null;
}
