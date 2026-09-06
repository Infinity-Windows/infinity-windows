# Warehouse — code audit, 2026-09-06

Read-only audit of the WAREHOUSE feature as it exists on `master` (tip `e700fa2`).
Every claim is tied to a path:line. Tap counts are counted off the JSX, not off a
running app — they are "interactions a person performs", including select-open +
select-pick as two.

Vocabulary throughout is the repo's own (`CONTEXT.md` "The warehouse", lines 25–63;
ADR-0004 through ADR-0007).

**Scale, up front.** Non-test app code for this one feature:

| Area | Lines |
| --- | --- |
| `app/src/pages/storage/*.tsx` (10 screens) | 6,705 |
| `app/src/components/warehouse/*.tsx` (14) | 1,984 |
| `app/src/lib/warehouse/*.ts` (24) | 3,623 |
| `lib/storage.ts` + `labels.ts` + `qr.ts` + `scanResolve.ts` + `takeoffs.ts` + `staging.ts` | 2,306 |
| `pages/Warehouse.tsx`, `Supplies.tsx`, `Takeoffs.tsx`, `Labels.tsx`, `Scan.tsx`, `Receive.tsx`, `LocationDetail.tsx` | 2,455 |
| **Total** | **~17,073** |

Plus **~35 warehouse migrations** (`20260814000000` → `20260986000000`) and **~50
test files / ~9,400 test lines**.

---

## A. Routes and screens

Router is `app/src/App.tsx`; the role registry is `app/src/lib/nav.ts`.

| Route | File | LOC | Role floor | How you get there |
| --- | --- | --- | --- | --- |
| `/warehouse` | `pages/Warehouse.tsx` | 832 | installer (`nav.ts:183`) | The one nav row (`nav.ts:467`); also in the installer loop (`nav.ts:560`) |
| `/storage` | redirect → `/warehouse` (`App.tsx:544`) | – | none (bare redirect) | Old bookmarks; `nav.ts:235` still registers a "Storage" row |
| `/search` | redirect → `/warehouse` (`App.tsx:569`) | – | none | Old bookmarks |
| `/storage/deliveries` | `pages/storage/DeliveriesList.tsx` | 274 | none on route | Station 1 card, "Deliveries — check trucks in" (`Warehouse.tsx:305`) |
| `/storage/log-delivery` | `pages/storage/LogDelivery.tsx` | 517 | none | Station 1, "Log a delivery (truck)" (`Warehouse.tsx:308`) |
| `/storage/d/:id` | `pages/storage/DeliveryDetail.tsx` | 857 | none | Tapping a delivery name on `/storage/deliveries` (`DeliveriesList.tsx:132`) |
| `/storage/tag` | `pages/storage/TagPackages.tsx` | 767 | installer (`nav.ts:170`) | Station 2, "Tag packages" (`Warehouse.tsx:329`); also LogDelivery's "With QR stickers" (`LogDelivery.tsx:126`) and `/receive` |
| `/storage/arrive` | `pages/storage/ArrivePackages.tsx` | 255 | installer (`nav.ts:165`) | Station 2 "Arrival check" and Going-out section (`Warehouse.tsx:332`, `:628`) |
| `/storage/c/:id` | `pages/storage/ContainerDetail.tsx` | **1,223** | none on route | Container tile in "In storage" (`Warehouse.tsx:579`); poster scan (`scanResolve.ts:124`) |
| `/storage/out` | `pages/storage/CheckoutPackages.tsx` | 338 | installer (`nav.ts:171`) | Station 4 and Going-out (`Warehouse.tsx:353`, `:625`) |
| `/storage/rewrite-set` | `pages/storage/RewriteSet.tsx` | 410 | none | Only via `?job/&pending + &mark` — "Edit…" on `/warehouse/materials` (`JobMaterials.tsx:446`) or "Edit set…" on `/storage/d/:id` (`DeliveryDetail.tsx:663`, `:684`). Deliberately has **no hub button** (`Warehouse.tsx:369-373`) |
| `/warehouse/materials` | `pages/storage/JobMaterials.tsx` | 584 | none | Station 5, "Job materials" (`Warehouse.tsx:365`); the "Jobs with material" tallies (`Warehouse.tsx:474`) |
| `/pkg/:serial` | `pages/storage/PackageSheet.tsx` | **1,210** | none | Scanning a sticker (`scanResolve.ts:130`), Find results, container manifest rows |
| `/warehouse/3d/:id` | `pages/storage/ContainerViewer.tsx` | 270 | installer, deliberately (`App.tsx:560-562`) | "See it in 3D" on PackageSheet (`PackageSheet.tsx:687`); auto-bounce from a poster scan (`storage.ts:posterAutoOpenPath`) |
| `/supplies` | `pages/Supplies.tsx` | 598 | installer (`nav.ts:246`) | Supplies section, "Take supplies" (`Warehouse.tsx:648`) |
| `/takeoffs` | `pages/Takeoffs.tsx` | 538 | installer (`nav.ts:182`) | Supplies section (`Warehouse.tsx:644`) |
| `/labels` | `pages/Labels.tsx` | 291 | installer route (`nav.ts:238`), **foreman+ wall drawn client-side** (`Labels.tsx:26`, gating `:168` delete and `:270` rename) | "Other tools" fold (`Warehouse.tsx:823`) |
| `/scan` | `pages/Scan.tsx` | 90 | installer (`nav.ts:161`) | "Other tools" fold (`Warehouse.tsx:819`) |
| `/loc/:address` | `pages/LocationDetail.tsx` | 67 | **none, not even `RequireRole`** (`App.tsx:768`) | Only from a slot-label scan (`Scan.tsx:27`) |
| `/receive` | `pages/Receive.tsx` | 39 | installer (`nav.ts:227`) | Old bookmarks. Renders two links and nothing else |
| Job page → Warehouse tab | `pages/ProjectDetail.tsx:388-411` | – | tab visible to crew; `ReorderNeedsPanel` foreman+ | `StagingBaysPanel` + `PlanPackagesPanel` (minting) + `JobPackagesPanel` |

**Count: 18 live warehouse destinations plus a job-page tab, behind a hub that
claims to be "one page".** Ticket 08 collapsed eight menu *rows* to one; it did not
collapse the screens — `Warehouse.tsx:1-8` says actions "open over the page and never
navigate away", but eleven of the fourteen action buttons on the hub are `<Link>`s
that navigate away.

---

## B. Data model

### Entity relationships (text)

```
projects ──1:N── project_marks (id, project_id, mark_code, unique(project_id,mark_code))
                      ▲
                      │ mark_id  ON DELETE RESTRICT   (ADR-0004 addendum)
                package_marks (package_id, mark_id)   ← PK pair
                      ▲
                      │
packages ─────────────┘
  ├─ project_id      → projects            (nullable = Boneyard, ticket 17)
  ├─ pending_job_name text                 (a SHADOW job: typed name, no row)
  ├─ pending_issue_id → issues
  ├─ container_id    → storage_containers  ┐ exactly one, or neither = LOOSE
  ├─ location_id     → locations           ┘ (packages_one_place_ck, 20260824000000:32)
  ├─ delivery_id     → package_deliveries
  ├─ status, category, part_index, part_total, part_type, mfr_mark,
  │  mfr_part_total, piece_count, area, note, serial, short_code,
  │  bound_at, bound_by
  └─ photos          → package_photos      (20260936000000)

storage_containers
  ├─ parent_container_id → storage_containers  (ONE level; enforce_container_depth)
  ├─ location_id         → locations
  ├─ kind: conex | crate | truck | building    (20260902000000)
  ├─ length_cm/width_cm/height_cm/weight_kg
  └─ studio_project_id   → studio projects     (20260915000000, the 3D shell)

locations (the OTHER location model: zone R/J/S/D · rack · slot, own serial + QR)

package_deliveries (label, arrived_on, expected_at) ──1:N── packages
   └─ schedule_assignments(kind='delivery', delivery_id)   (20260934000000)

movements  — the one log (20260825000000)
   subject is exactly one of: window_id | package_id | container_id | supply_id
   plus from_container_id / to_container_id / from_location_id / to_location_id,
   qty, project_id, job_name, reason, actor, event

package_events — the OLD per-package log, still read as a fallback (storage.ts:482)

supplies (home_container_id, home_location_id, home_note, on_hand, last_counted_at)
   └─ supply_takes / supply_orders;  takeoffs / takeoff_items (20260917000000)

checkout_reasons (label, sort, active) — data, supervisor-curated
part_type_options (name) — user-extensible free-text part labels (20260924000000:76)
```

### Status enums and every transition

`packages.status` — five values (`20260906000000:35`; TS mirror `storage.ts:22`):

| From | To | RPC | Notes |
| --- | --- | --- | --- |
| — | `blank` | `mint_packages` | Blank roll, 1–500 per batch |
| — | `minted` | `mint_mark_packages` (per mark), `create_delivery_set` / `create_manual_delivery` (wizard), `rewrite_set` (growing a line) | "Expected" — label exists, material does not |
| `blank` | `received` | `bind_package` | Tag at the truck. **Binding is permanent** |
| `minted` | `received` | `receive_minted_packages` | "Arrived" tap |
| `received` | `minted` | `unreceive_packages` (20260927000000) | The undo |
| `received`/`stored`/`checked_out` | `stored` | `store_packages`, `custom_checkin` | Re-store = transfer between containers |
| `stored` | `received` | `unstore_packages` (20260930000000) | "un-put-away" |
| `stored`/`received` | `stored` **on a shelf** | `stage_packages` | Set aside; sets `location_id`, clears `container_id` |
| `stored`/`received` | `checked_out` | `checkout_packages` | Reason required; concludes tracking |
| `minted` | *gone* | `burn_packages` | Refuses anything with history |
| any | *gone* | `delete_packages`, `rewrite_set` (shrinking a minted line) | |

Side effects worth naming: **every package move clears `area`** by trigger
(`packages_clear_area_on_move`, `20260904000000:40`) — a container move does not
(ticket 14 correction). `movements` gets exactly one row per write path.

`windows.status` (the retired unit chain) still carries `pre_issued | inbound |
in_warehouse | staged | loaded | installed | damaged | on_site`
(`app/src/lib/types.ts:1-9`). ADR-0004 said `staged`/`loaded` and
`windows.location_id` die; **they have not** — ticket 08b is still open.

---

## C. RPCs

All warehouse writes are SECURITY DEFINER; the tables have **no direct-write
policies** (`20260814000000:19-23`). The role split is frozen by a source test,
`app/src/lib/warehouse/warehouseFloors.test.ts:53-114`.

**Open to any signed-in crew member** (18, opened by ADR-0007 /
`20260986000000`; each also carries an explicit `is_partner_user()` refusal):

`mint_packages` (blank roll) · `mint_mark_packages` (declare N packages for a
mark, mint the labels; refuses a different total than existing labels carry) ·
`add_project_mark` (put a window on the schedule by hand) · `set_mark_part_total` ·
`save_storage_container` (create/edit; an address change writes a movement, not an
edit — `20260903000000`) · `set_package_area` · `set_package_window` (move a package
between windows **on the same job**) · `assign_package_to_job` (Boneyard → job) ·
`add_supply` · `set_supply_home` · `create_takeoff` · `acknowledge_takeoff` ·
`ready_takeoff` · `create_manual_delivery` (the wizard's one call) ·
`file_pending_packages` (shadow job → real job) · `add_delivery_set` ·
`update_delivery` (rename) · `rewrite_set` (declaration-diff apply).

**Foreman+ (the destructive doors):** `burn_packages`, `delete_packages`,
`delete_delivery`.

**Supervisor+ (scheduling and settings):** `schedule_delivery`,
`save_checkout_reason`; plus `set_container_model` (`20260915000000:35`, "only a
supervisor or above can link a container to a model").

**Signed-in only, never rank-checked** (never in ADR-0007's list either — they
predate it): `bind_package`, `store_packages`, `stage_packages`,
`checkout_packages`, `arrive_packages`, `move_container`, `receive_minted_packages`,
`unreceive_packages`, `unstore_packages`, `custom_checkin`, `label_packages`,
`rename_package`, `set_package_part`, `set_package_note`, `set_piece_count`,
`add_job_crate`, `add_crate_supplies`, `add_part_type_option`, `report_maker_count`,
`ensure_package_delivery`, `take_supply`, `count_supply`, `pickup_takeoff`.

**`materialize_pending_set`** stayed foreman+ because nothing calls it
(ADR-0007's own closing note) — dead server code.

---

## D. Flows, with tap counts

All counts start on `/warehouse`. "Interaction" = one tap, or one select
open-and-pick (2), or one field typed (1).

### D1. Expected delivery arrives — check 40 packages against the list, into two conexes

Path: `/warehouse` → **"Deliveries — check trucks in"** (1) → `/storage/deliveries`
→ tap the delivery name (2) → `/storage/d/:id`.

Per mark-set row (`DeliveryDetail.tsx:373-484`, `rowControls`):
- optional "— what is it? —" part-type select (2)
- **"✓ all N"** (1) — or **"Arrive all N"** on a collapsed twin group (`:718`)
- then to store: count select (2) + "— where to? —" container select (2) + **"Store N"** (1) = 5

40 packages spread over ~10 marks: **10 arrival taps + 50 store interactions ≈ 62**,
after 2 navigations.

The faster path is bundle mode (`DeliveryDetail.tsx:522-580`): **"Select several…"**
(1) → one checkbox per slot row (10) → container select (2) → **"Store N together"**
(1) → if the picks span jobs, a second confirm **"I Understand — store them"** (1).
≈15 per conex, ×2 conexes = 30, plus the 10 arrival taps ≈ **40**.

Friction found in the code, not inferred: to tick a *subset* of a collapsed twin
group you must first tap **"Show 5 individually"** (`:735`); the checkbox is per
`SlotRow`, never per package.

### D2. Truck with NO expected delivery — log it by hand for 3 jobs

`/warehouse` → **"Log a delivery (truck)"** (1) → mode screen → **"Without stickers
— prepare the list, check the truck against it"** (2) → step 1 of 3.

Step 1 "Which jobs are on this truck?" (`LogDelivery.tsx:239-335`): delivery name
field (1) + per job a select (2) → 3 jobs needs **"+ Another job"** ×2 (2). = 9.
Then **"Next: the sets"** (1).

Step 2 "Sets on the truck" (`:338-514`): per set — mark field (1), Window/Door select
(2), Packages select (2), optionally "+ Clones (identical units)" (1) + quantity
select (2), optionally "+ Pieces in a crate" (1) + crate name (1) + pieces (1); then
**"+ Another set"** per extra set (1). A modest 3 jobs × 3 sets ≈ **9 × 5 + 6 add-set
taps ≈ 51**.

Step 3: **"Next: review"** (1) → **"Save the delivery"** (1).

**Total ≈ 65 interactions across 4 screens**, and it deliberately does *not* collect
per-package part labels (`LogDelivery.tsx:8-12`) — those get typed a second time
later, on the package sheet or in Rewrite-a-set. The wizard autosaves a draft to
`localStorage` (`DRAFT_KEY`, `:69-76`).

### D3. Tag a loose package with a blank sticker (bind)

`/warehouse` → station 2 **"Tag packages"** (1) → `/storage/tag`.
Step 1 (`TagPackages.tsx:526-608`): Job select (2, or 0 if the last-used job
sticks — `LAST_JOB_KEY`), Category chip (1), Window # field (1), "How many pieces?"
(1). Step 2 (`:612-701`): tap the line to select it (1), tap its part-type chip (1),
optional their-# field (1); **"Scan a sticker onto the glowing line"** (1) + the scan
itself. Step 3: optional note (1) + **"Tag 1 package"** (1).

**≈ 10–12 interactions for one package**, dropping to ~5 for the second package on
the same job.

### D4. Find "window 16 on job X" and learn which conex

The Find bar is pinned (`Warehouse.tsx:255-264`); placeholder
`"Find: 16, PKG-000123, S-01-A, Conex 3, BLACK22…"` (`FindBar.tsx:106`).
Type `16` (1). If only one job has a window 16, the answer is the chain immediately:
`"Window 16 · BLACK22 — 2 of 3 here"` plus a row per package with
`"Crate 7 — inside Conex 3"` (`find.ts:283-300`, `answerHeadline`). If several jobs
have a 16 — which is the normal case, marks are per-job — you get
`kind: "mark-choices"` and must pick the job (1).

**1–2 interactions.** This is the one genuinely good part of the current design.

### D5. Move one package from conex A to conex B

There is **no "move this package" action on the package's own sheet.** The only
route is the destination container's check-in list: `/warehouse` → tap Conex B's tile
(1) → **"Check in packages"** (2) → find the package in the candidate list, which is
every received/stored-elsewhere/checked-out package in the company
(`ContainerDetail.tsx:432-438`), tick it (3) → **"Store 1 here"** (4).

**4 interactions plus a visual scan of an unfiltered, unsearchable list.** The row
says `"moving from Conex A"` (`:713`). PackageSheet's "Where it is" group
(`PackageSheet.tsx:680`) offers only *area* buttons and "See it in 3D" — no move.

### D6. Check out 6 packages to a job

`/warehouse` → **"Set aside / check out"** (1) → `/storage/out`. Mode defaults to
`out` (`CheckoutPackages.tsx:71`). Optional container filter select (2). Tick 6
package cards (6). Reason chip (1). Job select (2) — or the one-tap
`"Use BLACK22"` shortcut (`:277`). **"Check out 6"** (1).

**≈ 11–13 interactions.** Cross-job picks warn and require nothing extra
(`:284-295`); split-unit heads-ups render but never block (`:297-308`).

### D7. EDIT a prebuilt/minted unit — the owner's complaint, itemised

| The edit | Where it lives | Interactions | Verdict |
| --- | --- | --- | --- |
| **Part count 3 → 4** | Two different places. (a) `/storage/rewrite-set?job=…&mark=16` — "+" on the line, then **"Make it match"** (`RewriteSet.tsx:255`, `:333`). Getting there: hub → "Job materials" (1) → job select (2) → "Edit…" on the mark (1) → +(1) → Make it match (1) = **6**. (b) Job page → Warehouse tab → PlanPackagesPanel, re-declare 4 and mint the missing label. (c) TagPackages' growth path silently rewrites every label to "of N" (`TagPackages.tsx:601-610`). | 6+ | **Three doors, three mental models** |
| **Relabel part 2 "glass" → "hardware"** | `/pkg/:serial` → open the **"Fix things"** group (1, it is `defaultOpen={false}`) → open `<details>` **"Fix the part number or label"** (1) → Label select (2). Or on RewriteSet, but only by moving a whole *line*. Or on the container manifest's per-row editor (`ContainerDetail.tsx:1035`). Or on DeliveryDetail's row select (`:392`). | 4 after you find the sheet | **Four doors** |
| **Reassign to a different job** | **Not possible.** `assign_package_to_job` refuses: `'this package already belongs to a job — only Boneyard stock can be assigned'` (`20260986000000:551`). `set_package_window` refuses a null project and only accepts marks on *this* job (`:544`). `rewrite_set` is scoped to one job XOR one pending name. The UI matches — "Assign to job…" only renders when `p.project_id == null` (`PackageSheet.tsx:775`). The only route is foreman+ delete and re-tag. | ∞ | **The single sharpest gap** |
| **Change its mark (same job)** | `/pkg/:serial` → "Fix things" (1) → **"Change the window…"** (1) → type the number (1) → **"Set it"** (1). Only offered when the package has ≤1 mark (`PackageSheet.tsx:782`). The mark must already be on the schedule; the *tag* screen can add one, this one cannot (`:794`). | 4 | Workable, but hidden behind a collapsed group |
| **Fix a typo in a package note** | `/pkg/:serial`, note editor (`:583-600`) → tap edit (1) → type (1) → Save (1). `set_package_note` is offline-capable. | 3 | Fine |
| **Delete a wrongly-minted package** | Foreman+ only. Burn (minted, no history): `/pkg/:serial` → "Danger" group (1) → **"Burn this label…"** (1) → **"Delete forever"** (1). Delete (has history): same group → **"Delete this package…"** → confirm. Bulk: ContainerDetail's **"Delete several…"** (`ContainerDetail.tsx:781`) or RewriteSet's start-over. | 3–4 | Fine, and correctly gated |
| **Split a set** | Not an action. Splitting is a *warning*: `splitUnits` renders "Window 16's other 3 parts are in Conex 3" at checkout (`CheckoutPackages.tsx:297`) and at store (`ContainerDetail.tsx:745`), plus a standing count on the hub (`Warehouse.tsx:519`). Rewrite-a-set is the nearest thing, and it re-declares composition, not location. | n/a | The word "split" means something else than the owner may expect |
| **Start the set over** | `/storage/rewrite-set` → **"Delete all N…"** → `window.confirm` (`RewriteSet.tsx:355-380`). Foreman+; below that, a sentence explains why there is no button. | 3 | Fine |

The pattern behind the complaint is visible in the code: **the same edit is
reachable from four screens with four different affordances** (PackageSheet's
collapsed `<details>`, RewriteSet's declaration lines, DeliveryDetail's row selects,
ContainerDetail's inline rename editor), and the one edit a foreman most obviously
wants — *this box is for the wrong job* — is refused outright by the server.

### D8. Take supplies

`/warehouse` → **"Take supplies"** (1) → `/supplies` → optional search (1) →
**"Take"** on the row (1) → quantity (1) → job select (2) → **"Take it"** (1).
**≈ 6–7**, matching the "three taps" the file header claims
(`Supplies.tsx:4-7`) only if the job is prefilled. Each shelf row carries four
buttons — **Take · Count · Home · History** (`Supplies.tsx:174-193`) — so the row an
installer wants is one of four choices, three of which are not for them.

---

## E. The one-page warehouse

`pages/Warehouse.tsx` (832 lines), top to bottom:

1. **Header** — "Warehouse" / "**Where is it**" (`:249-252`).
2. **Find bar, pinned** (`:255`). Accepts, in resolution order (`find.ts:145-360`):
   package serial or short code → manufacturer's number (only when it matches exactly
   one) → container serial or name → rack/staging slot address → exact job code →
   job code/name substring (≥3 chars, non-numeric) → shadow-job name → window mark
   (with a job pick-list when several jobs share the number) → supply name.
   A miss returns advice, never "no results" (`find.ts:354`).
3. **Outbox banner** — "N warehouse changes … not sent yet" (`:266-274`).
4. **"How does tracking work?"** fold — the `PackageMap` SVG (`:276-278`).
5. **The station strip** — five numbered cards, Coming in → Off the truck → Put
   away → Out the door → Fix a mistake, with `→` connectors (`:290-378`), fed by
   `lib/warehouse/stations.ts`. Eight buttons.
6. **Four stat cards** — on hand · not tagged · loose · damaged
   (`warehouseCards.ts:32-60`), each a link to `?card=…`, plus a "What do these
   numbers mean?" fold and an inline drill-down (`CardList`).
7. **Day recap card** (`:433`).
8. **"Jobs with material"** — per-job unit tallies (`:441-483`).
9. **Five sections**: Coming in (with "Print blank stickers" + three advisory
   counts), In storage (container tiles, "New container", "All posters"),
   Going out, Supplies (Takeoffs / Take supplies / a folded searchable shelf list),
   Problems (`:487-731`).
10. **Testing** section, supervisor+ (`:735-772`).
11. **"Other tools ▸"** fold — exactly two tiles, Scan and Slot labels (`:800-830`).

**Visual vs textual.** Almost everything is text. The visual elements are: the
station strip (a numbered row), the four stat cards, the container tiles (each a
colour badge derived by hashing the serial — `storage.ts:containerHue`), the
`PackageMap` SVG, and the stage chips. There is **no map of the yard, no picture of
a conex, no floor plan** on this page. The intended way to locate a unit is: type
its number into Find, read a sentence.

Counting only what is on screen before scrolling into a fold: **~19 tappable
destinations and 4 counters**. `Warehouse.tsx:1-8` says the eight-row menu
collapsed to one page; in practice the eight rows became ~19 buttons on one page.

---

## F. The 3D warehouse map and the package map

**`/warehouse/3d/:id`** (`ContainerViewer.tsx`, 270 lines) is read-only and installer-
open on purpose (`App.tsx:560-562`). It mounts the Studio engine, loads the
container's saved shell, locks every item, and **glows the zone where one package
sits**, read off `packages.area`: front/middle/back are thirds along +x (the door
end), the building gets a 3×3 compass grid with a compass mark on the floor
(`ContainerViewer.tsx:1-14`).

Does it help finding? Only after three preconditions: (1) a supervisor has created
the shell (`set_container_model` is supervisor+, `20260915000000:35`); (2) somebody
set the package's `area` — a pointer that **every package move silently clears**
(`20260904000000:40`); (3) you already know which container, because the viewer is
reached from a package sheet or a poster scan, never from the hub. The entry point is
conditional on `studio_project_id` existing (`PackageSheet.tsx:684`). For a warehouse
where areas are optional and self-clearing, this is a nice-to-have, not the finder.

**The in-app package map** (`components/warehouse/PackageMap.tsx`, 233 lines, data in
`lib/warehouse/packageFlow.ts`) is a *diagram of the six-stage lifecycle*, not a map
of a place. It is an explainer behind a fold ("How does tracking work?"). It teaches;
it finds nothing.

---

## G. Offline

**Covered (11 ops queue through the outbox).** Registry `outbox-core.ts:601-611`,
handlers `outboxHandlers.ts:1255-1265`, wrappers `lib/warehouse/offlineWrites.ts`:
`store_packages`, `checkout_packages`, `stage_packages`, `move_container`,
`bind_package`, `receive_minted`, `set_package_area`, `set_package_note`,
`take_supply`, `pickup_takeoff`, `issue_photo_upload`. The queue-or-throw rule is one
function, `attempt()` (`offlineWrites.ts:70-83`) — a real server rejection is
re-thrown immediately, only "no signal" queues. Warehouse writes get their own
counter bucket so the hub can say "3 not sent yet" (`outbox-core.ts:412-432`, `:470`).

**Not covered — everything else**, notably: `mint_packages` / `mint_mark_packages`,
`rewrite_set`, `create_manual_delivery` (the entire hand-log wizard),
`arrive_packages` (only its photo queues), `unstore_packages`, `custom_checkin`,
`saveContainer`, `delete_packages`, `burn_packages`, `receivePackages`,
`unreceivePackages`, `labelPackages`, `renamePackage`, `setPackagePart`,
`setPieceCount`, `filePendingPackages`, `setPackageWindow`, `assignPackageToJob`,
`addDeliverySet`. **The whole `/storage/d/:id` tailgate screen is online-only** — its
`deliveries` and `deliveryPackages` query keys are not in `OFFLINE_KEYS`
(`DeliveryDetail.tsx:103-107` vs `queryClient.ts:50-127`), and every write on it is a
direct call. One more sharp edge: `ensureDelivery` inside the otherwise-offline tag
flow (`TagPackages.tsx`) is a direct call, so the first tag of the day fails with no
signal if a delivery row has to be created.

**Reads.** Persisted React Query cache in `localStorage` (`queryClient.ts:41-44`),
`networkMode: "offlineFirst"`, one week `gcTime`. `OFFLINE_KEYS` includes
`storagePackages`, `storageContainers`, `scheduledMarks`, `issues`, `locations`,
`projects`, `projectsAll`, `supplies` — so "what is in Conex 7" answers offline,
because manifests are derived client-side from the one flat package list. A warm-up,
`prefetchWarehousePack()` (`queryClient.ts:237-282`, called once from `App.tsx:353`),
fills them at sign-in. Not cached: `deliveries`, `checkoutReasons`,
`partTypeOptions`, `packageEvents`, `containerMovements`. So a package's *history* and
*what truck is coming* are blank in a conex.

**"Not sent yet" surfacing:** per-write toast `writeToast` (`offlineWrites.ts:335`),
a separate wording for tags (`tagToast`, `:357`), the hub banner
(`Warehouse.tsx:266-274`), the global sync pill, and `/stuck` for dead letters.
`useSavedCopy` (the "you're reading a saved copy" notice) is wired on exactly two
screens — `Projects.tsx` and `OpeningSheet.tsx` — and **on no warehouse screen**, so a
stale conex manifest looks live.

---

## H. Labels and printing

`lib/labels.ts` (281 lines) generates PDFs client-side with `pdf-lib` + `qrcode`.
Two geometries only, and no multi-up sheets — every label is its own page.

**4×2 in thermal label** (288×144 pt, `labels.ts:14-15`), QR 116 pt at left, text
column 140 pt wide, hero shrinks 40→12 pt, lines 13→7 pt:
- **Package sticker** (`:163-189`) — hero `short_code` (or serial), then serial,
  then either the bind line `"BLACK22 · Window 16 · 2 of 4"` or the literal
  `"Package — scan to assign"` (`:185`).
- **Slot label** (`:131-156`) — hero the address (`S-01-A`), then display name,
  serial, and zone name from `ZONE_NAMES` — `R: Receiving, J: Job staging, S: Stock,
  D: Damage / hold` (`:276-281`).
- **Window label** (`:99-129`) — **dead code, zero callers**, a leftover of the
  retired unit chain.

**Letter-size container door poster** (612×792 pt, `:195-264`) — a 440 pt QR, the
name at 54 pt, the serial at 30 pt, the address, and the footer `"Scan to open this
container in the app"`. Printed one-off from ContainerDetail or in bulk via
"All posters" on the hub (`Warehouse.tsx:553`).

**QR payloads** (`lib/qr.ts`) — six encoders, seven parsed kinds:
`WOPS:W:<window_id>`, `WOPS:L:<address>` (both legacy),
`WOPS:WS:<serial>`, `WOPS:LS:<serial>`, `WOPS:CS:<CTR-000007>`,
`WOPS:PS:<PKG-000123>`. `parseQr` also tolerates bare text typed off a scuffed
label: `W-…-0000`, `[RJSD]-…-A`, `WIN-######`, `CTR-######`, `PKG-######`, and a
6-char short code from a no-ambiguity alphabet (`qr.ts:30`).
`scanResolve.ts` turns a scan into a route: container → `/storage/c/:id?from=poster`,
package → `/pkg/:serial`, slot → `/loc/:address`; window labels get an apology
(`Scan.tsx:55-57`).

---

## I. Legacy and duplication

**Retired unit chain — mostly gone, three live threads left.**
`window_units` has **zero hits** in `app/src`. `CycleCount`, `InventoryList`,
`inventoryViews`, `WindowDetail`, pre-issue and reconciliation are all deleted. What
survives:
- `list_reorder_needs` — live, computed off the retired tables, rendered by
  `ProjectDetail.tsx:1535` (ReorderNeedsPanel) and `Notifications.tsx:138`.
- `windows.status` `'staged'`/`'loaded'` — still in `types.ts:5-6`, still read by
  `lib/install/fit.ts:15-16` and `lib/loadout.ts:20`. ADR-0004 said they die; 08b is
  still blocked on usage, not code.
- `windows.location_id` — still on `WindowUnit` (`types.ts:176`).

**Confirmed dead code (safe to delete):** `windowLabelsPdf` (`labels.ts:99-129`);
`updateWindow` (`api.ts:778`), `getMovements` (`:928`), `receiveWindow` (`:939`),
`moveWindow` (`:955`), `suggestLocation` (`:1012`, ~20 lines of doc for zero
callers), `deleteLocation` singular (`:886`), the `UnloadResult` type (`~:970`);
`"inventory"` and `"findableUnits"` in `OFFLINE_KEYS` (`queryClient.ts:72-73`);
`materialize_pending_set` server-side. `pages/Receive.tsx` (39 lines) is a signpost
with two links and no data.

**Two location models, both live.** `locations` (zone/rack/slot, own serial and QR,
its own print page, its own detail page, job staging bays) and `storage_containers`
(conex/crate/truck/building). `packages_one_place_ck` forbids both at once, so every
consumer branches: `containerTrail.ts:39-40`, `splitUnits.ts:21`, `find.ts` slot
branch, `placeWhere`. `stage_packages` and `store_packages` exist as separate RPCs
only because of this split.

**Concepts that exist twice.**
- `package_events` **and** `movements` — `listPackageEvents` reads the new one and
  falls back to the old (`storage.ts:461-490`).
- `category` (`windows|doors|frames|hardware|other`) **and** `part_type` (a free-text,
  user-extensible list via `part_type_options`) — both answer "what kind of thing".
- `area` (3 values) **and** zone-areas (6) **and** building compass (9) **and**
  `locations.zone` (R/J/S/D) — the word "zone" means two unrelated things.
- `project_id` **and** `pending_job_name` — a shadow job with no row, on packages
  *and* on receipts, each with its own client-side resolution.
- Delivery is three layers: `package_deliveries` + delivery *sets* + the retired
  `pending_delivery_sets`; two "log a truck" entry points survive (`LogDelivery.tsx`
  and `DeliveryDetail.tsx:356`).
- Marks live in `project_marks` *and* still on their natural key in
  `project_mark_specs`, `project_mark_elevation_views`, `project_spec_discrepancies`
  (ticket 01 said so deliberately).

**Stale copy (cheap fixes):** `Scan.tsx:69` and `:76` still say "Window label →
unit"; `offlineWrites.ts:5` says "the six writes" (ten now); `outbox-core.ts:31` says
"these three" (eleven); `scanResolve.ts:3` names CycleCount and WindowDetail;
duplicated comment blocks at `Scan.tsx:49-54` and `queryClient.ts:263-271`.

---

## J. Tests

**E2E — 7 warehouse specs, 1,490 lines, 30 tests** (all under `app/e2e/`):
`warehouse-crew.spec.ts` (480, the ADR-0007 role sweep across nine routes),
`delivery-receive.spec.ts` (353, the tailgate: `"✓ all 6"`, `"Store 4"`,
`"un-put-away"`, bundle mode), `storage.spec.ts` (219, hub + check-in + checkout),
`rewrite-set.spec.ts` (165, declaration-diff and the shrink refusal),
`log-delivery.spec.ts` (117, the wizard end to end plus draft resume),
`job-materials.spec.ts` (113), `warehouse-funnel.spec.ts` (43, station order and the
de-duplicated Deliveries link). Plus warehouse touches in `testing-projects.spec.ts`.

**Unit/component — 26 files in `lib/warehouse/` (4,032 lines, 100% colocated
coverage), 12 more across pages/components/lib (2,417), and 5 offline/loadout/staging
files (1,439).** Notably `warehouseFloors.test.ts` reads the migrations themselves to
freeze the ADR-0007 role split, and `movementEvents.test.ts` does the same for the
movement vocabulary.

**Gaps.** No e2e at all for `/scan`, `/supplies` (598 lines), `/storage/arrive`
(255), `/warehouse/3d/:id`, `/takeoffs` beyond one happy path. No unit test for
`DeliveryDetail.tsx` (857), `JobMaterials.tsx` (584), `LogDelivery.tsx` (517),
`RewriteSet.tsx` (410), `CheckoutPackages.tsx` (338), `SetEditor.tsx` (367),
`FindBar.tsx` (345), `PackageMap.tsx` (233). Roughly **4,900 lines of warehouse
page/component source with no colocated test**.

---

## K. Complexity hot spots

### Ten biggest, for a USER

1. **The same edit lives on four screens.** Changing a package's part label is
   possible on PackageSheet (`:941`, behind two collapsed layers), RewriteSet
   (`:263`), DeliveryDetail (`:392`, `:706`) and ContainerDetail (`:1035`). Four
   affordances for one fact.
2. **A package can never change job.** `assign_package_to_job` refuses a package that
   already has one (`20260986000000:551`); `set_package_window` refuses a Boneyard one
   and only accepts marks on the current job (`:544`). The escape hatch is foreman+
   delete and re-tag.
3. **Two location models the user has to keep straight.** "In Conex 7" and "on bay
   J-BLACK22-A" are different machinery with different verbs (Check in vs Set aside)
   and different labels. `CONTEXT.md:39` has to explain "a shelf is staging, not
   storage" — a rule with no physical analogue.
4. **Five statuses × three overlapping stage vocabularies.** `blank / minted /
   received / stored / checked_out` on the record; "Expected · Arrived · Stored · On
   site" in JobMaterials (`STAGE_LABELS`); "Coming in / Off the truck / Put away / Out
   the door / Fix a mistake" on the hub. Plus "Set aside" as a fourth word for a
   fifth thing.
5. **The hub says "one page" and is nineteen buttons.** `Warehouse.tsx:1-8` promises
   actions that "open over the page"; eleven of the fourteen action buttons navigate.
   Eight of them sit in the station strip alone.
6. **Areas are a pointer that erases itself.** Any package move clears `area` with no
   prompt (`20260904000000:40`), and there are three vocabularies for it (3 / 6 / 9
   options by container kind — `areas.ts`). A user who sets "back-left" and then
   re-stores the box loses it silently, and the 3D glow goes dark.
7. **"Where in the box" is optional, so finding degrades to a text sentence.** The
   only reliable answer is `placeWhere` — "Crate 7 — inside Conex 3". Inside a
   forty-foot box that is still a hunt, which is exactly what ticket 14 was written to
   fix.
8. **Data is typed twice by design.** The hand-log wizard deliberately skips part
   labels (`LogDelivery.tsx:8-12`), so every package gets its "what is it" typed a
   second time later, package by package or line by line.
9. **The tailgate screen does not work in a yard with no signal.** `/storage/d/:id`
   is not in the offline read cache and every write on it is direct — the one screen
   used standing beside a truck.
10. **Two doors for logging a truck, and no way back.** "With QR stickers" goes to
    the tag flow; "without" goes to the wizard. A delivery started one way cannot be
    continued the other, and the wizard's output (minted packages) is only editable
    through Rewrite-a-set, which is reachable only via a URL with `?job&mark`.

### Five biggest, for a DEVELOPER

1. **File size.** `ContainerDetail.tsx` 1,223 lines with 18 `useState` hooks;
   `PackageSheet.tsx` 1,210 with 17; `DeliveryDetail.tsx` 857 with 13 — and no unit
   test on the last one.
2. **Thirty-five migrations for one feature**, several redefining the same function
   four or five times (`create_manual_delivery` ×5, `bind_package` ×5,
   `store_packages` ×3). "What does this RPC do today" requires replaying the
   directory — which is exactly why `warehouseFloors.test.ts` and
   `movementEvents.test.ts` had to be written as source tests.
3. **Deploy-window fallbacks everywhere.** `withMarkJoin` runs a second select
   against a pre-`project_marks` schema (`storage.ts:341-353`); `listPackageEvents`
   falls back from `movements` to `package_events` (`:461-490`);
   `listContainerMovements` and `listMovementsSince` both swallow missing columns.
   Half a dozen `isMissingTable`/`isMissingColumn` branches that will never fire again.
4. **~30 warehouse RPCs plus 4 more for supplies/takeoffs**, with three different
   rank conventions in the SQL (`is_foreman_plus(auth.uid())`,
   `v_role in ('installer','foreman')`, `v_role not in ('supervisor','owner')`) —
   pinned by a test rather than a shared helper.
5. **Duplicated concepts multiply branch points.** Every consumer of "where is it"
   must handle container-or-location; every consumer of "what is it" must handle
   category-or-part_type; every consumer of "whose is it" must handle
   project_id-or-pending_job_name. `containment.ts`, `splitUnits.ts`,
   `containerTrail.ts`, `find.ts`, `materialsScope.ts` all exist mainly to absorb
   those forks.

---

## Things I could not determine

- **Real production data.** I did not query the database. The last recorded counts
  (warehouse-tickets.md 08b, 2026-08-17) are 11 windows / 46 locations / 100 blank
  stickers / 0 tagged packages — almost certainly stale after the Aug 25 Tech Ridge
  warehouse pilot, but I have no current numbers, so I cannot say how much of the
  legacy chain is genuinely holding live data today.
- **Whether the tap counts match reality on a phone.** They are counted off the JSX.
  Scroll distance, whether the station strip stacks vertically on a phone
  (`.station-strip` only goes horizontal at desktop widths — `Warehouse.tsx:283-287`),
  and how many of the collapsed folds a real user opens are unmeasured.
- **How many containers actually have a 3D shell**, and therefore whether
  `/warehouse/3d/:id` is reachable in practice at all.
- **Whether `packages.area` is set on any real package.** If it is mostly null, the
  3D glow and the "Conex 7 — front" sentence are both cosmetic.
- **`docs/inventory/`** holds three Supabase inventory JSON dumps and a dry-run log
  from the 2026-07 project consolidation; they predate the whole package chain and
  I treated them as historical, not as a description of today's schema.
- **Which of the four "edit a part label" doors people actually use.** No telemetry
  in the repo distinguishes them.
