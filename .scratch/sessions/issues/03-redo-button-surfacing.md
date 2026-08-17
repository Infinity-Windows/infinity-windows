# 03 — Redo button + surfacing

Status: ready-for-agent
Type: task
Blocked by: 01

Redo on installed windows (any installer, reason sheet required) → `press_redo` + foreman push (existing sendPush rails, tag `redo-{opening}`); window returns to My Work / Dispatch / map wearing a redo badge (map: assigned/waiting glow + badge; list rows: "redo" chip); sessions during the open redo auto-tag `is_rework` (server-side, ticket 01); the next `finish_unit` resolves the redo. Un-submit stays untouched and separate. Blocked-unit strip on Dispatch (derived from last session `end_reason='block'`) with reason + issue link.

## Comments
