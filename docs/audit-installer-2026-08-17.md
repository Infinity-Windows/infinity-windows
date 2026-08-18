# Field App Audit — What's Broken and What Needs Your Call

Two lists below. The first list is stuff that is just plain wrong — no opinion needed, someone should fix it. The second list changes what an installer sees or how they work, so you need to say yes or no first.

Both lists are ranked by how much it hurts an installer's day, worst first. Every item below was checked against the real code twice. Where I'm less sure, I say so.

---

# 1. UNAMBIGUOUS FIXES

These are objectively wrong. No product decision needed.

---

### 1. In a dead spot, an installer can't start any window — even if they signed the toolbox talk hours ago
**Confidence: high.**

**What's broken:** The app saves certain things to the phone so they still work with no signal. The record of "I signed today's talk" is not on that save list, but the talk itself is. So after the app reloads with no signal, the app can see there *is* a talk today but can't see that the installer already signed it.

**What the installer feels:** They're in a canyon or a basement. They clock in fine. They tap "Start install" on the window — the button looks normal and nothing happens. No error, no message telling them why. This lasts the whole time they have no signal. This is the exact situation the offline work was built for.

**File:** `app/src/lib/queryClient.ts`, around line 39 (the `OFFLINE_KEYS` list).

**Exact fix:** Add `"toolboxToday"` to that list, next to the `"todayTalk"` entry that's already there. Add `"toolboxHistory"` and `"toolboxCompliance"` at the same time for the same reason.

---

### 2. Finishing a window with no signal tells the next window "the clock's already running" when it isn't
**Confidence: high.**

**What's broken:** When there's no signal, a finished install gets held on the phone and sent later. The app knows it got held — the code even checks for it in the foreman version of this screen. But the installer's "Nice work" popup ignores that and always hands the next window a fake start time.

**What the installer feels:** They finish a window in a dead spot, tap "Next one," and the next window's banner says the clock is on it. Meanwhile the button right below it still says "Start install →". Two parts of the same screen disagree. The clock is *not* actually running on that window, so that time is not being recorded.

**File:** `app/src/pages/install/OpeningSheet.tsx`, around line 2174 (the "Next one" button) and line 993 (where the popup opens).

**Exact fix:** Save the "was this held offline?" flag from the finish result into the screen's state, then have the "Next one" button pass the chain timestamp only when it wasn't held. When it was held, pass `carryStart: true` instead, which makes the next screen fall back to the normal Start flow.

---

### 3. The warehouse search can never find a window that's already on the truck
**Confidence: high.**

**What's broken:** The search screen was written to answer "on the truck" — that answer is literally in the code. But the list of windows the search reads from is filtered by the database *before it arrives*, and that filter throws out every window marked "loaded" or "installed."

**What the installer feels:** They're at the truck trying to confirm a window is on board. They scan or type its ID and get "Nothing found." The window is right there. The same ID works fine from a QR scan on a different screen, which makes it look random.

**File:** `app/src/lib/warehouse/find.ts` (the answer already exists, line 98) — the real problem is `app/src/pages/Warehouse.tsx` line 89, which feeds the search from `listInventory()`.

**Exact fix:** Give the search bar its own unfiltered list of windows instead of reusing the on-hand inventory list. No new screen or wording needed — the "on the truck" answer is already written.

---

### 4. A forgotten clock-out shows a normal-looking day on My Timecard
**Confidence: high.**

**What's broken:** The big running timer on My Timecard formats the time in a way that quietly throws away whole days. There is already a correct formatter in the codebase used everywhere else.

**What the installer feels:** Somebody forgets to clock out Friday. On Monday they open My Timecard and see something like "22:57:59" — looks like a long day, not like the twelve-day runaway shift it actually is. The app has a guard built specifically to catch runaway shifts (it was built after a real 286-hour incident), and this screen skips it entirely. Nobody catches it until payroll.

**File:** `app/src/components/timecard/TimecardPanel.tsx`, around line 270.

**Exact fix:** Replace the date-based formatting with `formatClock(elapsedWorkSeconds(openShift))`, which already exists in `app/src/lib/timeclock.ts`. Also run the display through `shiftGuard()` the way the clock sheet does, so it stops counting and asks for a real finish time past the cap.

---

### 5. Unpublished trips are visible to crew — including door codes and WiFi passwords
**Confidence: high.** *(Two findings merged — same rule broken in two places.)*

**What's broken:** The rule "a draft trip is supervisor-only until published" is written down in the code and correctly applied on the Travel tab. Two other screens skip it. The database doesn't enforce it either — it only checks whether you're on the trip, not whether the trip is published.

**What the installer feels:** A supervisor is still building a trip — lodging, door code, WiFi password, flights. Anyone already assigned to that draft can open it from the job page and read the whole pack, weeks before you meant to share it. Their My Schedule card also shows "Travel: Phoenix" for a trip that hasn't been announced.

**Files:**
- `app/src/pages/TripDetail.tsx`, around line 89 — the full trip pack.
- `app/src/pages/MySchedule.tsx`, around line 60 — the destination badge.

**Exact fix:** Both screens should run their data through the `canViewTrip()` / `visibleTrips()` helper that already exists in `app/src/lib/travel/visibility.ts` — the same one the Travel tab already uses. On TripDetail, show the existing "Trip not found" screen when it returns false. I'd also add a status check to the database rules, since right now the app is the only thing holding this line.

---

### 6. A blocked window can vanish from an installer's list entirely
**Confidence: high.**

**What's broken:** The "Next" recommendation searches the list for the first window that isn't blocked — correct. But the list shown below it is built by just chopping off the first item, assuming the first item was the one recommended. When a blocked window happens to sort first, that assumption breaks.

**What the installer feels:** The blocked window disappears — it's not the "Next" card, it's not in the job list, and its reason ("Missing hardware") is nowhere on screen. The window that *is* recommended shows up twice. The "3 to go" count on the job header is short by one. The installer has no idea a window is sitting blocked.

**File:** `app/src/pages/MyWork.tsx`, line 268.

**Exact fix:** Build the rest of the list from the recommended window's identity, not its position:
`const rest = next ? queue.filter((o) => o.id !== next.id) : queue;`

**Related, same fix:** `app/src/pages/Home.tsx` around line 193 has its own "Your next window" card that doesn't know about blocked windows at all. That card is currently unreachable because of how roles route today, but it will come back the moment the nav switch is flipped. Worth fixing while someone is in there.

---

### 7. "Redo filed" and "Marked damaged" show up in red like errors
**Confidence: high.**

**What's broken:** The screen decides whether a message is good news or bad news by looking at the first word against a hand-kept list. Two newer messages weren't added to the list, so they turn red even though the action worked.

**What the installer feels:** They tap Redo. The confirmation appears in red. It reads like it failed, so they tap it again — filing a second redo. Same for marking a window damaged.

**File:** `app/src/pages/install/OpeningSheet.tsx`, line 1159.

**Exact fix:** Stop guessing from the words. Store the tone alongside the message (`setMessage({ text, tone: "ok" })`) and set it at each place a message is written. The quick patch is to add "Redo" and "Marked" to the list, but that list will break again the next time someone adds a message. One small judgment call: you may want "Marked damaged" to be amber rather than green, since it's a caution, not a win. The app already has an amber style.

---

### 8. Typing a window's serial on the Scan page always says "not found"
**Confidence: high.**

**What's broken:** The box says "6-char code or serial." The lookup behind it only ever checks the short code and window ID columns — never the serial column. The serial *is* printed on the label, and a QR scan of the same label works fine.

**What the installer feels:** They read the number off the sticker, type it exactly as printed, and get "No window found." Nothing about the screen explains why.

**File:** `app/src/pages/Scan.tsx`, around line 70.

**Exact fix:** When the code lookup comes back empty, fall back to `findWindowBySerial` — the same fallback the QR-scan path already does correctly.

*(There's a second, bigger question about that box existing at all — see Proposal C.)*

---

### 9. Taking supplies can log them to a job that already finished
**Confidence: high.**

**What's broken:** The Take screen remembers the last job you used. Once that job wraps up, it drops out of the job dropdown — but the screen still has it selected behind the scenes. The dropdown shows nothing picked, the Take button stays live, and it submits the old job.

**What the installer feels:** They grab caulk, glance at the dropdown, see it's not showing an obviously wrong job, tap "Take it." The material lands on a finished job's costs. Nobody notices.

**File:** `app/src/pages/Supplies.tsx`, around line 250.

**Exact fix:** Copy the guard that already exists on the tag-packages screen (`app/src/pages/TagPackages.tsx`, lines 64-70): once the job list loads, if the remembered job isn't in it, clear it.

---

### 10. The job page shows installers three buttons that go to a "not available for your role" wall
**Confidence: high.** *(Two findings merged — same file, same mistake.)*

**What's broken:** Three links aren't checked against the installer's role, even though this same file already does that check correctly for other buttons right next to them.

**What the installer feels:** They open any job. The main blue button says "Upload plansets." Next to it, "Review openings." Over on the Warehouse tab, "Print the shelf labels." All three dead-end on a "Not available for your role" screen. The app's own notes say a button that lands there is worse than no button.

**File:** `app/src/pages/ProjectDetail.tsx` — around line 507 (the first two) and line 1200 (the labels link).

**Exact fix:** Wrap all three in `{isLead && (...)}`. That value is already sitting there in the component and is exactly the level the routes already enforce.

---

### 11. "View my timecard" inside the clock sheet opens the wrong page
**Confidence: high.**

**What's broken:** The link points at `/clock` (a second clock-in/out screen) instead of `/timecard` (the actual hours summary). The right page exists and is registered under the exact words this link uses.

**What the installer feels:** They tap "View my timecard" expecting hours, and land on another clock-in screen with a clock-out card. They have to back out and hunt.

**File:** `app/src/components/clock/ClockSheet.tsx`, line 872.

**Exact fix:** Change `to="/clock"` to `to="/timecard"`. That's the whole fix.

---

### 12. "Lunch" and "Break" in the done popup are the same button
**Confidence: high.**

**What's broken:** Both buttons call the break function with no type, so both record as "other." The app has real break types (lunch, rest, other) and the clock sheet uses them properly.

**What the installer feels:** Nothing on screen — which is the problem. They tap Lunch, and the record says "other." Your break records from that screen are worthless for telling lunch from a rest break.

**File:** `app/src/pages/install/OpeningSheet.tsx`, around line 2193.

**Exact fix:** Have the break action take a type and pass it through. Lunch → `"lunch"`. The only small call: whether "Break" records as `"rest"` or `"other"` — I'd say `"rest"`, since that's what the button means. Everything else here is mechanical.

---

### 13. Home spots stop telling you anything once the phone loses signal
**Confidence: high.**

**What's broken:** The list of shelf and bin addresses isn't on the offline save list, even though the supplies themselves are. Without it, the app can't turn "home spot #47" into "Bin A3."

**What the installer feels:** In the conex with no bars, every supply that *has* a home spot just reads "home spot set." That looks the same as a properly set-up supply but tells them nothing about where to go. The whole point of a home spot is that it can be said out loud.

**File:** `app/src/lib/queryClient.ts` (the `OFFLINE_KEYS` list) — the screen affected is `app/src/pages/Supplies.tsx` line 113.

**Exact fix:** Add `"locations"` to the offline save list.

---

### 14. "Going out" package counts go wrong once there are more than 40 out
**Confidence: high.**

**What's broken:** The list is cut to 40 packages *before* it's grouped by job, and the order it's cut in is based on when packages were tagged, not when they went out.

**What the installer feels:** A job says "2 packages out" when it's really 5, or the job doesn't appear at all — even though those packages left five minutes ago. No warning that anything was cut.

**File:** `app/src/pages/Warehouse.tsx`, line 281.

**Exact fix:** Group first, then cut: `groupByJob(goingOut).slice(0, 40)` instead of `groupByJob(goingOut.slice(0, 40))`. Same 40-card limit on screen, correct counts.

---

### 15. A returning installer is told to "clock in first" on a window they already started
**Confidence: high.**

**What's broken:** The button's label checks clock-in status before it checks whether work already started. The button's *behavior* checks them in the right order.

**What the installer feels:** They started a window yesterday, come back this morning before signing today's talk. The button reads "Clock in first to start" — but it's live, and tapping it takes them straight back into the install. The label is simply lying.

**File:** `app/src/pages/install/OpeningSheet.tsx`, line 1826.

**Exact fix:** Move the "already started" check ahead of the "blocked" check in the label, matching the order the disable logic already uses.

---

### 16. "Change window" during the 5-minute grace window can put you on a blocked window
**Confidence: high, with one caveat.**

**What's broken:** The automatic recommendation filters out blocked windows — the code comment says "the chain must never propose a window that's sitting blocked." The manual picker right next to it doesn't apply that filter.

**What the installer feels:** They redirect their running session onto a window that's flagged for missing hardware, with no warning at all, and the clock starts running on work that can't proceed.

**File:** `app/src/pages/install/OpeningSheet.tsx`, line 1070.

**Exact fix:** Add `&& !queueBlockedIds.has(o.id)` to the filter. That value is already computed a few lines up.

**Caveat:** hiding them entirely matches what the automatic pick already does, which is why I put this here. If you'd rather show them grayed out with the reason, that's a small design call — say the word and it moves to the proposals list.

---

### 17. The "ready now" count includes windows the same screen labels blocked
**Confidence: high.**

**What's broken:** The stat at the top of My Work doesn't check whether a window is blocked. Every other part of that screen does.

**What the installer feels:** The header says "2 ready now" while one of those two is sitting in the list below tagged "blocked — missing hardware." Small, but it makes the number untrustworthy.

**File:** `app/src/pages/MyWork.tsx`, line 265.

**Exact fix:** `active.filter((o) => !blocks.has(o.id) && openingReadiness(o).status === "ready").length`

---

### 18. Drawings never finish loading ahead of time
**Confidence: medium-high.** *(The mechanism is certain. How often it actually bites depends on timing.)*

**What's broken:** The screen tries to load window drawings in the background while the list sits idle, so a tap is instant on site. But a small mistake in how the data is tracked makes the app throw away and restart that background load on every single redraw. It has 0.6 to 2 seconds to finish, and the screen redraws more often than that while data is coming in.

**What the installer feels:** They tap a window expecting the drawing to already be there, and wait for it to load instead. It still works — it's just slower than it was designed to be. Same file already solves this exact problem correctly 40 lines further down.

**File:** `app/src/pages/MyWork.tsx`, line 163.

**Exact fix:** Base the tracking on each query's `dataUpdatedAt` timestamp instead of rebuilding an array each time.

---

# 2. PROPOSALS — Need Your Approval

Each one changes what an installer sees or how they work. My recommendation and reasoning are with each.

---

## A. There are two different clock-in screens, and they behave differently
**Ranked #1 — this hits every installer every morning.** *(Three findings merged.)*

**The problem:** The app has two separate clock-in screens built at different times.

- The **Clock tab** at the bottom of the screen (the newer one, updated as recently as today) never blocks clock-in, lets you sign the toolbox talk right there, asks which break type you're taking, and holds your punch safely if you have no signal.
- The **`/clock` page** (the older one, untouched since Aug 10) hard-blocks clock-in until the talk is signed and bounces you to a separate Safety page, records every break as "other," lets you clock in with no job picked at all, and drops your punch on the floor if the network is down.

Home's big "Clock in for your job" card — the most obvious morning button in the app — points at the old one. So do your push notifications.

**What the installer feels:** Same action, two different experiences depending on which button they happened to tap. The more obvious button gives them the worse one.

**My recommendation: point Home's card and the push notifications at the Clock tab's sheet, then delete the old `/clock` page.**

**Reasoning:** The Clock tab version is the one that matches what you decided and wrote down ("clock in and land on the recommended window," gates stay on the sheet). It's the one being maintained. Keeping two copies means every future clock change has to be done twice, and history shows it won't be — that's exactly how this gap opened. Deleting the old page also kills three separate bugs (no-job clock-in, missing break types, no offline safety) for free instead of fixing each one twice.

**Trade-off:** Something has to happen for the push notification deep links and any bookmarks pointing at `/clock`. Simplest answer: keep the `/clock` address alive but have it just open the clock sheet. That's a small amount of extra work, and it means one more thing to test.

**If you'd rather not delete it:** the fallback is to fix the old page to match the new one — remove the toolbox hard block, require a job, add break types, add offline safety. That's four separate changes and leaves you maintaining two screens forever. I don't recommend it.

---

## B. Finished installs can sit stuck on a phone with nobody ever knowing
**Ranked #2 — this is a records-and-payroll risk, not just an annoyance.** *(Two findings merged.)*

**The problem:** Marking a window installed is the most important thing the app records — the RPC, the points, the photos. When it happens with no signal, it goes into a holding queue on the phone. Two things are wrong with that queue:

1. **Nothing anywhere shows it.** There's a live sync counter in the app's header ("Clock 1 · Photos 3"), but it's a completely separate system that doesn't know about installs. The install queue has its own notify system built for exactly this — nothing ever hooked into it. Once the installer taps "Next one," the screen fully resets and the only signal they ever got (a toast at the moment of submission) is gone.

2. **If a send fails permanently, it retries forever, silently.** Every 30 seconds, every reconnect, forever, with no cap and no way for it to ever be flagged as needing attention. The clock-punch queue in this same app already does this right — it gives up after 8 tries and marks the item as needing a human.

**What the installer feels:** They finish three windows in a canyon, tap through, and drive off. Nothing on any screen tells them those three installs haven't landed. If one of them is permanently broken (bad data, deleted window), it never lands and nobody is ever told.

**My recommendation: do the visibility part first, on its own, and make it part of the existing header sync pill. Do the retry cap second, and only alongside a way for a foreman to see and act on a stuck install.**

**Reasoning:** Visibility is the cheap half and fixes the scary half of the problem — right now a bad outage is invisible, and that's what turns a delay into a lost record. The retry cap is genuinely dangerous to do alone: today a stuck install eventually heals itself when the phone gets signal, but if you cap the retries without building somewhere for the failure to show up, you'd trade "eventually recovers" for "silently gives up forever." That's worse.

**Trade-off:** Part two needs real decisions from you — who sees a stuck install (the installer, the foreman, you?), can they retry it by hand, and does a stuck install block the window from being marked done. That's a design conversation, maybe 30 minutes. Part one is just plumbing.

---

## C. The Scan page has two typed boxes and a link that goes nowhere useful
**Ranked #3.** *(Two findings merged.)*

**The problem:** The Scan page stacks two separate typed-entry boxes on top of each other. The upper one (built into the scanner) handles everything — windows, shelf locations, container serials. The lower one only ever tries to look up a window, and doesn't even do that fully (see unambiguous fix #8). Below both, a button says "Or search by ID →" that now just dumps the installer on the general Warehouse page, throwing away whatever they typed. The dedicated search page it used to open was deleted.

**What the installer feels:** Three ways to type the same thing, two of which are worse than the third, and one of which throws their typing away.

**My recommendation: delete the lower box and delete the "Or search by ID" link. Keep only the scanner's own box.**

**Reasoning:** The scanner's box already does strictly more than the box below it. The "search by ID" link no longer means anything — nothing in the app owns that phrase now that the search page is gone, and the Warehouse page's find bar covers it. Fewer boxes on a screen an installer uses every day, and it removes the serial-lookup bug rather than patching it.

**Trade-off:** If any installers have built the habit of using the lower box specifically, it disappears on them. I think that's fine — they get one box that does more. If you'd rather keep the link, the alternative is to carry their typing over to the Warehouse page as a pre-filled search, which is more work and still lands them on a big busy page.

---

## D. The empty screen says "Nothing assigned" when the real answer is "everything's blocked"
**Ranked #4.**

**The problem:** My Work shows "Nothing assigned right now — check with your lead, or help stage the next windows" both when an installer genuinely has nothing *and* when they have windows but every one is blocked. In the second case, the same screen also shows "3 assigned" a bit further down, and lists the blocked windows below with their reasons. The screen contradicts itself.

**What the installer feels:** They open the app, are told they have nothing to do and should go help elsewhere, and only find out otherwise if they scroll.

**My recommendation: when they have windows but all are blocked, replace that message with a short block that says so and lists the reasons — something like "All 3 of your windows are waiting on something" with the reasons underneath, and a way to call their lead instead of "browse jobs."**

**Reasoning:** The honest answer is more useful than the generic one, and the reasons are already loaded on the page. It also stops an installer from wandering off to another job when the real fix is a five-minute phone call about missing hardware.

**Trade-off:** It's new wording and a new small piece of screen, so it's real design work rather than a code fix. The cheap version — just don't show the "Nothing assigned" message when they do have windows — takes ten minutes but leaves the top of the screen oddly blank. I'd rather do it properly.

---

## E. My Schedule shows the job address but won't give directions
**Ranked #5.**

**The problem:** My Schedule is the screen an installer opens every morning to find out where they're going. The address is printed on the card as plain text. Every other screen in the app that shows an address — the job page, the travel pack, the Today card — puts a one-tap Directions button next to it. This one doesn't.

**What the installer feels:** They see the address, then have to tap into the job page and find the map to actually navigate. Every installer, every job, every morning.

**My recommendation: add the existing Directions button next to the address on the schedule card.**

**Reasoning:** The button already exists as a reusable piece, it's already built to work inside a tappable card like this one, and the address is already loaded. This is the highest value-per-hour item in either list.

**Trade-off:** Placement and wording are a design call — the schedule card is already fairly busy. Worst case it makes the card feel crowded on a small phone, which is a 10-minute layout adjustment.

---

## F. Any installer can add new items to the company supply catalog
**Ranked #6.**

**The problem:** Setting a supply's home spot is deliberately foreman-and-up — the code says so, the database enforces it, and the reason is written down: "the home spot is the answer the app gives an installer, so somebody accountable sets it." Directly below that gated button, "Add to catalog" has no check at all — not in the app, not in the database. Any signed-in installer can create a new company-wide supply. There's also no duplicate check, so you can end up with "Caulk," "caulk," and "Calk."

**What happens:** Nothing dramatic — but your supply list slowly fills with duplicates and junk entries, and once it does, the counts on any given item stop meaning anything.

**My recommendation: leave the button open to installers, but add a duplicate check on the name.**

**Reasoning:** The rest of that page is deliberately low-friction for crew — taking and counting supplies are open to everyone by design. An installer who opens a new box of something the office never listed *should* be able to add it rather than wait. The actual damage isn't unauthorized access, it's a messy list, and a duplicate check fixes the mess directly. Gating it would create the "have to text the foreman to add a screw type" friction you built this app to eliminate.

**Reasoning against my own answer, in fairness:** if you think of the catalog the same way you think of home spots — the app's official answer, set by someone accountable — then gating it behind foreman is the consistent call, and it's a one-line change. Tell me which way you see the catalog and I'll go that direction.

**Trade-off:** A duplicate check is more work than a role gate (it needs matching logic and a "did you mean this?" message), and it won't stop a determined typo.

---

## G. A failed clock-in can strand the clock-out behind it forever
**Ranked #7 — rare, but when it happens the punch is gone with no trace.**

**The problem:** A clock-out is tied to its clock-in, so it can't be sent first. That's correct. But the check is "is the clock-in still sitting in the queue?" — and a clock-in that has *permanently failed* is still sitting in the queue, just marked failed. So the clock-out waits on it forever. The clock-out itself never gets counted as failed, never shows up in any count, and there's no screen anywhere to clear or retry a failed item.

**What the installer feels:** Their clock-in fails permanently — the most likely cause is being offline long enough for their login token to go stale. They see a generic "needs attention" badge from the clock-in. Their clock-out is also lost, but nothing anywhere ever mentions it.

**My recommendation: when a clock-in permanently fails, immediately mark everything waiting on it as failed too. Then build one simple screen where a foreman can see failed punches and retry or clear them.**

**Reasoning:** Right now a failed item is invisible and unfixable — the code's own notes promise failed items "need human attention, never silently dropped," and there is currently no human anywhere in the loop. Cascading the failure at least makes both punches visible and counted. The retry screen is what makes it actually recoverable.

**Trade-off:** This is real new work, not a patch — a new screen and decisions about who can use it. It's also rare: it needs a permanent failure, not just a dead spot. I'd put it behind Proposal A and B, but not drop it, since a lost punch is a payroll dispute.

---

## H. The toolbox talk history page is finished but nothing links to it
**Ranked #8.**

**The problem:** There's a working 30/90-day toolbox compliance calendar that marks missed days in red. Nothing in the entire app links to it — you can only reach it by typing the address. A test file's comment claims it's reached from the clock sheet; that's simply wrong, there's no such link. Meanwhile the Safety page shows its own simpler "My signed talks" list that only shows what was signed, not what was missed.

**My recommendation: replace the Safety page's simple signed-talks list with a link to the full history page.**

**Reasoning:** The history page does everything the simple list does and adds the missed days, which are the part that actually matters for compliance. Keeping both means the same information in two places with two different answers. The history page's own back button already points at Safety, so that's clearly where the author meant it to live.

**Trade-off:** Installers who use the current inline list lose a glance and gain a tap. If you'd rather not do that, the softer version is to keep the list and add a "View full history →" link under it — less clean, zero risk. Either way, someone should fix the wrong comment in the test file so the next person isn't misled.

---

## I. The supplies preview on the Warehouse page shows the first six alphabetically
**Ranked #9 — smallest item here, listed because it's cheap.**

**The problem:** The Warehouse page shows six supplies as a preview. They're just the first six alphabetically, and the rows aren't tappable — the only way in is a generic "Take supplies" button that reopens the full unfiltered list.

**What the installer feels:** They see roughly A-through-F regardless of what they actually need, then search and scroll on the full list for anything else.

**My recommendation: sort the preview by what's low on hand instead of alphabetically. Leave the rows non-tappable.**

**Reasoning:** Low stock is the thing worth putting in front of someone; the alphabet isn't. Non-tappable matches how the "going out" section right above it already behaves, so the page stays consistent.

**Trade-off:** Making rows tap straight into the take flow would save more taps, but it needs the supplies page to accept a "which item" parameter it doesn't have yet. Not worth it for a six-row preview unless you want it.

---

# Notes on Confidence

Everything on both lists was checked against the actual code — file, line, and the surrounding logic — and then checked a second time to see whether something elsewhere already handles it or whether a comment or design doc says it's intentional. Nothing here is a guess about what the code *probably* does.

Two places where I'd flag the honest limits:

- **Item 18 (drawing prefetch)** — the mechanism is certain, but I can't prove how often it actually costs an installer a wait. It might be most of the time, it might be occasionally. It's a real defect either way and cheap to fix.
- **Item 16 (blocked window in the change picker)** — the fix is certain, but whether blocked windows should be *hidden* or *shown grayed out with the reason* is arguably your call. I put it in the fixes list because hiding them matches what the automatic pick already does.

Several findings came in as "high severity" and I've ranked them lower than that here, usually because the door is closed at another layer — for example, the dead-end buttons on the job page are annoying, but the pages behind them are properly locked, so nobody gets access they shouldn't have.