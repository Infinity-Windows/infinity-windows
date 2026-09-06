# 11 — Notification center with per-type preferences

Status: needs-triage
Type: task
Size: M

Isaac decides first: does he want installers to be able to turn categories of
pings off? The report's reason to say yes is the "first-morning chip storm"
concern already in the program notes.

## Horizon does

Table `notifications` (user, type, title, body, url, read) with indexes on
unread; a bell with an unread count fed by realtime; `notification_preferences`
per user: chat (all / mentions only / my jobs only), urgent tasks, assigned
todos, clock reminders, daily-log reminders, site departure, materials,
blocker alerts, schedule updates, ops briefing (off by default), push on/off,
timezone. `NotificationSettings.tsx` is a list of switches with one-line
descriptions; iOS install guidance when push is unavailable.

## Forge today

`push_subscriptions`, `notification_dismissals`, `SummonBell.tsx`,
`lib/permissions/` (push + local), an onboarding wizard for permissions.
Sends: summons, 5-minute warnings, still-on-the-job, chat, daily-log nudges,
credential nudges, pipeline nudges. No record a supervisor can read to answer
"did he get it?", and no per-type opt-out.

## Build (if yes)

1. Migration: `notifications` (RLS: own rows only; insert via RPC/edge only)
   and `notification_preferences` (own row). Register both in the merge tooling
   and the sandbox fence (the fence test will demand it).
2. `send-push` writes a `notifications` row for every push it sends, and
   respects preferences before sending (mentions-only, quiet categories).
3. Bell in `Layout.tsx` next to `SummonBell` (or fold Summon into it), unread
   count, list, mark read on tap, deep link.
4. Settings screen under the existing permissions settings, both languages,
   categories named the Forge way (Summons, Job chat, Clock, Daily log,
   Schedule, Credentials, Pipeline).
5. Tests for the preference gate (pure), e2e on the fixture harness for the
   bell.

## Done when

- A summon still arrives with everything off (summons are never optional —
  write that in the settings copy).
- A chat message with the installer not named does not push when "mentions
  only" is on, and still appears in the bell list.
