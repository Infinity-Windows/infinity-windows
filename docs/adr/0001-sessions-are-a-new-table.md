# Sessions are a new purpose-built table; task_sessions is retired

The app already has `task_sessions` (one on/off/break interval row per person, written by the install and break RPCs) — but nothing has ever read it, and the number everyone sees is `install_events.minutes`, a single client-computed wall-clock figure from one `work_started_at` stamp. We decided (owner, 2026-08-16) to build the Session atom as a **new table with RPC-only writes** rather than retrofit `task_sessions`: a never-load-bearing logging table is a worse foundation than a clean atom with real constraints, and the migration cost is near zero precisely because nothing consumes it. `install_events` remains the finish record (photos, grade, QC); its minutes become derived from sessions instead of client-sent.

## Considered options

- Retrofit `task_sessions` in place — rejected: no constraints, no consumers to preserve, and its per-person (not per-unit) shape fights the Session definition.
- Keep `install_events.minutes` as the source of truth — rejected: a stored aggregate destroys labor-minutes vs wall-clock; CONTEXT.md's "sessions are the stored atom" exists to prevent exactly this.
