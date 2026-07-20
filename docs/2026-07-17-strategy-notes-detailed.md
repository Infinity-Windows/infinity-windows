# Infinity Windows / St. George Windows — Ops App: Detailed Strategy Notes

*A thorough, faithful summary covering **both** 2026-07-17 conversations: Transcript #1 (the ~1-hour speaker-labeled strategy conversation on QR-tracked installs, voice memos, and role-based dashboards) and Transcript #2 (the follow-up on the project map, per-unit IDs, QR/PIN hybrid, toolbox talks, and role access). Speaker 1 = Taylor, Speaker 2 = Ammon. This document preserves the reasoning, the back-and-forth, direct quotes, and concrete domain details — it deliberately does not over-compress.*

---

## 0. How to read this document

This is a reference document, not a terse summary. It is organized so that:

- **Sections 1–9** walk through the substance of the discussion topic by topic, preserving the reasoning and the exchange between Taylor and Ammon.
- **Section 10** captures the full A-to-Z window-installation walkthrough Ammon gave (kept in detail because it defines what a "gold standard" install memo looks like and what the app must respect).
- **Section 11** covers the domain facts about window/door installation the app must respect.
- **Section 12** covers where Transcript #2 refines, changes, or adds to Transcript #1.
- **Section 13** lists firm decisions, open questions, action items for the AI, and the recurring meta-instructions ("cut the fat," challenge us, ask questions).

Where a quote carries the flavor or intent, it is reproduced verbatim and attributed.

---

## 1. What the company is and where this app fits

Ammon framed the company at the very top: **St. George Windows** can be thought of as **two businesses that are currently one but are trying to separate** — (1) **sales and procurement** and (2) **installation and servicing**. The app being designed lives on the **installation and servicing** side. As Ammon put it: *"We are going to be in charge of installation and servicing."*

What the company actually installs:

- **Commercial windows and doors** are the main business.
- **Some residential**, but "usually the residential are pretty large or custom windows and doors for higher quality homes."
- **Mainly exterior** doors and windows. *"Very rarely interior. Don't do a ton of that."*
- A **really wide variety** of door and window types. A stated goal is to **"list out and capture every product that the sales team offers"** (i.e., build a full product catalog).

Example of product variety Ammon gave to show how one product has many configurations:

- A **sliding door** can be a **4-panel or a 6-panel** slider that slides all the way across the rack. You can open all 6 panels, or have **2 stationary panels on each side**, or **1 stationary panel on each side and open it from the middle**. *"There's a lot of custom ways that we can install doors, and it all depends on what the customer wants, but the install doesn't change too aggressively."*
- **Repeats are the norm.** *"Most of the time we have repeats. All the time we have sliding doors, or bifolds, or stationary doors."*

Things that change per job:

- **Frame material: vinyl vs aluminum** (big topic — see §11).
- **Color** — aluminum is typically **black** ("that's just the manufacturer's standard"); vinyl is often **white** ("White is popular for the vinyl choice").

**The core problem the app is solving** (Ammon's thesis): today there is **no procedure for accountability**, no large coordination between the team for solving issues or locating doors, and materials at the warehouse are hard to find. Even something as simple as which screws to use is undocumented: *"We use the same type of screws on all sorts of doors, and yet nobody knows the standard or permanent location of all these screws that we use all the time."* Whether you're using **paper flashing or sticky flashing** isn't known until you go ask the crew lead.

---

## 2. The crew-lead-as-bottleneck thesis (central organizing idea)

This is one of the most important ideas in Transcript #1 and worth quoting at length. Ammon:

> "So essentially the crew lead is the bottleneck that we're trying to solve. We're trying to give the information in this company that is usually given by the crew lead to every single person to have constant access to. Trying to eliminate how many decisions have to be made and how many people have to be waited upon to execute a proper installation on a door or window."

The logic: every piece of tribal knowledge currently locked in the crew lead's head (which flashing, which screws, inset vs outset, is it stucco or rock, etc.) is a **decision that has to be waited upon**. Each wait is lost install time. The app's job is to **push that knowledge down to every installer** so they don't have to think or wait.

Refined later into the mantra Taylor and Ammon landed on:

- Ammon: *"Less time thinking, more time installing."*
- Taylor: *"Roles are clearly identified. The people we pay to think, think. The people we pay to work, work."*

This connects to the **blocker-chain / role thesis** (see §6): the whole org is a chain of removing pain points from the person beneath you, ending at the installer.

---

## 3. The two big goals: gather data AND explicitly track it

Taylor summarized what he heard from Ammon's opening, and Ammon confirmed ("Yes"):

1. **Gather as much data as possible** — data on every material type installed, data per installer, etc.
2. **That data must be explicitly tracked** — not dumped. Taylor: *"We're not just gathering data to put in a big dumpster can. Every single set of data gets stored somewhere because it's useful and it can be used to help future installs."*

This sets up the philosophy that gets sharpened later: **implementation vs tracking**, and **"installers are the data"** (see §5).

---

## 4. The window/door lifecycle and per-unit IDs (the tracking spine)

Taylor walked the chain "from the very first part of the chain for our company." The lifecycle:

1. **Delivery into the warehouse** — the first place data is tracked. *"We have to track and document every single piece of equipment that just got delivered into our warehouse."* Mechanism: **each thing needs its own specific ID** (QR code "whatever") "so that it can be tracked from the second it gets into the warehouse to the second it gets installed, and then from there after."
2. Everything done to that window is tracked and easily accessible — Taylor: you can access **"this window's life in the app"**: when it arrived, where it is in the warehouse, what job it's going to, when it got to the job, who installed it, how they did it.
3. **AI learns all of it.** Voice memo → transcript → into an **"AI brain"** → AI stores it and **compares it against all other installs for like windows.**

### 4a. Ammon's refinement: IDs start *before* delivery, from the plan set

Ammon pushed the start point earlier: *"it starts barely before where we have our plan set so that we're predicting what windows are coming in."*

- You can **pre-ID every window** based on what's been sold and is going to be installed, then **assign the ID to the physical window once it shows up.**
- **Missing-delivery detection:** if a window has a **pre-printed ID that never got assigned**, "we know immediately that that ID never got assigned, and we are missing that window on the delivery." This double-checks what's actually being shipped in.

### 4b. Warehouse = an all-encompassing term (multi-location)

Windows are stored in **containers and sometimes in different locations**, not just one building. "Warehouse" is an umbrella term — e.g., *"warehouse Tech Ridge, Tech Ridge warehouse,"* or "location X" where a container sits, "but that's all part of the warehouse." So when you QR/ID a door, **it should also give you the location** of that door.

### 4c. Movement tracking (checkout / delivery / receipt)

Part of the ID's purpose is to **track every single time a door moves.** Ammon's workflow:

- A job gets, say, **20 doors and windows assigned** to it.
- At the warehouse, someone **multiple-choice selects the IDs** as the windows go out ("You manually see it going out... it's a multiple-choice selection so that you can check off every window is going to that site"), then **submits** and says **"load it."**
- The person who drops it off puts them on the job site and says **"unload it" / "at location,"** and can add extra flags like **"none are damaged, all in good condition"** in case anything happens in transit.
- Result: the **office is constantly aware**; if a window is missing/broken/damaged, "we can get a new one ordered to replace it as soon as possible."

### 4d. The upload-plan-set-first workflow

Taylor: *"the very first step would be having the app... uploading a PDF plan set or CAD into the app."* Ammon: "Yes." Taylor: *"The app understands what we need before we even have the material. We can create IDs for all these windows automatically."* This is the origin of the plan-set-driven, auto-ID pipeline that Transcript #2 refines with the map.

---

## 5. "Installers are the data" — implementation vs tracking

Midway through, Ammon crystallized the design philosophy — a key quote:

> "There are two different things. There is implementation, and then there's tracking. What is the point of tracking? The point of tracking data is to make decisions better for implementation, and that's it. So all of your guys who are installing are the implementers, and they do not need to see data. **They are the data.** We need to keep data separated from them."

Consequences that both agreed on:

- The **only data an installer needs to see** is *"How do I install my window? How do I install my door?"* All the preliminary data that produced that advice is upstream — installers don't get the whole database. *"That's not how it works. We don't want them staring at that. That's useless buttons for them to be viewing."*
- **Very defined, very specific roles** so that each person "has the least amount to do for the best amount of tracking and the best amount of shit getting done."
- **Do not over-instrument the installer.** The nightmare to avoid: a 5-minute window that now requires "10 different steps to log this window when the amount of time that takes them to just do another window, that's ruining their time." Taylor: *"Useless. That's useless."*

### 5a. The "spam-through" logging UX

Because logging must be near-zero-friction, Ammon described a **rapid button flow**:

> "They need a button where they can spam through after they finish a window. They want to finish a window and say, 'Done, next window, started.' It should pop up, pop up, pop up, and click, click, click, click, click."

- After **"Done,"** the next button that pops up is something like **"Next one / lunch / take break."** If "Next one," it immediately shows the next assigned window and **"Start task."**
- Target: *"as soon as they finish a window, they open up their phone, and it takes them less than 5 seconds to move on to their next thing."*
- The app **starts the timer automatically** — the installer doesn't manually start timers. *"Our app should immediately start a timer."*
- **Clock-in via task:** their break "ends the next time they get on site and they say, 'I am now on this window.'" This **also tracks all their hours** — *"it's basically the way they clock in. I landed on job, and I'm doing this task."*

### 5b. Time tracking = project management (synergy)

Taylor noticed the time-tracking mechanism works "synergistically and perfectly" with project management and the installer's management of their day. *"You could almost not even separate the two functions if you wanted to... To them, that's what it is."* Ammon agreed it *is* time tracking. Taylor's caveat: *"Not that we want to do that, but it is interesting how synergistically it's working."*

---

## 6. Roles, access levels, and the blocker-chain

### 6a. The role hierarchy

From Transcript #1, Ammon proposed starting with **three stages**: **installers → foremen → supervisors**, described as a **"general–specific, more specific"** structure that correlates to how many people are under each person.

Current sizing (Ammon's estimate for the business today):

- **One supervisor.**
- **Two to four foremen.**
- **Guys (installers)** under them.

Transcript #2 (Ammon) **added a fourth role — owner** — and defined the access ladder explicitly:

> "An owner can see everything. A supervisor can see most things. A foreman can see a lot of things, and an installer can see some things."

He explicitly asked the AI to **recommend how to separate these roles and make each one user-friendly to its particular role.**

### 6b. The blocker-chain thesis (removing pain points downward)

Ammon's model of what each role is *for*:

- **Supervisor:** make sure the correct windows are coming into all projects the foremen are on; make sure the correct/up-to-date plan sets are on all these guys; get the "green light" on all projects; *"basically be taking out of the way whatever would block a foreman from landing on site and operating a crew to maximum efficiency."* The supervisor absorbs **uncontrollables** — the classic example: **is the exterior stucco or rock?** (this changes whether you set the windows out by ~**1 inch vs 1.5 inches** — see §11). The foreman **can't decide** that; the supervisor must have collected it from the contractor. If the contractor doesn't know, the supervisor **flags it as a non-starter**: *"I cannot send my guys to go and install an entire building where I don't know whether they've decided to do rock or stucco."*
- **Foreman:** *"I have one job and one job only, and it is to organize the eight guys under me to install this job as fast as possible. Nothing's holding me back."* Every door on site and accounted for; every needed conversation with the GC already had. The foreman's job is **not to problem-solve project uncontrollables** — it's to take care of the installers and solve installer issues as fast as possible. Foreman questions are logistics: *"How many trucks do I have? What tools do I have? How do I utilize my crew? How do I get all these things on site as fast as possible?"*
- **Installer:** *"Installer's job is to install windows as fast as possible."* (Taylor said it; Ammon: "That's right.")

Ammon summed up the chain:

> "It's a chain of removing pain points from the person beneath you, and it ends at the installers, who actually are the most vital and critical part of revenue... that's where the majority of your labor costs sit anyway, and majority of your revenue. So the more efficient this bottom layer is, that is the best tracker for how efficient your business is."

### 6c. Who sees data (per role)

- **Installers:** no access to the aggregate database; just their install instructions and their tasks. Ammon (T2): installers should **not** see the **issues list**; installers should **not** see the **uninstalled/failed-install list**.
- **Supervisor:** one-click **project heartbeat** (see §7), assigns windows, sees the **issues list**, sees the uninstalled/failed list.
- **Foreman:** assigns windows (a large part of their job), sees the **issues list**.
- **Supervisors and owners:** *"the people who should have the full access to the data if they want it. Supervisors if they want it, owners for sure."* So owners can ask "why is this foreman so much better than this one?" and the supervisor can explain with context ("that was a really hard project... this foreman was actually amazing," or "this foreman has been slacking... here are my concerns").

### 6d. Foreman/supervisor-only work

- **Assigning windows** is a foreman/supervisor function — explicitly *not* on the installer login: *"What doesn't need to be on an installer login is assigning windows. He got assigned windows."*
- **Scheduling** every window to employees for the day was flagged by Taylor as "a vital part to this to work good." Whose job? They leaned foreman/supervisor within the general-specific model: **max out the supervisor first, then pass the next set of responsibilities down to the foreman.**

---

## 7. Views per role: what each person opens the app to

### 7a. Installer view

- **Pick project → clock into project.** Taylor: *"Do I click a project? I click the project I'm working on... I clock into that project."*
- **See my tasks / my windows for today (and tomorrow / the week).** Both agreed windows should be **pre-scheduled/pre-assigned** so installers aren't stepping on each other. Taylor's rationale: with six installers, *"the crew lead can go assign the windows to all the guys that day so that I know all the windows I need to install on my phone. I don't need to go ask crew lead, 'What's next?'... I'm not stepping over, 'Oh, you're doing this window. You're doing this window.'"* Ammon wanted **tomorrow visible too** so an installer can see how the week and the volume will go.
- **A task = installing one window.** Structure: **Start task → install → fill out data / voice memo (how it went, tips & tricks) → End task.** Taylor: *"Every single window does that, because that's not hard. It's not hard to do."*

### 7b. Supervisor view — the "heartbeat"

Taylor's vision, quoted:

> "Supervisor needs to, without checking the entire project, see the current progress of the project instantly. One click, I can see the entire progress of my job. I don't need to go check on him or him or him or him... I can do it in 10 seconds. I can see issues going on. Oh, this person's currently on minute 30 of a 10-minute window. Probably need to go check on him."

> "I would love to open my app and see the current heartbeat of my project, lifetime."

### 7c. Install vs Warehouse as the two main halves (T1)

Taylor: *"there's the other side of the app that's the warehouse. Warehouse is such a big part of this app. There's the install, and then there's the warehouse."* The two main parts = **my work/jobs** and **warehouse**. They **need to be interlinked but remain two separate things** — *"not so integrated that it's hard to understand in the app my course of action in progressing a window or a job."*

---

## 8. Time tracking, the points/grading system, and difficulty ratings

### 8a. Three tracked time states (crucial)

Taylor defined **three times that are tracked**, and both agreed these are "crucial, crucial":

1. **On task** — actively installing a specific tracked window.
2. **Off task** — between tasks, i.e., *"preparing for next task, for the most part."* Not a break — you're clocked in and working but not on a window.
3. **Break time** — an explicit break: *"I'm on lunch,"* or *"I'm currently not working."*

Ammon initially wanted to fold "off task" into a break/off-task button; Taylor distinguished them as **two different lines of thinking**, and Ammon agreed ("That's a good idea").

- **Intermediary/transition period:** when you End a task and the day isn't over, the app enters an intermediary period to learn *"how long on average does it take someone to switch from that window to their next window."*
- **Prep time:** they agreed **prep time should probably count as part of the installation time** ("think of these huge windows").

Why this matters — Taylor's flag-the-slacker logic: *"If there is an employee that is spending as much time off task as they are on task, that is a low-ranking employee, and that needs flagged."* And you can't cheat by staying "on task" on a 10-minute window for an hour because the window is heavily tracked — *"numbers don't lie."* Taylor's bigger point:

> "It's not even about windows. It's about managing people and making the business numbers... It's no longer Bob and Joe and blah blah blah, and he hates me and I hate him. It's just easy systems and processes. This works, this doesn't work."

### 8b. The points system for installers

Ammon: *"I want to assign a point system to installers,"* based on collected data.

- As similar doors accumulate (e.g., "15 doors installed previous to this one that are similar"), the app derives an **average install time.**
- Installers may **clock in on a door/window depending on complexity.**
- **Batch timing for easy identical windows:** *"there's 10 windows that are extremely easy and extremely similar. Clock the time it takes you to install all of them... then we'll see how long it took you to install each one."* This avoids logging each 5–10-minute window individually.
- **Focus timing on complicated units:** sliders, glass that can change transparency, *"the ones that will take three guys an entire day."* Knowing how long those take lets the next crew estimate and set goals for the hardest units, "the ones the crew actually gets stuck on and the issues are most around."
- **Cross-referencing installers:** almost every install is a **two-person job regardless of size**, so *"you'll be able to have cross-reference data on two installers at least every single time that you are collecting it."*
- **Motivation:** points feed a **bonus**; Ammon predicts *"They will track it religiously because they want to have the shortest time."*
- **Grace period:** if something out of the installer's control happens (e.g., a damaged window), *"you're going to have to have a certain amount of grace period for them, for their point system... because that's out of scope of the issues they're facing."*

### 8c. Difficulty rating for windows/doors

- A **difficulty system for windows** that AI learns from all the data.
- **Initial seeding by the crew lead:** *"a crew lead will just give an initial grade to the difficulty of a window and an initial grading to the skill of an employee. And AI will then take it from there and learn."* (Both agreed — Ammon: "Yes.")
- Ammon wants **a bias toward higher-difficulty doors** in analysis: *"we can have a bias towards a higher difficulty door. Try to think harder about this."* (An explicit note-to-self / to-AI to refine.)

---

## 9. Voice memos — purpose, depth, the "gold standard," and per-window vs per-installer

This was a major, extended part of Transcript #1. They deliberately checkpointed and resumed to give it full attention ("let's make this a checkpoint... then we're going into memos").

### 9a. Purpose of the voice memo

The voice memo is the raw material for the AI brain. Its dual value (Taylor's insight): *"a voice memo gives as much information on the window as it does the installer."* The memo:

- Captures **A-to-Z install steps** for a window/door.
- Feeds transcripts into the AI brain so AI can **compare like installs**, **build a perfect memo** from many transcripts, and **answer installer questions** ("What does flashing mean? What is a seal plate?") by pulling from in-depth memos — Ammon: the AI can *"build a perfect memo from the transcripts that it has... that explains the seal plate so thoroughly because we have 20 examples of that seal plate."*
- Establishes **fail-point traceability** for the 1-year warranty: later you can say *"This window potentially failed because of this part in their installation... That's not company procedure anymore. That is what caused a fail point,"* and it can be **referenced and assigned to somebody.**

### 9b. Short memos for identical windows

For simple, repeated windows: one memo can cover many. Ammon: *"you might have 20 windows that are identical to that... Here's the method that I used to install one of these windows, and it's how I'm installing all 20 of these identical windows."* Installers should **not** repeat the full process for each identical window — **only re-memo if one window had something peculiar** they had to work around.

### 9c. The "cap at 20" idea (retire the memo requirement)

Ammon's proposal: collect a memo (say) **20 times** for a particular window/door, and after hitting the threshold, that window **no longer needs a voice memo** — *"We're good on this until this product gets an update or until a very unique situation arises."* For very common simple windows you might even go **30 or 40**. Once you hit the threshold, that becomes **"the standard for Infinity going forward until windows change"** (manufacturing style changes, or a new issue arises).

Why detailed-then-retire works — Ammon wants them **so detailed you almost want to claw your eyes out** until the cap is filled, because across 20 hyper-detailed memos, *"by the time a new guy gets on... they will never miss a key detail because it'll all be laid out."* Redundancy catches omissions: *"One of us caught flashing. One of us didn't. One of us said, 'You need this type of screw.' One of us did not."*

He also noted memos have **situational teaching** ("You have to flash the sides so that the water does this...") that could be trimmed for speed ("I flashed the sides, and then I did this"), but they may **keep the "why"** on every memo **to emphasize importance** — this won't necessarily change the concise instruction paper the installer is handed ("Flash the sides / Flash the top / make sure you get the flanges under the top one").

### 9d. Per-window vs per-installer (a genuine back-and-forth)

- Taylor asked: **tracked per window or per installer?** Ammon first said **per installer.** Taylor pushed back (the memo describes the window as much as the installer). Ammon reconsidered: for **one sliding door with three guys, each does a memo** (each catches things others miss), *"but I would consider that one sliding door installed, not three. So maybe I would say door over installer."*
- Taylor resolved the mechanics: the app **knows it's one door** because all three are on the **same IDed sliding door.**
- Landing: **collect per window/door, but allow multiple memos per installation** — e.g., 20 similar three-man sliding doors = **60 memos.**

### 9e. The "Bob / gold standard" idea (and its limits)

Taylor floated: what if one all-knowing expert ("Bob") sits down and records the **gold-standard** detailed memo for every window and stores it? He "most likely wouldn't miss anything."

- **Trade-off Ammon raised:** you'd have to **take that expert off installs for a very long time** — *"It would be their full-time job for a very long time"* — and he'd have to verify how each window was actually installed and **criticize wrong installs.**
- Taylor's refinement: the expert could go **job by job**, seeing each window **before** it's installed.
- **The gap Ammon identified — case-specific issues:** a golden memo assumes an ideal wall. Real example he gave: a **door with flanges on an out-of-level wall** — shooting a laser straight up, there was a **1.5" to 2.5" difference** bottom-to-top. On a level wall the expert just says "screw in the flanges"; on a tilted wall the installer must solve it (call the crew lead, or memo it as an uncommon issue).

### 9f. Handling case-specific issues (flag + append to the golden rule)

The agreed approach:

- When a **new/case-specific problem** arises on a window that already has a golden memo, the installer does a memo about it; the AI detects it's **novel** — *"This person talked about something that didn't exist before with this window... It can alert, say, 'New topic,' or 'Flagged transcript.'"* — and it can be **added to the golden rule.**
- **Proactively pre-record common exceptions:** have the expert cover commonly-arising case-specific issues in advance — Ammon listed **out-of-level walls, bumpy concrete, flooring that's too high, "contractor put in something that wasn't planned on."**
- **In-app escalation:** an installer can flag *"I have a complication"* to a foreman/supervisor; the professional gives advice; **the advice gets recorded as a voice memo.**

### 9g. Photos to capture (quality + accountability)

For a normal installer memo: a brief talk (what went well, etc.) **plus photos** of the important things:

- **Flashing** (important).
- **Level** of the window.
- **Inset / outset.**
- **Drain on the outside** (Ammon).
- **Caulk job / final cosmetic photo** — because a lot of these (especially custom units) are **finished** by caulking the entire exterior, and *"some people caulk way better than others."* The caulk is **often permanent** and **not hidden** — you tape off the door/wall to leave a ~**¾-inch gap**, caulk it, then **tool it**; some installers leave a smooth tooling line, others leave "bumpy and spotty and dusty caulk." So you want a **cosmetic photo** (also: **stickers and tape off**, "what does the final product look like").
- **Accidents photo** — a chance to say "I scratched the window," "this glass broke because we dropped it."
- **Preliminary damage photo** — taken **right at unpackaging** if a window arrives damaged, alerting the foreman/supervisor as a large issue so they can decide **install it or not.**

These map to **task-completion requirements** (upload photo for this task).

### 9h. Damaged-unit workflow → skip/upgrade task + issues list

- If a unit is damaged, the installer can **skip task and start the next task** (Ammon: "a great solution until it's resolved by the supervisor or foreman"), and the task gets **upgraded** into an issue.
- Every job has an **issues list** — **installers should not see it; foremen and supervisors should.**
- **Prioritization / flagging:** first-come-first-serve **except** when categorized. Ammon's scheme: **three exclamation points** outrank **one exclamation point**; within each tier, chronological order. Taylor's version: **to-dos → issues → urgent issues → flagged urgent issues**, and Ammon added **"even emergencies."**

---

## 10. Ammon's full A-to-Z install walkthrough (the reference gold-standard memo)

Ammon delivered an ~8-minute step-by-step for **the simplest window type** — a **nail-fin (flange) window** that "goes right into a slot and gets screwed in after you level it." This is preserved in detail because it defines the depth expected of a gold-standard memo and the domain facts the app must respect. Steps, in order:

1. **Unpackage** the window with a **utility knife** (it's surrounded by **foam, cardboard, and plastic**). Be careful **not to press too hard and scratch the frame.**
2. **Stand it up and find the drain** on the bottom — *"every single window will have a drain for the frame."* The drain side is the **outside** — that side faces out once installed.
3. **Determine inset vs outset:**
   - **Inset** = window sits on the inside of the frame; you install it **from the inside pushing out**, stopped by the frame.
   - **Outset** = inside of the window faces the inside of the building, but you install **from the outside**; outside ends on the outside, drain on the bottom.
4. **Check the sides of the frame for holes** — manufacturers put **drainage holes on all sides** depending on environment. St. George Windows' standard: **caulk off every hole on the top and sides, leave the bottom holes.** Result: one drain on the very front + two miniature drains on the bottom sides.
5. **Smooth over the caulked holes** with a **putty knife** so it's flush and clean.
6. **Caulk the flanges** that press against the house for a **watertight seal** — caulk **left, right, and top**, **not the bottom** (the flanges extend past the window and you **want drainage** there).
7. **Flashing (Ammon noted he'd forgotten to say this earlier — it happens before install):** flash **left and right sides before installing.** Whether you flash the **bottom** depends on how airtight/sealed the customer wants it; if flashing the bottom, do **bottom then sides for water shedding.**
8. **Lift and set** — with **one or two other people** depending on weight, **often with suction cups or ropes.** Place the **bottom of the window into the frame, then tilt it up.**
9. **Level it** — use a **lever (often a crowbar)** to lift the bottom and move corners; a person holds the window from outside; **shim underneath until level.** This is *"why these things are usually a two-man job."*
10. **Center it** — equal gap left vs right and top vs bottom **to the best of your ability**, but **level takes priority**: *"You choose level first."* If top/bottom or left/right must be exaggerated to reach level, that's fine.
11. **Set screws in the flanges** — one guy keeps holding while the other goes outside and **set-screws the flanges.** Once there are **enough set screws**, the holder can let go. After **all flange screws** are in, **remove the shims** and it stays put.
12. **Top flashing** — roll a layer of flashing **across the top** to connect it all; **the top flashing comes over the lip of the flange**, covering the top-side flange screws and shedding water down properly.
13. **Interior caulk** — caulk the **bottom of the window on the inside across the base and ~6 inches up the sides** for watertightness. (Recall the **outside bottom was left un-caulked** so water can escape; the bottom framing is often tilted slightly toward the floor so it **sheds water** rather than sitting level.)

Ammon's takeaway: **one 8–10-minute tutorial for ~15 identical windows is very worth it** ("you actually spent like 30 seconds a window").

---

## 11. Concrete domain facts the app must respect

- **Warranty:** *"every single installation has to have at least a 1-year warranty."* This is the reason tracking must be per-unit and precise — so you can return later if that window/door has an issue, trace the fail point, and assign accountability.
- **Vinyl vs aluminum (temperature-driven):** *"Vinyl does worse in high heat, and aluminum does much better"* — specifically relevant in **St. George** (hot climate). This *"should be kept in mind when we have installers installing."* Aluminum standard color = **black**; vinyl often **white.**
- **Product families:** sliding doors (4-panel / 6-panel; all-open, 2 stationary each side, or 1 stationary each side open-from-middle), **bifolds**, **stationary doors/windows**; some glass **can change transparency** (complex, three-man/day units). Mostly **exterior**; rarely interior.
- **Drains:** every window has a **drain on the frame**; the drain side is the outside. Manufacturers add drainage holes on all sides; company standard is to **caulk top and side holes, leave bottom drains** (one front drain + two bottom-side mini-drains).
- **Inset vs outset:** determines install direction (inside-out vs outside-in).
- **Flashing:** **paper flashing vs sticky flashing** is a real per-job choice currently gated behind the crew lead. Sequence: sides (and optionally bottom) before install, **top flashing last, over the flange lip.**
- **Caulk:** flanges (left/right/top, not bottom) for watertight seal; interior base + 6" up the sides; **exterior finish caulking is permanent and cosmetic** (tape off ~¾" gap, caulk, tool) — quality varies by installer and must be photographed.
- **Set screws & shims:** shim to level, set-screw the flanges, then remove shims.
- **Stucco vs rock exterior:** changes **how far you set the window out** — **~1 inch (rock) vs ~1.5 inches (stucco)** per Ammon's example. Must be decided **before** sending the crew; unknown = **non-starter** the supervisor flags to the contractor.
- **Out-of-level walls / bumpy concrete / high flooring / unplanned contractor changes:** common **case-specific** complications that warrant their own memos. Real example: a flanged door on a wall **1.5"–2.5" out of level** (measured with a laser).
- **Plan-set numbering (from T2):** you download **at least two plan sets per project** — the **building plan set** (numbers around the building on each story marking each window's location) and the **specs plan set** (the description for each numbered window). You **correlate** number-N on the building plan to number-N in the specs. Example: **#6 = 6' tall × 4' wide stationary window.**
- **Identical units share a number:** if there are **30 identical #6 windows**, all 30 are labeled "#6" around the building and share **one spec-sheet entry.** Sometimes after a run of #6s they **switch to #14** (or #17) for **shipping/order reasons** even though the window is **identical** — and you can **cross-reference** in the specs: *"Number 14s, number 17s, and number 6s are all the exact same window."* The app/AI must recognize these as the same product.
- **Suction-cup machine specs (safety/equipment):** the company runs **$30,000–$50,000 suction-cup machines** on **"POS treads,"** each able to **hold up to 3,000 lbs of window** while **weighing ~9,000 lbs** itself. The company has **two** of these machines.
- **Heavy material drops:** windows come in **crates with metal frames** holding large glass panels, **tightly bound**; unloading needs **forklifts, straps, chains** — a serious safety/liability area.

---

## 12. Safety, equipment/machinery tracking, and toolbox talks

### 12a. Safety (T1)

Ammon flagged safety as an unaddressed gap: *"we need to emphasize aggressively with our crew safety procedure."* Material drops involve very heavy, tightly-bound crates requiring forklifts/straps/chains; *"you cannot have guys getting in between these drop-offs"* — a life-safety and liability concern. Taylor: *"Safety is a top priority... You don't want a recurring safety issue."*

Proposed: **training videos** covering how to use a forklift, how to strap a panel/pallet safely, **what chains/straps you need and their ratings, who to get them from**, how to transfer, **which flatbed to use, where flatbeds are parked**, and how to know a flatbed will actually be available when you need it.

### 12b. Equipment / machinery section with IDs

That last logistics problem (flatbed availability) led to an **Equipment section** (Taylor: "An equipment section"; Ammon: "For very high-value tools and... machinery"). Ideas:

- **Assign IDs to trailers/flatbeds** — scan the trailer ID: "I'm using it for this job."
- **Track the two suction-cup machines by ID**, and track by ID the windows that **require** the machine, so you can **schedule around scarce machines.** Ammon's scenario: **3 jobs need the machine, only 2 machines** — one crew works its **non-elevated / non-large windows** without the machine; whoever is closest to finishing says *"I'm only going to work on my windows that require this machine so I can unlock it for the next crew without holding them up."* Foremen/supervisors build these schedules from the ID data.
- **Scaling question (open):** with 2 machines today, *"At what point do we need a third or a fourth? How many guys can reasonably work around this equipment?"*

### 12c. Toolbox talks (T2)

Ammon: "We want to add toolbox talks." Requirements Taylor gave:

- **Do NOT AI-generate them.** *"Use actual real certified toolbox talks"* — heavy-equipment safety, heavy-lifting safety, OSHA safety, anything relevant to installing windows/doors.
- **Assigned immediately after clock-in:** you clock in → must **complete the toolbox talk** → **acknowledge** (check "I'll abide by it") → **sign your name and endorse it.**
- **Record-keeping:** the app keeps a **full catalog of completed toolbox talks** — not just *that* each person did them, but a **saved PDF of the actual toolbox talk with their signature and date.**
- Taylor: *"that should be a pretty easy function to abide by."*

---

## 13. The map + per-unit ID model (Transcript #2, the big refinement)

Transcript #2 opened with Taylor's strong meta-instruction (see §14) and then Ammon raising the feature he was "really excited about": **the map.**

### 13a. What the map is

Taylor: *"a badass feature... an interface within the app, for installer, for everyone to see. It's basically just a map — a 2D or 3D rendering of a specific job that replicates the plan set (the PDF or the CAD) and shows the windows in the rendering, or the doors."*

### 13b. The ID-assignment debate (who/how places IDs on the map)

Taylor's concern: with **30 identical 6×4 windows** each having a unique ID but all living under one category, **should AI randomly scatter the 30 IDs onto the map, or should the foreman place them?** He worried AI might "get confused on creating something else entirely when exporting from the plan set," and suggested AI should just **create an opening/slot** ("This is the type of window from our catalog"), show the map, and let a human **assign the ID to it.**

### 13c. The key philosophical resolution: **ID for tracking, map for location**

This is the central refinement of T2 (and a change of emphasis from T1). Ammon initially proposed **not** giving every window a unique ID — instead **ID by window type with a quantity**, or **ID a "unique ID group"** per shipment/project move (e.g., 30 come in, 15 go to a location = a logged group with 15 remaining). Taylor identified the fatal flaw:

> Taylor: "The issue with that is that each window is not tracked down to the install. You can't track a specific window to its install." — Ammon: "That's true."

The resolution both landed on:

- **Every window gets its own unique ID, but they're all categorized under the window type.** The **unique ID is NOT for location** — *"The unique ID per window is only to track it down to everything that happens to that specific window. That's the only importance it has."*
- **Location comes from the MAP, not the ID.** You don't hunt through a Connex container guessing which identical window is which. Taylor: *"If I want to see how this window was installed, I go on the map and I click that window or door, and it pulls me up the info on it... I know exactly where this window is on the map."*
- Ammon agreed the map should **"funnel you into every single piece of information for that door."**

### 13d. The dual-role of the ID (assignment at install time)

Ammon realized the ID can **"dual-will"**: the map doesn't care about install order, but **once you install a unit, the ID is set to that slot.** Then clicking the map slot shows *"This was that window. This was the ID... Here's what happened to the window. Here's all the data correlated to it."*

The agreed installer flow (this **refines T1's "windows pre-scheduled" model**):

- You **don't care about the ID up front.** You're **assigned to a window slot** on the map: *"I am assigned to this window slot for this window."*
- Grab a matching window, take it to the location, and at the slot select **"Start install"** → app says **"Scan QR code"** (or enter PIN) → **that ID now claims that spot.** (Ammon: "Takes that spot" / "Claims that spot.")

### 13e. QR vs 6-digit PIN — the hybrid (a change from T1's QR-only)

In T1 the ID mechanism was casually "QR code, whatever." T2 debated the actual mechanism and landed on a **hybrid**:

- Taylor floated **not** wasting time printing QR codes: an ID could be a **6-digit PIN**, or **2 letters + 2 numbers** — *"something unique that you can just write with a marker."*
- Both acknowledged **QR's advantage:** it guarantees uniqueness and is nice to scan ("you don't have to write a different code every time"), with the caveat *"if the QR code isn't too long."*
- **Resolution — generate both:** *"you could also tell it to generate you a unique 6-digit code where you have the serial number ID that the QR code is, but also a 6-digit code that matches"* — so you can **scan the QR or hand-write/type the matching 6-digit code.** Ammon: this could be part of the printed sheet — but they clarified: **data sheets are for installation purposes, not ID purposes** (the ID code is separate from the install instruction sheet).

### 13f. Undo / reclaim a slot + failed-install tracking

- You should be able to **reclaim/undo a spot** — Ammon: *"if a window got installed wrong, or in the wrong location for any reason, you should be able to have an undo option."*
- Taylor: **delete/undo installation, but still save the install data** *"so that we know there was an error."*
- A **supervisor/foreman-only view** for **uninstalled windows, failed installations, etc.** — *"that data is very valuable."* Ammon: *"Happens all of the time."* Goal: *"Catch issues way ahead of issues happening."*

---

## 14. Meta-instructions to the AI (recurring, explicit)

Both speakers repeatedly told the AI how to behave. These are firm standing instructions:

- **"Cut the fat."** Ammon: *"through all these ideas, cut the fat. So if there's any idea... 'Hey, is this truly necessary?' Let's bring it up and say, 'Why?' or, 'Why is it not necessary?'"*
- **Add and challenge.** Ammon: *"I want AI to also add things from this conversation and say, 'Hey, you considered this, but have you considered this effect?'"*
- **Assume nothing; ask lots of questions.** Taylor (T2 open): *"assume nothing. Ask me as many questions as you need. Never assume that I want one thing over another thing."*
- **Don't treat their ideas as gospel.** Taylor: *"we may have retarded stupid ideas. Don't take all of our ideas as the gospel. Like, we are not smart people. We are just having ideas. And if there are better ideas correlating to things that we've talked about, express them to us."*
- **Learn from the best-in-class.** Taylor: *"there are window insulation companies out there that are dominating... we don't even install windows. We're just trying to create a system with you to make this window insulation company way better."*
- **Audit and 1000× it.** Taylor (T2 open): *"take this entire transcript, audit it against everything we've created, and make it a thousand times better. Literally a thousand times better."*
- **Recommend role separation.** Ammon (T2): explicitly asks the AI to *"give recommendations for how to separate these roles and have them each be user-friendly to their particular role."*
- **Guiding product principle.** Taylor: *"the goal is to not have an app that offers 1,000 different features, but to have an app that truly helps a company operate better. Saves a company money."* How? Installers doing work faster/better, more time working, less time not working — *"Less time thinking, more time installing."*

---

## 15. Firm decisions

1. The app serves the **installation & servicing** arm of the (splitting) business.
2. Build a **full product catalog** of every window/door type the sales team offers.
3. **Per-unit unique IDs** for every window/door (**not** type-with-quantity), created **from the plan set before delivery**, physically assigned on arrival; **missing/unassigned IDs = missing delivery** alert. *(Confirmed in both transcripts; T2 explicitly rejected the type-only/quantity-group model because it breaks per-unit install traceability.)*
4. The **unique ID is for tracking a unit's full life; the MAP is for location.** You find/inspect a window via the map, not by hunting the ID.
5. **ID mechanism = hybrid:** QR code **plus** a matching short human-writable code (6-digit PIN, or 2 letters + 2 numbers). Scan QR or enter/write the code.
6. **Movement tracking**: multi-select IDs at warehouse checkout ("load it"), confirm on drop-off ("unload it / at location") with a damage/condition flag.
7. **Warehouse is an umbrella** covering multiple locations/containers; IDing a unit reveals its location.
8. **First workflow step = upload the PDF plan set / CAD**; app auto-creates window slots/IDs. Company always pulls **≥2 plan sets** (building + specs) and cross-references identical units that share/change numbers.
9. **Roles = installer → foreman → supervisor → owner**, with graduated data access (owner: everything; installer: least). Start-size: ~1 supervisor, 2–4 foremen, installers under them.
10. **Blocker-chain operating model**: each layer removes pain points from the layer below; uncontrollables escalate up; supervisor can flag **non-starters** (e.g., undecided stucco-vs-rock).
11. **Installer view = my tasks/windows for today (and tomorrow/week), pre-assigned**; task = Start → install → data/voice memo/photos → End; near-zero-friction **"spam-through"** button flow (<5 sec to next task).
12. **Auto-timers**; **three tracked states — on task, off task (prep), break**; prep counts toward install time; clock-in happens via starting a task on site.
13. **Supervisor "heartbeat" view**: one-click, ~10-second full project progress + live issues.
14. **Points system for installers** (fuels bonus), **difficulty rating for windows**, both seeded initially by the crew lead and then learned by AI; batch-time easy identical units, granularly time complex units; **grace period** for out-of-scope problems (e.g., damaged units).
15. **Voice memos**: A-to-Z, feed an **AI brain**; collect **per window/door** but allow **multiple memos per install**; keep them **hyper-detailed** until a **cap (~20, up to 30–40 for common simple units)**, then retire the requirement until the product/process changes.
16. **Photos required per install**: flashing, level, inset/outset, drain, caulk/cosmetic finish, accidents, preliminary damage.
17. **Damaged unit** → skip task / start next; task upgrades into an **issue**. **Issues list** (foreman/supervisor only) with tiered flagging (to-do → issue → urgent → flagged/emergency; !!! outranks !, chronological within tier).
18. **Undo/reclaim install slot** but retain the data; **supervisor/foreman-only failed/uninstalled list.**
19. **Equipment section** with IDs for high-value tools/machinery (trailers/flatbeds, the two suction-cup machines) to enable **scheduling around scarce equipment.**
20. **Toolbox talks**: **real certified** (not AI-generated), assigned right after clock-in, require acknowledge + signature, stored as a **signed, dated PDF catalog.**
21. **Install and Warehouse are the two main halves** — interlinked but distinct.
22. **Product principle**: focused app that saves money via faster/better installs and clear roles — **not** a 1,000-feature app.

---

## 16. Open questions / unresolved items

- **Who owns daily scheduling** of windows to installers — foreman, supervisor, or office? (Leaning foreman/supervisor via "max out the supervisor first," but not finalized.)
- **Who places IDs onto the map** — AI auto-places, or a human (foreman) assigns each slot? (Taylor leaned toward AI creating slots + human assigning.)
- **Exact memo cap** per window type (20 vs 30 vs 40) and the precise trigger to retire a memo requirement.
- **The "Bob"/gold-standard expert model** — feasible given it would consume an expert's time for a long stretch; likely a **hybrid** (golden memos + pre-recorded common exceptions + flagged novel issues), but not settled.
- **Equipment scaling** — at what crew count do you need a 3rd/4th suction-cup machine; how many people can safely work around one.
- **Should difficulty analysis be biased toward harder doors** — Ammon's "try to think harder about this" is an open refinement.
- **How much (if at all) to fold time-tracking and project-management into a single function** — synergistic, but they chose *not* to fully merge for now.
- **Exact issue-priority taxonomy** (to-do / issue / urgent / flagged / emergency) — directionally agreed, not finalized.
- General: many "holes in our thinking" were explicitly invited but not yet enumerated — Taylor twice said he was "trying to think of holes in our thinking."

---

## 17. Action items for the AI

1. **Audit both transcripts against everything already created and make the plan "a thousand times better."**
2. **"Cut the fat"** — for each idea, judge necessity and say **why / why not**; propose better alternatives, including from best-in-class window-installation companies.
3. **Ask clarifying questions liberally**; assume nothing; don't treat their ideas as gospel.
4. **Add missing considerations** — surface second-order effects ("you considered this, but have you considered…").
5. **Recommend the role/permission separation** (installer/foreman/supervisor/owner) and make each role's UI user-friendly to that role.
6. Design the **plan-set upload → auto-slot/ID pipeline**, the **map interface**, the **hybrid QR+code ID**, the **spam-through install/logging flow**, the **three-state auto time-tracking**, the **points + difficulty systems**, the **AI-brain voice-memo pipeline (with cap + novel-issue flagging)**, the **photo requirements**, the **issues/failed-install lists**, the **equipment/ID scheduling**, and the **certified toolbox-talk flow with signed PDF records**.
7. Keep the app **focused** (operate better / save money), not feature-bloated.

---

## 18. Where Transcript #2 overlaps, refines, or changes Transcript #1

- **Overlap / agreement:** per-unit tracking, plan-set-first workflow, role-based access (T2 formalizes the ladder and adds **owner**), pre-assigned installer tasks, capturing full install data, warranty/traceability motivation.
- **Refinement — ID purpose:** T1 treated the per-window ID as *both* location and tracking; **T2 explicitly splits them** — **ID = tracking a unit's whole life; MAP = location.** You inspect via the map, not by hunting the ID.
- **Change — ID mechanism:** T1 said "QR code, whatever" (QR-leaning). **T2 debated QR-only vs a hand-writable code and landed on a hybrid** (QR + a matching 6-digit / 2-letter-2-number code).
- **New in T2:** the **map feature** itself (2D/3D rendering replicating the plan set), the **plan-set structure detail** (building plan set vs specs plan set; identical units sharing/changing numbers), **install-time ID claiming of a map slot**, **undo/reclaim + failed-install list**, and **toolbox talks** (certified, post-clock-in, signed-PDF records).
- **Rejected in T2:** the **type-only "unique ID group / quantity"** model — because it can't trace a specific window down to its install.
- **Consistent meta-instructions across both:** cut the fat, challenge our ideas, ask questions, don't assume, and build something that genuinely makes the company better rather than feature-rich.
