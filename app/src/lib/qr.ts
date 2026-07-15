// QR payload format for Window Ops labels.
// Window labels:   WOPS:W:<window_id>   e.g. WOPS:W:W-CAS3050-0042
// Location labels: WOPS:L:<address>     e.g. WOPS:L:S-03-B
// Payloads use human-readable identifiers (not UUIDs) so labels survive
// database rebuilds and can be read by eye.

export type QrPayload =
  | { kind: "window"; windowId: string }
  | { kind: "location"; address: string };

export function encodeWindowQr(windowId: string): string {
  return `WOPS:W:${windowId}`;
}

export function encodeLocationQr(address: string): string {
  return `WOPS:L:${address}`;
}

export function parseQr(raw: string): QrPayload | null {
  const text = raw.trim();
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
  return null;
}
