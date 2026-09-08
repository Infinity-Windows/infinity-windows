# Auto, Phone and Desktop layouts

Status: ready-for-agent
Blocked by: None; refresh shared-shell ownership

## Scope

Implement a per-browser/device display preference with Auto as default, honoring viewport changes in Auto. Use one state/data layer and preserve unsaved editor context across switches. Wire meaningful phone and desktop layouts into the shell and operational pages; do not ship a setting that changes no layout.

## Acceptance

Reload persists an explicit choice; blocked storage still permits current-session changes; switching preserves role and data; return to Auto remains reachable on an iPhone; all main operations have touch alternatives.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.
