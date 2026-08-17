# Morning hero — the first screen is clock in → your window

Status: settled (grilled 2026-08-17, five decisions + one owner addition)

## Settled decisions

1. **Hero card owns the top of My Work when off the clock**: one big button —
   "Clock in & start on 1-14" — that clocks in AND lands on the window's
   sheet. Today strip facts (job, start time, truck, directions) fold into
   the hero; stats and secondary tasks drop below the do-this-now cards.
   Quieter "just clock in" opens the clock sheet (the full-featured path:
   pickers, toolbox sign-off, offline outbox — also the hero's error
   fallback).
2. **No new scheduled push.** In-app hero + the existing schedule-publish
   push. Every push today is event-triggered; a daily automated push trains
   swipe-away. Revisit with usage data.
3. **Gates stay.** The hero tap starts nothing directly — the sheet walks
   toolbox / before-photo / flashing in order (server enforces them anyway).
   Clock-in is the ungated part; a refused start never un-rings that bell.
4. **The recommendation never points at a session-blocked window.**
   `applySessionBlocks` overlays live block state onto the pure dispatch
   shape; `pickNextOpening` (chain proposal) and My Work's Next card both
   skip them; blocked rows wear their reason in the lists.
5. **The bottom-bar badge counts truly-ready windows** (openingReadiness =
   "ready"), not merely assigned — the "how much can I actually do right
   now" number.
6. **(Owner addition) Flashing alarm on the manager's Home**: when a job has
   windows owed flashing and NO active flash run, a big warn card leads the
   page — "N windows waiting on flashing at JOB — nobody is on a flash run"
   — linking to the job's dispatch board. Pure `flashingAlarm` in phases.ts.

## Out of scope

- Morning scheduled push (revisit with usage data).
- Auto-starting the window from the hero (gates would have to move).
