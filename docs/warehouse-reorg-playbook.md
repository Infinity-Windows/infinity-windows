# Warehouse Reorg Playbook — One-Day Conversion

Goal: convert the warehouse from "windows everywhere" to a fully addressed, scannable system in one working day. After this day, every window has a QR license plate, every storage spot has a QR address, and the app knows where everything is.

---

## The four zones

| Zone | Code | Purpose |
|------|------|---------|
| Receiving | `R` | Dock/landing area. Every delivery lands here, gets labeled here, and leaves here the same day. Nothing lives in R. |
| Job staging | `J` | One bay or rack section per active contract. Windows already sold to a job. Grouped so load-out is grab-and-go. |
| Stock | `S` | Extras and overstock, racked by window type. Fast-moving types nearest the door. |
| Damage/hold | `D` | Damaged, mis-shipped, or in-question units. Physically separated so they never get loaded by mistake. |

## Location addressing scheme

Every storage spot gets an address: `ZONE-RACK-SLOT`

- Examples: `S-03-B` (Stock zone, rack 3, slot B), `J-SMITH-A` (staging bay for the Smith job, slot A)
- Rack numbers: 2 digits, painted or labeled large at the end of each rack
- Slots: letters A–Z left-to-right, bottom-to-top within a rack
- Job staging bays use the job code instead of a rack number, so the address itself tells you which job

Rules:

1. If a spot can hold a window, it gets an address and a QR label. No unlabeled storage.
2. A window is only ever "in" one address. Moving it = scan window, scan new address.
3. Job staging bays are temporary — when the job closes, the bay label is retired and reused.

## Window ID scheme

Every physical window gets a unique ID: `W-<TYPECODE>-<SEQ>`

- Example: `W-CAS3050-0042` = the 42nd unit ever of casement type 3050
- The type code ties the unit to its catalog type (difficulty rating, tutorial, tips)
- The sequence number makes the unit unique forever — photos, voice memos, and install records attach to this exact unit
- Printed on the label: QR code + the ID in large text + type name, so it works even without a phone

Label placement: same spot on every window — top-left corner of the frame on the interior side, where it will not be scraped during handling and is visible when windows lean in racks.

---

## The one-day conversion (crew of 2–3)

### Before the day (prep, ~2 hours)

- [ ] Print all rack/slot labels (app generates the PDF once rack count is entered)
- [ ] Print a batch of blank-sequence window labels OR bring the thermal printer to the warehouse
- [ ] Print the current contracted-jobs list with window counts per job
- [ ] Clear a landing strip near the dock for Zone R
- [ ] Buy supplies (see [hardware shopping list](inventory-hardware-shopping-list.md))

### Morning — address the building (2–3 hours)

- [ ] Walk the warehouse; number every rack `01, 02, 03...` with large end-cap labels
- [ ] Sticker every usable slot with its `ZONE-RACK-SLOT` QR label
- [ ] Mark zone boundaries with floor tape: R near dock, J bays along one wall, S in the main racking, D in a back corner
- [ ] Assign one staging bay per active job; label each `J-<JOBCODE>`

### Afternoon — license-plate every window (3–4 hours)

Work rack by rack. For each window:

1. Identify its type (measure/check sticker if unsure)
2. In the app: Receive flow → select type → app issues the next `W-<TYPE>-<SEQ>` ID and prints the label
3. Stick the label (top-left interior corner)
4. Is it sold to a job? → carry to that job's `J` bay, scan window + scan bay. Extra? → app suggests a Stock slot for that type, scan window + scan slot. Damaged? → Zone D, scan.

Two-person rhythm: one person identifies + labels, one person moves + scans. 100–500 windows at roughly 90 seconds each = one afternoon with two people.

### End of day — verify (30 min)

- [ ] Run a cycle count on 3 random racks: scan the rack, confirm the app's list matches reality
- [ ] Every active job's staging bay shows the right window count in the app
- [ ] Zone R is empty

---

## Standing rules after conversion

1. **Nothing enters the warehouse without a label.** Deliveries land in R, get labeled and scanned the same day.
2. **Nothing moves without a scan.** Move = scan window + scan destination. Load-out = scan each window against the job's pick list.
3. **Weekly cycle count, 10 minutes.** The app picks 2 racks; whoever is in the warehouse scans them. Discrepancies get flagged automatically.
4. **Damage goes to D immediately** and gets a photo attached at the moment it is found.
