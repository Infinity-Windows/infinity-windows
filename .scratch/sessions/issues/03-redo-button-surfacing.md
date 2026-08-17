# 03 — Redo button + surfacing

Status: resolved
Type: task
Blocked by: 01

Redo on installed windows (any installer, reason sheet required) → `press_redo` + foreman push (existing sendPush rails, tag `redo-{opening}`); window returns to My Work / Dispatch / map wearing a redo badge (map: assigned/waiting glow + badge; list rows: "redo" chip); sessions during the open redo auto-tag `is_rework` (server-side, ticket 01); the next `finish_unit` resolves the redo. Un-submit stays untouched and separate. Blocked-unit strip on Dispatch (derived from last session `end_reason='block'`) with reason + issue link.

## Comments

2026-08-17 — Built. Redo card on installed windows for ANY installer (undo stays foreman-gated beside it — two truths, two buttons): reason sheet → `press_redo` → best-effort push to every active foreman+ (`redo-{opening}` tag, deep link). Dispatch gains `SessionStrips`: 🚫 blocked units derived live from sessions (`blockedUnits`, nothing stored) with reasons, and 🔁 open redos with presser + reason. Map/list surfacing rides the status flip `press_redo` already does server-side (back to assigned/planned = waiting glow + reappears in My Work); a dedicated badge can come with field feedback. Rework tagging was already server-side (ticket 01's `_has_open_redo` at session insert).
