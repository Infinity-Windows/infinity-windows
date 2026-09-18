# Time off, lunch reminders and weak-signal clock investigation

Owner request September 18, 2026: all crew can report sick days and request vacation/other days off using a date range. Sick takes effect immediately; vacation/other days require supervisor approval. Count days only; payroll unchanged. Send a reminder after 30 minutes of lunch. Investigate reports of a missing morning when returning from lunch in poor signal.

## Delivered behavior

Home has Sick today and Add time off. My Schedule adds inclusive date ranges, English/Spanish, status/history and month/year/all-time counters. Calendar days include weekends, explicitly stated before submission. Only approved/recorded days through today count as taken; future approved days are separate, pending/declined/canceled days do not count. Overlapping active requests are refused atomically. Each request has a retry key.

Supervisor/owner review is under Scheduling, with an immediate view of people out today and pending requests. Crew board cells, the agenda and week crew counts, and personal published schedules exclude the person on approved absent days. Original assignment blocks stay intact for editing/history, and canceling restores their availability. Other roles can read schedule availability but cannot approve leave. Partners cannot read or submit any time off. Counts and notices follow account deletion through cascade references.

Notices go to active supervisors assigned to jobs in the affected range, using Forge's existing job-supervisor mapping. If none is assigned they go to all active supervisors, with owners as fallback. Notifications are saved with the request, visible in Notifications, and queued for push delivery. A one-minute sweep delivers both time-off notices and one reminder per lunch break, with leases/retries; reminder delivery does not edit time or end breaks. The foreground banner also covers an unsynced local lunch while the app remains open. Phone alerts need notification permission; on iPhone Forge must be added to the Home Screen. No locked phone can be notified by the server about a lunch it has not yet received while offline. Physical iPhone push delivery remains a device-level validation item.

## Investigation findings (no payroll repair applied)

1. ClockSheet creates an optimistic `pending:<id>` shift when a clock-in queues, but its `setOptimisticShift` immediately calls the parent's `onChanged`, which invalidates `openShift`. ClockProvider also polls every 60 seconds and on window focus. `getOpenShift` reads only server rows and never reconciles pending clock entries. A reachable read after a failed write can therefore replace the local morning with null/older server state.
2. Break start/end attempt a server RPC with the shift ID first. A pending synthetic shift ID is not a UUID. With connectivity restored enough to get a server response, this can be a validation error instead of the network error that triggers queueing.
3. Outbox clock handlers send no captured timestamp. The latest `clock_in` client-ID overload inserts a shift using the table's `now()` default; `start_break` and `end_break` also stamp server time. A morning queued at 7 AM and first delivered at noon is therefore recorded from noon. Replay is idempotent for clock-in, but that does not preserve the original event time.

These are app-side risks that fit the report; they do not prove which path a particular employee hit. An employee/date example has been requested for read-only comparison. No historical punches have been edited and no claim is made that the offline payroll path is repaired by this release. A payroll fix needs captured event timestamps, durable per-user clock state, ordered/idempotent break replay, and role/overlap/toolbox regression tests. Keep that work separate from days-away records and do not infer missing hours without evidence.

Reference: Apple/WebKit documents Home Screen installation and notification permission for iPhone web push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
