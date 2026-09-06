# 02 — Scan first: one Scan button, a state-aware sheet, hand confirm

Status: in-progress (slice A: sheet + hand confirm + Scan button, PR pending; slice B: selection bar on lists, "by hand:" reason on the server, barcode-detector swap, removals)
Type: task
Size: M

## Build
- One Scan button in the warehouse header on every warehouse screen. `barcode-detector` (Sec-ant) behind the existing `qr.ts` parsing.
- The scan sheet (vaul or the existing sheet pattern): reads the package's state and leads with the next verb — expected → Arrive, arrived → Put away (tap a box), stored → Move / Check out — with "Put with the rest of window N" when the unit's other pieces are stored. Keep scanning = multi-select; the same selection bar (Move · Label · Job · Print · Delete) as every list.
- **No sticker? Type or pick.** Type the six-character short code, or pick job → window → piece. Writes the same movement line with the reason prefixed `by hand:`.
- Unmissable scan feedback: tone + visual + a short pause before the camera closes.

## Removes
`/scan`, "Scan a sticker onto the glowing line", Custom check-in.

## Test
Scanning a stored sticker offers Move first; scanning an expected one offers Arrive first; a hand pick writes `store_packages` with a `by hand:` reason.
