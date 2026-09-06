# Open-source leverage for the Infinity Windows warehouse module

Scope: the app already has QR "license plate" packages, units (1–6 pieces, "#16 2/3"
labels), one level of container nesting (conex/trailer/truck/warehouse), a movements
ledger, expected-delivery lists, 4×2 Rollo thermal labels via AirPrint, an offline
outbox, and a CSS-3D warehouse map. The goal here isn't to bolt on a WMS — it's to
find patterns and packages that make the *existing* model simpler to build, more
visual, and more editable, without dragging in a backend the team doesn't control
(Supabase + RLS + SECURITY DEFINER RPCs stays the architecture).

Every verdict below is Adopt / Adapt / Study-only / Ignore, judged against: React 19
+ Vite 8 compatibility, phone-first UX in bad signal, and whether it fits a
Postgres/Supabase-owned data model rather than someone else's server.

---

## 1. Open-source WMS / inventory apps to study (not install)

None of these should be run as a service — the app owns its own schema on Supabase.
The value is in stealing their data-model and UX decisions.

### InvenTree
[github.com/inventree/InvenTree](https://github.com/inventree/InvenTree) — MIT
license, ~6.1k stars, Python/Django, actively maintained (weekly commits).

- **Location hierarchy**: `StockLocation` is a self-referential tree (MPTT-style,
  parent/child) — a location can contain sub-locations *or* stock *or* both, and
  the docs draw a line between "a real place" and "an organizational bucket."
  That maps directly onto the note in this repo's warehouse-model memory that
  "location is inherited" — InvenTree's model is the cleanest published version
  of that idea worth copying (see `docs/stock/` for the location tree page).
- **Movements as ledger, not mutation**: every adjustment writes a `StockItemTracking`
  row (immutable, user-stamped) alongside the current `StockItem.quantity` field.
  It's an append-only ledger *plus* a materialized "current state" column — not a
  view computed live off the ledger. That's a good middle ground if this app's
  movements table currently forces a `SUM()` on every read.
- **Kits/BOM**: `Part` can be a "template"/"assembly" with a `BomItem` linking
  sub-parts and quantities; building a kit consumes the BOM and creates a new
  `StockItem` for the assembly, itself tracked separately. Relevant if "units"
  (six panes bundled as "#16 2/3") ever need a real bill-of-materials instead of
  a label convention.
- **Corrections**: no true undo — corrections are new tracking entries with a
  reason code (`StockItemTracking.tracking_type`), which is the same
  compensating-event pattern recommended in section 8 below.
- **Receiving against a PO**: `PurchaseOrder` → `PurchaseOrderLineItem` →
  "receive" action creates `StockItem`s and tracking entries in one transaction;
  the deep dive at [brightcoding.dev](https://www.blog.brightcoding.dev/2025/09/05/open-source-inventory-management-for-parts-stock-tracking-a-deep-dive-into-inventree)
  walks through this flow.
- **Verdict: Study-only.** Django/Python, not embeddable, but the stock-location
  tree and tracking-entry pattern are directly portable to a Postgres/RLS schema.

### OpenBoxes
[github.com/openboxes/openboxes](https://github.com/openboxes/openboxes) — Eclipse
Public License 1.0, ~857 stars, Grails/Java, built for healthcare supply chains
(Partners In Health, post-Haiti-earthquake origin).

- **Location hierarchy**: locations have a `locationType` (depot, clinic, bin) and
  support nested "internal locations" (a bin inside a warehouse) — one level of
  nesting is explicit in the UI, similar to this app's conex/trailer/warehouse model.
- **Movements**: a `StockMovement` header groups line-item `Requisition`/`Shipment`
  events; it's ledger-first, and every transfer is a shipment with an origin and
  destination, never a silent quantity edit.
- **Receiving against a PO**: a first-class "Partial Receipt" flow — receive less
  than ordered, and the system tracks the backorder remainder automatically. This
  is worth studying for the app's own expected-delivery lists.
- **Verdict: Study-only.** Heavy Java/Grails stack, EPL-1.0 license makes even
  code copying legally fussier than MIT/Apache options — read the docs, don't
  vendor the code.

### Grocy
[github.com/grocy/grocy](https://github.com/grocy/grocy) — MIT, ~9–10k stars, PHP,
actively maintained (used a home-inventory/household framing but the stock engine
generalizes).

- **Undo is a first-class button.** Since v2.5.0 (2022), every purchase/consume/
  transfer action's success toast carries an inline "Undo" button that reverses
  *that specific* stock-log entry — this is the single cleanest end-user-facing
  undo pattern found in this whole survey, and it's UI-level simple: keep a
  reference to the just-written ledger row and offer a one-tap compensating
  write, not a generic multi-step undo stack.
- **Movements**: `stock_log` is append-only; corrections write new rows rather
  than editing history, and there are open GitHub issues (#1075, #2295) about
  the friction of *not* being able to edit old log entries — a useful cautionary
  note: users will ask for it, and the maintainers have held the line for good
  reason (ledger integrity).
- **Verdict: Study-only** for the undo-button UX specifically — this is the
  pattern to copy for section 8's ledger/undo lever.

### Snipe-IT
[github.com/grokability/snipe-it](https://github.com/grokability/snipe-it) — AGPL-3.0,
~14k stars, Laravel/PHP, very active.

- **Checkout/checkin as the core verb**: assets move via `checkout`/`checkin`
  actions logged to an `Actionlog` table (who, what, when, from/to) — same
  ledger-not-mutation idea, applied to individual serialized items rather than
  bulk stock.
- **Verdict: Study-only.** AGPL-3.0 and PHP; the checkout/checkin ledger idea is
  simple enough to restate from documentation without needing the code.

### Homebox
[github.com/sysadminsmedia/homebox](https://github.com/sysadminsmedia/homebox)
(continuation of the archived hay-kot/homebox) — AGPL-3.0, ~6.4k stars, Go +
Vue/Nuxt, active (the fork restarted development after the original maintainer
stepped back).

- **Nested locations** (room → shelf → bin) with auto-generated QR codes per
  location and per item; "Print Label" triggers a built-in label-maker.
- Open GitHub issues (#879, and discussion #1202) show real users asking for
  *bulk* label printing for locations/boxes — a gap this app should make sure it
  doesn't repeat, since batches of package labels are a daily warehouse task here.
- **Verdict: Study-only.** Go/Vue stack; useful mainly as a UX reference for
  "every location gets a QR code automatically," which the fitview/warehouse map
  work in this repo could adopt directly (a location's QR doesn't need a human to
  remember to generate it).

### Part-DB
[github.com/Part-DB/Part-DB-server](https://github.com/Part-DB/Part-DB-server) —
AGPL-3.0-or-later, ~1.7k stars, Symfony/PHP, active.

- Built-in label generator for parts, lots, *and* storage locations, plus
  in-browser barcode scanning via webcam. Small project, but the "label
  generator as a first-class menu item, not a modal buried three clicks deep"
  UX is worth a screenshot-level look.
- **Verdict: Study-only.**

### ERPNext / Frappe stock module
[github.com/frappe/erpnext](https://github.com/frappe/erpnext) — GPL-3.0, ~35k+
stars, Python/Frappe framework, very active.

- **`Stock Ledger Entry`** is the canonical example of ledger-as-source-of-truth
  in a mainstream open-source ERP: every stock-affecting document (Stock Entry,
  Delivery Note, Purchase Receipt) writes immutable SLE rows with a running
  balance (`qty_after_transaction`), and "current stock" is a materialized
  projection kept in sync by triggers/queue jobs, not a live aggregate query. See
  [`stock_ledger_entry.py`](https://github.com/frappe/erpnext/blob/develop/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.py).
  This is the strongest single reference for "ledger vs mutable" of everything
  surveyed here.
- **Verdict: Study-only.** Frappe is its own full-stack framework; not embeddable,
  but the SLE running-balance pattern is directly applicable to a Postgres
  `movements` table with a maintained `on_hand` column.

### Odoo stock/barcode modules
Core Odoo is LGPLv3 (Community); many stock-barcode add-ons live in the OCA
[`stock-logistics-barcode`](https://github.com/OCA/stock-logistics-barcode) and
[`stock-logistics-warehouse`](https://github.com/OCA/stock-logistics-warehouse)
repos (mixed AGPL-3/LGPL-3, community-maintained, moderately active).

- `stock.move` (the ledger line) and `stock.quant` (the materialized on-hand
  count per location+lot) is the textbook version of "ledger + projection" and
  worth reading even divorced from Odoo's ORM. The `stock_barcodes` module's
  "scan wizard" pattern — a single barcode-input widget that infers intent
  (receive vs. move vs. count) from context — is a UX idea worth stealing for a
  single "scan" screen instead of separate screens per action.
- **Verdict: Study-only.** Full ERP, Python/XML views, not portable code, but
  `stock.move`/`stock.quant` naming and split is the industry-standard vocabulary
  worth adopting in this app's own schema comments.

### Dolibarr
[github.com/Dolibarr/dolibarr](https://github.com/Dolibarr/dolibarr) — GPL-3.0,
~6–7k stars, PHP, active.

- Its own GitHub issues (#8604) admit the stock-movement module needs
  restructuring — useful as a "what not to do" data point (a movements table
  that grew organically without a clear direction/reason-code convention gets
  hard to query). Not a positive pattern to copy.
- **Verdict: Ignore** for pattern-stealing; noted only because it was in scope.

### Others checked, low or no signal
- **Medusa** (commerce, not warehouse-floor-operational) has a clean
  `StockLocationModule` + `InventoryModule` split (location, then per-location
  inventory level) that generalizes — worth a five-minute read of
  [the docs](https://docs.medusajs.com/resources/commerce-modules/stock-location)
  for naming, but it's an e-commerce fulfillment model (reserve/fulfill), not a
  yard/receiving model. **Study-only, low priority.**
- **Saleor** — same category as Medusa, not separately investigated; skip.
- **Shelf.nu** [github.com/Shelf-nu/shelf.nu](https://github.com/Shelf-nu/shelf.nu)
  — AGPL-3.0, ~3.8k stars, Remix/TypeScript, active. Worth a mention because it's
  the one project in this list that is React-adjacent (Remix) and has hierarchical
  locations + a built-in QR/barcode scanner + bulk actions (assign custody, move
  location) from a single scan session — closest UX cousin to this app's "scan a
  package and act on it" flow. **Study-only** (its AGPL-3.0 license and
  Remix/Prisma stack rule out lifting code, but the bulk-scan-then-batch-action
  UX pattern is directly relevant and worth a screen-recording look).
- **Stockpile** (greenarrow/stockpile) — explicitly marked "not ready for
  production use" by its own maintainer; no meaningful stars. **Ignore.**
- **"myWarehouse"** — no maintained project under this name was found on GitHub
  with meaningful adoption; searches returned unrelated repos. **Empty result.**

---

## 2. Barcode/QR scanning in the browser

The core trade-off: native `BarcodeDetector` is fast and free but Chrome/Android-only
until iOS Safari ships it (it hasn't, as of this research); everything on iPhone goes
through a WASM or canvas-based JS decoder.

| Library | iOS Safari | Speed/glare | Multi-code/batch | Torch | License/cost |
|---|---|---|---|---|---|
| **`barcode-detector`** (Sec-ant) | Polyfills via WASM (ZXing-C++) when native API absent — this *is* the iOS path | Native-detector speed on Chrome/Android; WASM speed on iOS (good, not instant) | Native API can return multiple `DetectedBarcode` results per frame if the browser supports it; WASM path is single-best-guess per call unless you tile the frame | Exposed via `MediaTrackConstraints` `torch`, browser-dependent | MIT, free |
| `@zxing/browser` | Works (pure JS/WASM decode loop) | Slower than native; ~5.8 MB install size (uncompressed distribution, not what ships to the browser) — a heavier dependency tree than it needs to be | Not built for batch; one code per decode loop | Manual via track constraints | Apache-2.0, free |
| `html5-qrcode` | Works, broad format support (1D+2D) | Community reports call it slower than QuaggaJS/Scandit in bad light; **maintenance has stalled — no releases since April 2023, author states no more PRs merged** | No native batch mode | Built-in torch toggle | Apache-2.0, free — but effectively unmaintained |
| `quagga2` (`@ericblade/quagga2`) | Works, 1D-focused (UPC/Code128/EAN — no QR) | Actively maintained (release ~6 months ago as of this writing), decent in good light, weaker on glare per user reports | No | Track-constraint based | MIT, free |
| `zxing-wasm` (Sec-ant) | Works — this is the lower-level engine `barcode-detector` polyfill is built on | WASM binary ~636 KiB; fast, since it's the same ZXing-C++ core used by native mobile scanner apps | `readBarcodes` can decode one image at a time; scanning "a whole shelf" would mean tiling one photo into regions and calling it per-region — doable but you write the batching | N/A (it's a decode function, not a camera manager) | MIT/Apache, free |
| `react-qr-barcode-scanner` | Works | Thin wrapper, inherits underlying decoder's speed | No | Depends on wrapper version | MIT, free |
| `@yudiel/react-qr-scanner` | Works, ~170k weekly downloads, actively used | Good reported UX; supports continuous/single/pause-resume scan modes | Not natively multi-code, but has a "tracking" overlay hook that could be extended | Built-in torch + zoom + camera-switch controls | MIT, free |
| Dynamsoft JS SDK | Works, purpose-built for enterprise mobile scanning | Best-in-class in low light/glare per vendor benchmarks; this is a paid product specifically differentiated on real-world scan conditions | Native multi-barcode-per-frame scanning is a marketed feature | Full camera control API | Commercial — "contact sales," reported as generally less expensive than Scandit |
| Scandit Web SDK | Works, mobile-camera-tuned | Widely regarded as the best-in-class for harsh conditions (sun glare, damaged labels, motion) — this is literally their product pitch | Yes, marketed "MatrixScan" batch/multi-scan mode is a signature Scandit feature | Full control | Commercial, volume-based pricing, generally the **most expensive** option compared in vendor writeups |
| STRICH | Works | Good — WASM-based, positions itself as a lighter/cheaper Scandit alternative | Not a headline feature like Scandit's MatrixScan | Yes | Commercial but transparent published pricing: **$99/mo for 10,000 scans, $249/mo for 100,000 scans** |

**Analysis for this app.** Installers scan phone-camera-to-sticker outdoors, often in
direct sun, and the goal statement explicitly calls out "scan a whole shelf at once."
That single requirement is the deciding factor:

- Free/open options (`barcode-detector`, `zxing-wasm`, `@yudiel/react-qr-scanner`)
  are all **single-best-guess-per-frame** — good for "scan this one sticker," weak
  for "scan a shelf of ten stickers in one shot." Building true multi-code batch
  scanning on top of them means writing your own frame-tiling/ROI logic — doable,
  but real engineering effort, and glare handling stays whatever ZXing-C++ gives you.
- Paid SDKs (Scandit, Dynamsoft, STRICH) sell exactly the two things this app is
  missing: glare-robust decoding and native multi-code-per-frame batch scanning.
  STRICH's published, low, usage-based pricing ($99–249/mo) is realistic for a
  single-crew internal tool in a way that Scandit's enterprise/volume pricing may not be.
- **Recommendation**: Adopt `@sec-ant/barcode-detector` (or the native
  `BarcodeDetector` where available, falling back to it) as the default free path
  for single-sticker scans — it's the best-maintained, smallest, MIT-licensed
  option and unifies the native/polyfill code path into one API. If "scan a whole
  shelf" becomes a committed roadmap item rather than a nice-to-have, trial STRICH
  before Scandit — the pricing is transparent and it is purpose-built for exactly
  that batch-scan use case, at roughly a tenth of what enterprise SDKs typically cost.

---

## 3. Label printing from the browser

The real question the team needs answered is narrower than the prompt's list
suggests: **can a 4×2 Rollo label print with one tap and no OS print dialog on
iPhone?** Short answer: **no, not from a PWA, full stop** — and it's worth saying
plainly because it's a common wrong assumption.

- **AirPrint has no "skip the dialog" mode.** Rollo printers are AirPrint-certified
  and print over Wi-Fi with no driver — that's the good news — but AirPrint from
  Safari/PWA always opens iOS's native print sheet; there is no documented API for
  a web page to bypass it. This is an iOS platform restriction, not a Rollo
  limitation.
- **Zebra Browser Print** (the enterprise-grade "silent print from a web app"
  tool) is explicitly **Windows/macOS only** — Zebra's own developer forum says
  achieving silent ZPL printing from iOS requires shipping your own native
  companion app that intercepts the print call, mirroring what Browser Print does
  on desktop. Not viable for a PWA-only app.
- **Web Bluetooth thermal printing is the one real workaround**, and it exists
  today for a different (cheaper) printer family: **NIIMBOT**. The
  [`niimblue`](https://github.com/MultiMote/niimblue) project (MIT-style, active)
  is a full open-source web client that talks to NIIMBOT B1/B21/D11/D110 printers
  directly over Web Bluetooth from Chrome/Edge on Android *and* from Safari-based
  browsers where Web Bluetooth is exposed — but **Web Bluetooth is not supported
  in Safari or Safari-based iOS PWAs at all** (Apple has not shipped it and gives
  no signal it will). So this workaround also collapses to "not on iPhone." It is,
  however, real evidence for the pattern (browser-driven direct thermal printing
  without a dialog) on Android — worth knowing if crews ever get Android tablets.
- **Practical iPhone answer**: the fewest-taps path with Rollo/AirPrint is (1)
  pre-render one PDF page per label at exact 4×2 size so nothing needs
  scaling/cropping in the print sheet, and (2) trigger `window.print()` from a
  dedicated print-preview route so the OS dialog opens with the right label
  already selected as the "printer" from last use — iOS remembers the last-used
  AirPrint destination, so the *second* label onward is close to one-tap even
  though the dialog itself can't be removed.

Generation-side libraries, compared:

| Library | Purpose | Bundle | React 19 | Verdict |
|---|---|---|---|---|
| `pdf-lib` | Programmatic PDF byte manipulation, no DOM rendering needed | Moderate; tree-shakeable | Fine (framework-agnostic) | **Adopt** for generating exact-size 4×2 label PDFs — precise control over point-perfect layout, actively maintained |
| `jsPDF` | Simpler PDF generation, more built-in text/shape helpers | ~95 KB minzipped | Fine | Adapt — fine alternative to pdf-lib, slightly heavier, less precise for pixel-exact thermal layouts |
| `pdfmake` | Declarative (JSON) PDF layout | Heavier, includes its own layout engine | Fine | Study-only — overkill for a fixed 4×2 label template |
| `@react-pdf/renderer` | React-component-based PDF authoring | Heavier (own reconciler) | Works with React 19 per community reports, some lag on major React bumps historically | Adapt only if the team wants label templates authored as JSX; otherwise unnecessary weight |
| `bwip-js` | Barcode/QR rendering to canvas/SVG for many symbologies incl. Code128, DataMatrix, PDF417 | Small-moderate | Framework-agnostic | **Adopt** if any symbology besides QR is ever needed (e.g., Code128 for a legacy vendor's manifest) |
| `JsBarcode` | Simple 1D barcode rendering | Small | Framework-agnostic | Adapt — fine, narrower format support than bwip-js |
| `qrcode` (npm) | QR generation to canvas/SVG/data URL | Very small | Framework-agnostic | **Adopt** — this is likely already close to what generates the sticker QR; no reason to replace it |
| `qr-code-styling` | Styled/branded QR codes (logo overlay, rounded dots) | Small-moderate | Framework-agnostic | Ignore — cosmetic, no operational value for a warehouse sticker |
| `react-to-print` | Wraps `window.print()` targeting a specific DOM node | Tiny | Works fine with React 19 | **Adopt** — this is the correct tool for the AirPrint-dialog path: render the label as HTML/CSS at exact label dimensions, print just that node |
| Zebra Browser Print | Desktop/macOS silent print | N/A | N/A | Ignore for this app (phone-only workflow, no desktop kiosk printing described) |
| `niimbot`/`niimblue`-style Web Bluetooth | Silent print on Android/Chrome only | N/A | N/A | Study-only — real pattern, wrong OS for this crew's iPhones |
| DYMO Web SDK | DYMO-specific, desktop browser plugin/service model | N/A | N/A | Ignore — wrong printer family |

**Bottom line for section 3**: stop looking for a way around the iOS print dialog —
there isn't one for AirPrint from a PWA. Optimize what you can control: exact-size
PDFs (`pdf-lib` or `react-to-print` + CSS `@page` sizing) so the dialog opens with
correct scale already selected, and rely on iOS remembering the last-used printer
so only the very first print of a session needs manual printer selection.

---

## 4. Offline-first sync for Supabase

The app already has a hand-rolled offline outbox. The question is whether a
general-purpose sync engine would replace it more cheaply than maintaining custom
retry/conflict code, given the movements-ledger + editable-records shape of the data.

- **PowerSync** — [supabase.com/partners/powersync](https://supabase.com/partners/powersync),
  official Supabase partner. Syncs Postgres → local SQLite on-device; app reads/writes
  locally, PowerSync streams changes both ways using declarative "Sync Rules," and it
  explicitly requires **no schema changes or elevated write permissions** on the
  Supabase side. Currently free in beta; framework-agnostic (Web/React, React Native,
  Flutter, Kotlin, Swift). This is the most mature, most Supabase-native option in
  this list and the only one purpose-built for exactly "Postgres backend, offline
  phone client." **Fit**: append-only ledger writes map cleanly onto PowerSync's local
  SQLite writes with later reconciliation; editable records (unit corrections, opening
  edits) work too since PowerSync's job is bidirectional sync, not just read-caching.
  **Verdict: Adopt** for evaluation — this is the single highest-leverage item in
  the whole offline-sync category for a Supabase shop, and it's the only one with
  an explicit "Supabase integration guide."
- **ElectricSQL** — CRDT-based sync layer, also has a documented Supabase
  integration (Supabase Postgres ships with logical replication already enabled,
  which is what Electric needs). Search results describe it as "newer and still
  maturing" relative to PowerSync as of 2026, with an "Electric Cloud" hosted
  option. **Verdict: Study-only for now** — promising architecture (CRDTs handle
  concurrent edits better than last-write-wins) but less battle-tested than
  PowerSync specifically against Supabase in production mobile/PWA contexts.
- **RxDB + `rxdb-supabase`** — RxDB core is Apache-2.0, ~23k stars, very mature as
  a local-first database; the community `rxdb-supabase` replication plugin
  ([github.com/marceljuenemann/rxdb-supabase](https://github.com/marceljuenemann/rxdb-supabase))
  does two-way sync via PostgREST (pull/push) + Supabase Realtime (live updates),
  and integrates with Supabase Auth/RLS. Downside: it's a smaller, single-maintainer
  glue plugin rather than an officially backed integration — real risk of being
  the "17 copies of the same guard that stopped agreeing" problem this repo's own
  CLAUDE.md warns about, if the team ends up patching it themselves long-term.
  **Verdict: Adapt** — solid for a proof of concept, but budget for owning the
  integration layer yourselves.
- **WatermelonDB** — SQLite-backed, built for React Native and used in production
  at scale (Supabase's own blog has a "React Native offline-first with Expo +
  WatermelonDB" writeup), but it uses simple last-write-wins conflict resolution,
  and this app is a **web PWA**, not React Native — WatermelonDB's web adapter is
  the less-traveled path relative to its RN adapter. **Verdict: Study-only.**
- **TinyBase** — tiny (~5 KB), reactive relational-ish store, framework-agnostic
  React/React Native, designed to plug into sync/persistence layers (including
  CRDT engines like Yjs and SQLite). It is *not* itself a sync solution — it is a
  local reactive store you'd still have to wire to something for the Supabase side.
  **Verdict: Study-only** as a lightweight local-state layer if PowerSync/RxDB
  feel too heavy for a narrower slice (e.g., just the outbox queue's in-memory state).
- **Legend-State** — Works well with Expo/React Native via async-storage; has
  community Supabase-sync examples but nothing as turnkey as PowerSync's guide.
  **Verdict: Study-only.**
- **Dexie + dexie-cloud, Replicache/Zero, TanStack DB, Yjs/Automerge** — no
  Supabase-specific integration guide surfaced in this research at the depth
  needed to recommend them over PowerSync; Replicache/Zero (Rocicorp) in
  particular is a strong local-first engine but pairs more naturally with its own
  backend model than with an existing Supabase/RLS project. **Verdict: Study-only,
  lower priority than PowerSync/ElectricSQL/RxDB.**

**Recommendation**: the app's hand-rolled outbox already does the job for
"phone loses signal briefly, queue and retry" — the case for ripping it out only
holds if the team wants **bidirectional background sync with automatic conflict
resolution** (e.g., two installers editing the same unit while both offline).
If and when that becomes a real pain point, PowerSync is the correct first
evaluation because it is the only option here with a maintained, official
Supabase-specific integration path and doesn't require schema changes.

---

## 5. Visual warehouse / map UIs

The existing CSS-3D `fitviewRenderer.ts` is explicitly a vendored, deliberately
non-React, non-WebGL port — any replacement candidate has to beat "zero extra
dependency, already working, ported and under test" on its own terms.

- **`three.js` / `react-three-fiber`: confirmed too heavy, with evidence.**
  Multiple 2026 sources describe common mobile-web R3F failure modes directly —
  sluggish frame rates, memory crashes on complex meshes, blank canvases on
  lower-end phones — and the recommended mitigations (Draco mesh compression,
  OffscreenCanvas + Web Workers, instancing to cut draw calls) are non-trivial
  engineering investments the current CSS-3D approach simply doesn't need. This
  confirms the project's existing bias against WebGL for this feature was the
  right call. **Verdict: Ignore** unless the warehouse map needs true 3D geometry
  (e.g., irregular rooflines) that CSS 3D transforms genuinely cannot fake.
- **`react-konva`** (Canvas-based 2D scene graph) — full touch/multi-touch
  support (tap, pinch-zoom, two-finger rotate) documented, and a "minimal core"
  build (`ReactKonvaCore`, Konva 10+) exists specifically to cut default bundle
  weight. Canvas-based rendering holds up much better than DOM-based approaches
  once a bin map has hundreds of packages/units on screen. **Verdict: Adapt** —
  the strongest candidate if the team wants a genuinely editable 2D warehouse
  floor plan (drag packages between bins, resize zones) rather than the current
  read-mostly 3D fit view. Not a replacement for fitview; a candidate for a
  *new*, simpler top-down "where is everything" screen.
- **`@xyflow/react` (React Flow)** — DOM-node-based, so each bin/location can be
  a real React component (badges, glow colors, live counts) with zero canvas
  drawing code, and it ships built-in pinch/pan/zoom for touch. The tradeoff
  flagged in research: DOM-based node graphs "struggle past a few hundred nodes,
  especially on mobile." Six conex zones with maybe dozens of visible
  bins/packages per screen is comfortably inside that limit. **Verdict: Adopt**
  for an editable zone/bin map — this is very likely the fastest path to "make
  the warehouse map visual and drag-editable" precisely because bins can be
  ordinary React components (reusing this app's existing badge/glow components)
  rather than hand-drawn canvas shapes.
- **`react-zoom-pan-pinch`** — small, actively maintained, works over plain
  `<div>`/`<img>` content (not just SVG), with full touch/pinch support. This is
  the right pan/zoom layer to wrap around a planset image or a hand-drawn yard
  sketch, and is much lighter than pulling in a full canvas/flow library just for
  pan-zoom. **Verdict: Adopt** — good complement to whatever layout library is
  chosen; likely already close to what the existing trace-model PDF viewer needs.
- **`react-svg-pan-zoom`** — same category, SVG-specific, tree-shakeable via a
  transformation-matrix rewrite. **Verdict: Adapt** — prefer `react-zoom-pan-pinch`
  unless the warehouse map is authored as SVG.
- **`dnd-kit`** — 6 KB core, accessible, actively maintained, framework-agnostic;
  described in 2026 comparisons as "the default choice for most React
  drag-and-drop needs." **Verdict: Adopt** for drag-package-into-bin interactions
  — the natural pairing with an `@xyflow/react` or plain-grid bin map.
- **`@atlaskit/pragmatic-drag-and-drop`** — even smaller (<4 KB), built directly
  on native HTML5 DnD with no abstraction overhead, and is Atlassian's own
  replacement for `react-beautiful-dnd` at Jira/Trello scale. **Verdict: Adapt**
  — the better pick specifically *if* touch-drag performance on lower-end
  Android/iPhone becomes a measured problem with dnd-kit; otherwise dnd-kit's
  larger community and easier accessibility defaults make it the safer first choice.
- **`react-arborist`** — virtualized tree component (VSCode-sidebar-style),
  supports drag-and-drop, inline rename, keyboard nav, and multi-selection out
  of the box; current (v3.16, updated within the last month). **Verdict: Adopt**
  for a container-nesting UI (warehouse → conex → package) — this directly
  targets "one level of nesting" but scales cleanly if that ever needs a second
  level, without writing a custom recursive-render tree component from scratch.
- **`react-grid-layout`** — not separately deep-researched here beyond general
  knowledge; it's a drag-resize dashboard-tile library, not really shaped for
  spatial bin/location maps. **Verdict: Ignore** — wrong tool for this problem.
- **Tldraw** — MIT, ~45k+ stars, "SDK first" embeddable infinite-canvas React
  component, actively maintained, purpose-built for exactly "let a non-technical
  user sketch a layout." **Verdict: Adapt** — a strong option if the team wants
  foremen to freehand-sketch a yard/conex layout (arrows, labeled boxes, sticky
  notes) rather than build a rigid data-driven bin grid. Higher-touch integration
  than a headless pan/zoom library, but the embeddable SDK is genuinely designed
  for this.
- **Excalidraw** — MIT, ~120k+ stars, similar embeddable-package story
  (`@excalidraw/excalidraw`), larger community shape library, more "hand-drawn
  diagram" aesthetic than tldraw's. **Verdict: Adapt** — equally viable to
  tldraw for a sketch-the-yard feature; pick whichever visual style fits, they
  are close peers.
- **Dedicated "warehouse floor plan" / "bin map" open-source components** —
  no maintained, reusable component with meaningful adoption was found under
  this description; what exists are one-off demo repos with no stars/activity.
  **Explicit empty result** — this is a gap the team would be building custom
  regardless of which underlying rendering library (konva/xyflow/svg) is chosen.

---

## 6. Bulk/spreadsheet editing in React

The ask is "make everything editable" and "fix prebuilt units fast" — i.e., dense
tabular correction UI, used on a phone at least some of the time.

| Library | Model | Mobile fit | License/cost | Verdict |
|---|---|---|---|---|
| **TanStack Table** | Headless table *engine* — no editing built in, you wire cell renderers yourself | Fine, since you control every rendered cell (can make touch-friendly inputs) | MIT, free | **Adopt** as the base if the team wants full control over what an editable cell looks like on a phone (bigger touch targets than a desktop-grid library assumes) |
| **Glide Data Grid** | Canvas-rendered, built for huge datasets (1M+ rows) with virtualization | Canvas rendering means custom touch handling — good raw performance, more integration work for mobile-specific gestures | MIT, free | Adapt — likely overkill for "a few thousand packages," but the canvas performance model scales far past what's needed here |
| **`react-datasheet-grid`** | Excel-like inline-editable grid, lightweight, React-native-feeling keyboard nav | Not confirmed touch-optimized in this research; smaller community than alternatives | MIT, free | Study-only — promising on paper, worth a hands-on trial before committing given thinner evidence |
| **AG Grid Community** | Full-featured data grid, huge ecosystem | Desktop-oriented by default (dense rows, hover-based UI); AG Grid **Enterprise** costs $999/developer/year for advanced features like row grouping and Excel export — Community is free but the polish that makes bulk-editing pleasant is often an Enterprise feature | Community: MIT-style free; Enterprise: $999/dev/yr | Adapt with caution — free tier is real and usable, but budget for hitting a paywall as soon as "nice to have" editing UX is requested |
| **Handsontable** | Excel-clone spreadsheet component, mobile touch support marketed explicitly | Better native mobile/touch story than AG Grid in vendor marketing | Commercial, ~$999/developer/year (comparable to AG Grid Enterprise), free only for non-commercial/evaluation use | **Ignore for a commercial internal tool** unless the license cost is explicitly approved — this app has no existing paid-SaaS-library precedent per the "one-app principle" memory, and $999/dev/yr recurring is a real budget line for what a headless table + custom cells can achieve for free |
| **`react-spreadsheet`, `revogrid`, `jspreadsheet-ce`** | Smaller/simpler spreadsheet-style grids | Not deeply evaluated here; lower community size than the above | Mostly MIT/free | Study-only — worth a quick trial if TanStack Table + custom cells feels like too much boilerplate for a first cut |

**Recommendation**: start with **TanStack Table** (headless, free, full control)
and build touch-sized editable cells directly using this app's existing form
components — that avoids both the AG Grid/Handsontable licensing cliff and the
risk of adopting a library whose default UX assumes a mouse and a large screen.
Revisit Glide Data Grid only if package/unit counts grow into the tens of
thousands and virtualization performance becomes a measured problem.

---

## 7. Mobile UX primitives

- **`vaul`** — unstyled drawer/bottom-sheet component, explicitly built as "a
  Dialog replacement on tablet and mobile," minimal dependency footprint (built
  on Radix UI Dialog), actively maintained. **Verdict: Adopt** — bottom sheets are
  the natural phone-first pattern for "tap a package → detail sheet slides up,"
  which is close to what the fitview detail sheet already does for openings; this
  is a good candidate to standardize that interaction across the warehouse screens too.
- **`cmdk`** — command-palette primitive (⌘K-style), the base under shadcn's
  "Command" component; well-established, small, actively maintained. **Verdict:
  Adopt** for a "Find" bar — jump straight to a package/unit/location by typing
  part of its mark code or LPN, which pairs naturally with a client-side fuzzy
  search index (see below).
- **`radix`/`react-aria`** — accessible unstyled primitives; both are mature,
  React-19-compatible, and already likely adjacent to whatever this app's design
  system uses (shadcn-style stacks lean on Radix). **Verdict: Adopt** if not
  already in use — no reason to hand-roll accessible dropdowns/dialogs from scratch.
- **`framer-motion` / `motion`** — the rebrand from Framer Motion to `motion` is
  complete industry-wide; either import path works. Mature, React 19 compatible.
  **Verdict: Adapt** — useful for the kind of smooth sheet/transition polish this
  request is asking for, but it's a meaningfully larger dependency than the other
  items here; only pull it in where transitions are genuinely load-bearing for
  clarity (e.g., a drag-drop confirmation), not globally.
- **`react-swipeable` / `@use-gesture/react`** — gesture libraries for
  swipe-to-dismiss, swipe-to-confirm, drag interactions beyond what `dnd-kit`
  covers. **Verdict: Adapt** — pick `@use-gesture/react` if the drag-to-move-bin
  feature (section 5) needs custom gesture handling beyond dnd-kit's defaults;
  otherwise skip, dnd-kit already covers standard drag-and-drop.
- **Haptics (`navigator.vibrate`)** — works on Android Chrome; **iOS Safari does
  not support the Vibration API at all** (Apple has never shipped it, and there
  is no polyfill — it's a hardware-permission decision, not a missing library).
  **Verdict: Ignore for iPhone crews** — do not build UX that depends on haptic
  feedback as the *only* confirmation signal, since it silently does nothing on
  the platform this crew actually uses.
- **`sonner` / `react-hot-toast`** — both mature toast libraries; `sonner` is the
  more actively promoted/maintained option in the current shadcn ecosystem.
  **Verdict: Adopt `sonner`** if a toast library isn't already standardized —
  this pairs directly with the Grocy-style "undo" toast pattern recommended in
  section 8 (an inline Undo action right on the confirmation toast).
- **Web Speech API wrappers** — no specific library investigated in depth; browser
  support for `SpeechRecognition` on iOS Safari is historically inconsistent and
  vendor-prefixed. **Verdict: Study-only** — voice capture for hands-full
  warehouse work is a legitimate idea, but verify actual iOS Safari behavior with
  a throwaway prototype before investing, given known cross-browser flakiness.
- **`browser-image-compression` / `compressorjs`** — both mature, small,
  client-side image resize/compress-before-upload libraries; directly useful
  given the app already handles photo capture on bad-signal phones (smaller
  photo payloads = faster uploads on the outbox queue). **Verdict: Adopt** —
  low-risk, clear win for exactly this app's constraints.
- **`tesseract.js`** — WASM port of the Tesseract OCR engine, 100+ languages,
  mature (v7 current), actively downloaded (580+ dependents). Could, in theory,
  read a manufacturer's printed "#16 2/3" label straight off a photo instead of
  requiring manual entry. **Verdict: Study-only** — real capability, but OCR
  accuracy on manufacturer stickers (small print, varied fonts, glare, tape
  glare) needs a prototype against real Strata paperwork/labels before betting a
  workflow on it; a bad OCR read that silently mis-keys a unit code is worse than
  no OCR at all.
- **`Fuse.js` / `minisearch` / `flexsearch`** — for a client-side "instant fuzzy
  find over a few thousand packages offline" (explicitly this app's scale):
  `Fuse.js` is the zero-config default for fuzzy matching under ~10k items and
  needs no index-build step; `minisearch` is described as the best all-around
  balance of features/maintenance for PWA/mobile-first use with a minimal
  dependency footprint; `flexsearch` wins only at 100k+ documents, well past this
  app's scale. **Verdict: Adopt `minisearch`** — best fit for "a few thousand
  packages, offline, on a phone" specifically because of its explicit PWA/mobile
  design goal and low memory footprint; pair with `cmdk` for the Find-bar UI.

---

## 8. Event-sourcing / ledger + undo patterns in Postgres/Supabase

The question that matters here isn't "which extension" — it's "what's the cleanest
way to give a warehouse user a real Undo for a wrong move or wrong edit," and the
research converges on a clear answer.

- **`supa_audit`** — [github.com/supabase/supa_audit](https://github.com/supabase/supa_audit),
  Supabase's own generic table-auditing extension. Trigger-based, writes an
  immutable `audit.record_version` row per change with a stable `record_id::uuid`
  derived from the primary key, enabling fast history queries. It's a *general*
  audit trail (who changed what, when) — it does not give you undo out of the
  box, but it's the correct low-effort way to get a complete change history on
  tables that don't already have one. **Verdict: Adopt** if any warehouse table
  doesn't already have change history — it's small, official, and requires no
  application-code changes (pure trigger + schema).
- **`pgMemento`** — [github.com/pgMemento/pgMemento](https://github.com/pgMemento/pgMemento),
  more ambitious: trigger-based, JSONB delta logging, plus **actual restore/repair
  functions** to roll a row (or a whole transaction) back to a prior state.
  Heavier and more invasive than `supa_audit` (schema versioning, DDL tracking).
  **Verdict: Study-only** — the restore functions are the closest thing in this
  survey to "generic database-level undo," but adopting it wholesale is a bigger
  commitment than this app likely needs given it already has an intentional
  movements ledger design.
- **`pgAudit`** — Postgres-native audit-logging extension that writes to Postgres
  log files, not application tables; good for compliance/security auditing, not
  useful for building an in-app "Undo" button since the data lands in server logs
  the app can't easily query at request time. **Verdict: Ignore** for this use case.
- **`temporal_tables`** — bitemporal/history-table pattern (a `_history` shadow
  table capturing `valid_from`/`valid_to`). Solid pattern, but it's schema-heavy
  (a shadow table per tracked table) compared to `supa_audit`'s single generic
  audit table. **Verdict: Study-only.**
- **The actual recommendation — compensating events, not database-level undo:**
  This app already has the right architecture for this: a movements/audit ledger
  plus current-state columns (exactly InvenTree's and ERPNext's pattern from
  section 1). The cleanest "Undo" for a warehouse user is **not** a generic
  rollback mechanism at all — it's Grocy's pattern: **the confirmation toast for
  a stock action carries a reference to the ledger row it just wrote, and its
  inline "Undo" button fires a second, compensating write** (a reversed movement,
  tagged as a correction of the original) rather than deleting or rewriting
  history. This keeps the ledger honest (nothing is ever silently erased — an
  installer can always see "moved here, then undone, by so-and-so"), it's a small
  amount of app code (no new Postgres extension required), and it matches this
  repo's own existing philosophy of ledger-not-mutation. **This is the single
  most actionable finding in this whole report**: build a one-tap "Undo" as a
  toast action tied to the last-written movement/audit-log row's id, expiring
  after a short window (Grocy uses the toast's own lifetime), rather than
  reaching for any of the Postgres-extension options above.
- **TypeScript-side undo helpers (`immer` patches, `zundo`, `redux-undo`)** —
  these solve a *different* problem: undoing **local, unsaved UI state**
  (multi-step forms, draft edits before submit), not undoing a committed database
  write. `zundo` in particular is tiny (<1 KB), a Zustand middleware, actively
  maintained, and would be the right tool if the team wants "undo my last few
  keystrokes in a draft form" — but it has nothing to do with reversing a movement
  that already hit Postgres. **Verdict: Adapt** — genuinely useful, but scope it
  correctly (client-side draft undo, not ledger undo) so it doesn't get conflated
  with the toast-undo pattern above.

---

## GitHub sweep — explicit results

Per the request, each search term below is reported honestly, including empty ones.

- **"warehouse management react supabase"** — one real hit:
  [`infiniteoo/wms`](https://github.com/infiniteoo/wms) ("Great Blue"), a
  Next.js/React + Supabase + Clerk warehouse-in-a-box project. Low star count,
  early-stage, but the stack match (Supabase-first, not a hosted-service WMS) makes
  it worth a bookmark for future architecture comparison, not for code reuse today.
- **"inventory pwa supabase"** — several small hobby projects
  (`Stockflow-Inventory`, `BoviliusMeidi/inventory-management`,
  `tessamerrill/homelab-inventory`, others), none with meaningful star counts or
  activity signaling production use. **Effectively an empty result** — nothing
  here rises above "student/hobby project," so no adoption or study value beyond
  what's already covered in section 1.
- **"license plate warehouse open source"** — **empty result.** Every hit was
  vehicle license-plate *recognition* (ALPR/OCR) software, an unrelated domain
  that happens to share the term "license plate." No warehouse LPN system of
  meaningful size was found under this term.
- **"conex container tracking"** — **empty result.** "Conex" is heavily
  overloaded in software (Docker/container-tooling projects use the word for
  "container" in the software sense). No physical shipping-container/conex-box
  tracking system was found.
- **"construction material tracking open source"** — partial hits, none
  warehouse-specific: `OpenConstructionERP` (AGPL-3.0, cost-estimation/BOQ/takeoff
  focused, not inventory-movement focused) and `open-material-data` (a
  materials-data-standardization effort, not a tracking app). **No direct match**
  for "track physical construction material stock and movement" — this
  app appears to be filling a real gap rather than duplicating existing open tooling.
- **"window door delivery tracking open source"** — **empty result.** Nothing
  specific to window/door manufacturing or delivery was found; general delivery-
  tracking repos (`delivery-tracker`, `libretrack`) are consumer-package-tracking
  tools (carrier APIs, not job-site receiving), unrelated to this app's domain.
- **"kit assembly inventory open source"** — real hits, all in the
  electronics/hobbyist-parts space: `FreeBOM`, `PartHub`, `pyBOM`, `bom-kit`,
  alongside Part-DB and Kitspace already covered in section 1. Useful vocabulary
  (multi-level BOM, substitutes, unit conversions in `bom-kit`) but none map to a
  physical-goods warehouse kitting flow like "assemble 6 panes into a #16 2/3 unit."
  **Study-only, low relevance.**
- **"receiving against ASN open source"** — **empty result.** Search surfaced
  only explainer articles about what an ASN/EDI-856 document is, no open-source
  implementation of ASN-matched receiving. This is a genuine gap: if the team ever
  wants EDI-856-style "expected shipment matched against a manifest before it
  arrives," it will very likely need to be built from scratch — OpenBoxes'
  "Partial Receipt" flow (section 1) is the closest conceptual relative found.

---

## Top 10 packages to adopt now

1. **`@sec-ant/barcode-detector`** — MIT, small, actively maintained; unifies
   native `BarcodeDetector` and its WASM polyfill behind one API, which is the
   correct free foundation for single-sticker scanning on both Android and iPhone
   before any paid SDK is considered.
2. **`@xyflow/react`** — lets each bin/location render as a real React component
   (reusing existing badge/glow UI) inside a pan-zoom-able node graph with
   built-in touch support; the fastest realistic path to a genuinely *editable*
   visual warehouse map, distinct from and complementary to the existing CSS-3D
   fitview.
3. **`react-zoom-pan-pinch`** — small, mature, touch-first pan/zoom for any
   image or div content (planset images, sketch layouts); low-risk, high-reuse
   across multiple screens.
4. **`dnd-kit`** — 6 KB, accessible, the default 2026 choice for React
   drag-and-drop; needed the moment "drag a package into a different bin"
   becomes a real interaction.
5. **`react-arborist`** — virtualized, drag-enabled tree component; directly
   fits the container-nesting model (warehouse → conex → package) without
   hand-rolling recursive tree UI.
6. **`TanStack Table`** — headless, free, full control over touch-sized editable
   cells; avoids the AG Grid Enterprise / Handsontable licensing cliff ($999/dev/yr
   each) while still delivering "make everything editable."
7. **`vaul`** — small, unstyled bottom-sheet/drawer, purpose-built as a mobile
   Dialog replacement; a natural fit for package/unit detail views on a phone.
8. **`minisearch`** — explicitly designed for offline, mobile-first, low-memory
   fuzzy search over a few-thousand-item dataset — exactly this app's scale for
   an instant package/unit Find bar.
9. **`browser-image-compression`** — small, mature, directly reduces photo
   payload size before the offline outbox has to upload it over bad job-site
   signal; low-risk, immediate win.
10. **`supa_audit`** — Supabase's own official generic-audit trigger extension;
    the fastest way to get a complete, queryable change history on any warehouse
    table that doesn't already have one, feeding directly into a toast-based
    Undo (see the top study item below).

## Top 5 repos to study for patterns

1. **InvenTree** ([inventree/InvenTree](https://github.com/inventree/InvenTree)) —
   the clearest, best-documented reference for a location tree + immutable
   stock-tracking-entry ledger + materialized on-hand quantity, which is
   effectively the same shape this app's movements/units model is aiming for; MIT
   license means even direct terminology and field-naming can be borrowed freely.
2. **ERPNext / Frappe's Stock Ledger Entry**
   ([frappe/erpnext](https://github.com/frappe/erpnext/blob/develop/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.py)) —
   the single best real-world example of "ledger is the source of truth, current
   quantity is a maintained projection," including how a running balance
   (`qty_after_transaction`) is kept correct as new entries land; directly
   informs how to keep this app's own on-hand counts fast without giving up
   ledger integrity.
3. **Grocy** ([grocy/grocy](https://github.com/grocy/grocy)) — study specifically
   for its inline-toast "Undo" button pattern shipped since v2.5.0: it is the
   simplest, most user-friendly implementation of "undo a stock action" found in
   this entire survey, and it requires no new database machinery, just a
   reference to the row just written.
4. **Odoo's `stock.move` / `stock.quant` split** (via the OCA
   [`stock-logistics-barcode`](https://github.com/OCA/stock-logistics-barcode) and
   [`stock-logistics-warehouse`](https://github.com/OCA/stock-logistics-warehouse)
   repos) — the industry-standard vocabulary and separation between an immutable
   movement line and a materialized per-location-per-lot quantity; useful even
   as a naming/documentation reference independent of Odoo's own ORM/UI.
5. **Shelf.nu** ([Shelf-nu/shelf.nu](https://github.com/Shelf-nu/shelf.nu)) — the
   closest UX cousin to this app in this whole survey: hierarchical locations,
   built-in QR/barcode scanning, and **bulk actions off a single scan session**
   (assign custody, change location, add to a booking) in a modern TypeScript
   (Remix) codebase — worth a hands-on walkthrough specifically for how it
   turns "I scanned five things" into "now do one action to all five," which
   maps directly onto this app's own batch scan-and-act warehouse flows.

---

## Sources

- [inventree/InvenTree](https://github.com/inventree/InvenTree); [InvenTree stock docs](https://docs.inventree.org/en/1.1.x/stock/); [InvenTree deep dive](https://www.blog.brightcoding.dev/2025/09/05/open-source-inventory-management-for-parts-stock-tracking-a-deep-dive-into-inventree)
- [openboxes/openboxes](https://github.com/openboxes/openboxes); [OpenBoxes about](https://openboxes.com/about/); [OpenBoxes license](https://github.com/openboxes/openboxes/blob/develop/LICENSE.md)
- [grocy/grocy](https://github.com/grocy/grocy); [Grocy changelog](https://grocy.info/changelog); Grocy issues [#1075](https://github.com/grocy/grocy/issues/1075), [#2295](https://github.com/grocy/grocy/issues/2295), [#438](https://github.com/grocy/grocy/issues/438)
- [grokability/snipe-it](https://github.com/grokability/snipe-it)
- [sysadminsmedia/homebox](https://github.com/sysadminsmedia/homebox); Homebox issue [#879](https://github.com/hay-kot/homebox/issues/879), discussion [#1202](https://github.com/sysadminsmedia/homebox/discussions/1202)
- [Part-DB/Part-DB-server](https://github.com/Part-DB/Part-DB-server); [labels docs](https://github.com/Part-DB/Part-DB-server/blob/master/docs/usage/labels.md)
- [greenarrow/stockpile](https://github.com/greenarrow/stockpile)
- [Shelf-nu/shelf.nu](https://github.com/Shelf-nu/shelf.nu)
- [frappe/erpnext stock_ledger_entry.py](https://github.com/frappe/erpnext/blob/develop/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.py); [Frappe stock entry docs](https://docs.frappe.io/erpnext/user/manual/en/stock-entry)
- [OCA/stock-logistics-barcode](https://github.com/OCA/stock-logistics-barcode); [OCA/stock-logistics-warehouse](https://github.com/OCA/stock-logistics-warehouse)
- [Dolibarr/dolibarr](https://github.com/Dolibarr/dolibarr) issue [#8604](https://github.com/Dolibarr/dolibarr/issues/8604)
- [Medusa Stock Location Module docs](https://docs.medusajs.com/resources/commerce-modules/stock-location)
- [infiniteoo/wms](https://github.com/infiniteoo/wms)
- [Sec-ant/barcode-detector](https://github.com/Sec-ant/barcode-detector); [npm package](https://www.npmjs.com/package/@sec-ant/barcode-detector)
- [zxing-js/browser](https://github.com/zxing-js/browser); [@zxing/browser bundlephobia](https://bundlephobia.com/package/@zxing/browser)
- [mebjas/html5-qrcode issue #582](https://github.com/mebjas/html5-qrcode/issues/582); [Quagga2 vs html5-qrcode](https://scanbot.io/blog/quagga2-vs-html5-qrcode-scanner/); [npmtrends comparison](https://npmtrends.com/@ericblade/quagga2-vs-html5-qrcode)
- [@yudiel/react-qr-scanner npm](https://www.npmjs.com/package/@yudiel/react-qr-scanner)
- [Sec-ant/zxing-wasm](https://github.com/Sec-ant/zxing-wasm)
- [STRICH pricing](https://strich.io/); [STRICH vs ZXing/Quagga](https://strich.io/strich-compared-to-zxing-js-and-quagga/)
- [Dynamsoft Barcode Reader pricing](https://www.dynamsoft.com/store/dynamsoft-barcode-reader/); [Scandit pricing](https://www.scandit.com/pricing/)
- [pdf-lib vs jsPDF vs PDFKit](https://docs.bswen.com/blog/2026-02-21-typescript-pdf-libraries-comparison/); [bwip-js vs JsBarcode](https://npm-compare.com/bwip-js,jsbarcode)
- [Zebra Browser Print dev docs](https://developer.zebra.com/products/printers/browser-print); [Zebra iOS printing forum](https://developer.zebra.com/forum/25150)
- [Rollo AirPrint blog](https://www.rollo.com/blog/how-airprint-and-rollo-simplify-your-shipping/); [Rollo wireless setup](https://support.rollo.com/support/solutions/articles/29000017024-can-i-print-wirelessly-)
- [MultiMote/niimblue](https://github.com/MultiMote/niimblue)
- [PowerSync Supabase guide](https://docs.powersync.com/integrations/supabase/guide); [PowerSync + Supabase blog](https://powersync.com/blog/bringing-offline-first-to-supabase); [Supabase partners: PowerSync](https://supabase.com/partners/powersync)
- [ElectricSQL Supabase integration](https://electric-sql.com/docs/integrations/supabase); [Supabase partners: ElectricSQL](https://supabase.com/partners/catalog/electricsql)
- [pubkey/rxdb](https://github.com/pubkey/rxdb); [marceljuenemann/rxdb-supabase](https://github.com/marceljuenemann/rxdb-supabase); [RxDB Supabase replication docs](https://rxdb.info/replication-supabase.html)
- [Supabase blog: React Native offline-first with WatermelonDB](https://supabase.com/blog/react-native-offline-first-watermelon-db)
- [TinyBase vs WatermelonDB vs RxDB comparison](https://www.pkgpulse.com/guides/tinybase-vs-watermelondb-vs-rxdb-offline-first-2026)
- [konvajs/react-konva](https://github.com/konvajs/react-konva); [react-konva bundlephobia](https://bundlephobia.com/package/react-konva)
- [@xyflow/react bundlephobia](https://bundlephobia.com/package/@xyflow/react); [React Flow touch example](https://reactflow.dev/examples/interaction/touch-device)
- [BetterTyped/react-zoom-pan-pinch](https://github.com/BetterTyped/react-zoom-pan-pinch); [chrvadala/react-svg-pan-zoom](https://github.com/chrvadala/react-svg-pan-zoom)
- [dnd-kit vs Pragmatic DnD comparison](https://www.pkgpulse.com/blog/dnd-kit-vs-react-beautiful-dnd-vs-pragmatic-drag-drop-2026); [@atlaskit/pragmatic-drag-and-drop npm](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop)
- [jameskerr/react-arborist](https://github.com/jameskerr/react-arborist)
- [React Three Fiber mobile performance](https://krapton.com/blog/boosting-react-three-fiber-mobile-performance-in-2026-a-deep-dive-d6105c)
- [Glide Data Grid / AG Grid / react-data-grid comparison](https://www.pkgpulse.com/guides/tanstack-table-vs-ag-grid-vs-react-data-grid-2026)
- [AG Grid Enterprise pricing](https://www.simple-table.com/blog/ag-grid-pricing-license-breakdown-2026); [Handsontable pricing](https://www.simple-table.com/blog/handsontable-pricing-breakdown-2026)
- [Vaul docs](https://vaul.emilkowal.ski/getting-started)
- [tesseract.js npm](https://www.npmjs.com/package/tesseract.js?activeTab=readme)
- [Fuse.js vs FlexSearch vs Orama comparison](https://www.pkgpulse.com/guides/fusejs-vs-flexsearch-vs-orama-client-side-search-2026)
- [supabase/supa_audit](https://github.com/supabase/supa_audit); [pgMemento/pgMemento](https://github.com/pgMemento/pgMemento); [Supabase postgres auditing blog](https://supabase.com/blog/postgres-audit)
- [charkour/zundo](https://github.com/charkour/zundo)
- [tldraw](https://checkthat.ai/brands/tldraw); [Excalidraw](https://en.wikipedia.org/wiki/Excalidraw); [tldraw vs Excalidraw](https://codepic.cc/blog/excalidraw-vs-tldraw)
