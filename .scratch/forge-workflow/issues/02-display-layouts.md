# Auto, Phone and Desktop layouts

Status: implemented; draft review and physical iPhone verification pending
Blocked by: None; based on master 6ecbb59, preserving #586/#590

## Scope

Implement a per-browser/device display preference with Auto as default, honoring viewport changes in Auto. Use one state/data layer and preserve unsaved editor context across switches. Wire meaningful phone and desktop layouts into the shell and operational pages; do not ship a setting that changes no layout.

## Acceptance

Reload persists an explicit choice; blocked storage still permits current-session changes; switching preserves role and data; return to Auto remains reachable on an iPhone; all main operations have touch alternatives.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

## Implemented

Auto/Phone/Desktop preference in Settings and Scheduling; phone shell on laptop, day agenda by default on phones, desktop board by default, preserved editor state, 44px agenda/view controls and full-height phone editor. Small screens keep reachable navigation in Desktop mode. Specialized app screens keep their existing responsive components. Browser checks cover persistence, resize, blocked storage, unsaved drafts, role scope, long job names and date filtering. Actual iPhone Safari verification remains outstanding.
