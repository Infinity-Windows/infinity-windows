# VoiceNotes Summary — Transcript #2 (Taylor + Ammon, 2026-07-17)

> Source: VoiceNotes-generated summary of the second conversation ("Window/door installer app map with per-unit IDs, QR/PIN, toolbox talks and role access"). Provided by Taylor as a reference/benchmark for depth. Companion to the raw transcript at `docs/transcripts/2026-07-17-window-door-installer-app-map.md`.

## Overview
Discussed a job-map feature that ties plan sets/specs to a clickable 2D/3D window/door layout, enabling installers to "claim" a location during install and link it to a unique ID (QR/PIN) for traceability. Also defined workflow needs around undo/failed installs visibility, safety compliance via signed toolbox talks on clock-in, and role-based access control across installer/foreman/supervisor/owner logins.

## Product Direction & Principles
- Speaker 1 (Taylor) requested a full audit and improvement pass: assume nothing, ask clarifying questions as needed, and propose better alternatives (treat current ideas as provisional).
- Primary product aim: improve field execution and traceability for a window/door installation operation (even if the team does not install windows themselves).

## Job Map Feature (Plan Set -> Field Interface)
- **The map**
  - In-app interface for installers and others: a 2D or 3D rendering of a specific job that replicates the plan set (PDF/CAD) and shows windows/doors in context.
  - Clicking a window/door on the map should funnel the user into all information for that specific opening (install data, history, etc.).

## Plan Sets & Specs Correlation (How Data Gets Onto the Map)
- Typical inputs include at least two plan sets:
  - Building plan set: shows numbered windows/doors around the building (often per story) indicating locations.
  - Specs plan set: contains the attributes tied to the numbers (type, dimensions, operation, etc.).
- One spec entry can map to many physical instances:
  - Example: "#6" could appear 30 times on the building plan; all share the same spec description.
  - Sometimes identical units may be renumbered (e.g., #6, #14, #17) due to ordering/shipping differences while remaining the same spec; app should support recognizing and cross-referencing these equivalences.

## ID Strategy & Installation Flow (Map Slot vs Physical Unit)
- Core tension discussed: whether each physical window needs a unique ID and when/how to bind it to a specific map location.

### Unique IDs: Purpose and Practicality
- Speaker 1 (Taylor) position:
  - Unique ID per physical window is only needed to track everything that happens to that specific unit from delivery through install (not to help someone find the unit in a container).
  - Day-to-day selection should be by window type/slot rather than searching for a particular serialized unit.
- Speaker 2 (Ammon) concern:
  - If every identical unit has a unique ID upfront, the app could unintentionally imply installers must locate that exact unit in storage to match a map location.
- Working convergence:
  - The map does not need to pre-care which specific unique ID goes into which slot.
  - The unique ID gets bound to the map location at install time; once installed, clicking that map location surfaces the bound ID and its full history.

### ID Capture Mechanisms (QR vs Short Code)
- Options discussed:
  - Scan a QR code to bind the unit to the selected map slot.
  - Use a short manual identifier (e.g., 6-digit PIN or alphanumeric like "2 letters and 2 numbers") written on the unit with marker to avoid printing QR labels.
  - Hybrid: generate a QR plus a matching short code (serial/ID + human-enterable code), enabling either scan or manual entry.

## Installer Workflow (Happy Path)
- Installer arrives onsite, opens the app, sees expected windows to install.
- Installer selects a window/door "slot" (map section) and starts install.
- App prompts for QR scan or PIN entry to bind a specific unit ID to that slot ("claim that spot").
- Installer proceeds through the installation process steps (details not fully enumerated in transcript).

## Error Handling / Rework
- Need ability to undo/delete an installation assignment if installed wrong or in the wrong location.
- Even if undone, the system should retain the installation attempt data for learning/accountability.
- Proposal: supervisor/foreman-only views for exceptions such as uninstalled windows, failed installations, and rework history.
- Goal stated: catch issues earlier so errors happen "none of the time" (or as close as possible), acknowledging failures occur frequently today.

## Safety Compliance Workflow
- **Toolbox talks**
  - Add safety toolbox talks to the app.
  - Use real, certified content (not AI-generated), covering relevant topics (heavy equipment, heavy lifting, OSHA, window/door installation safety).
  - Required flow:
    - Assigned immediately after clock-in.
    - Worker must complete it, acknowledge compliance via checkbox, and sign/endorse.
    - App retains a record/catalog showing completion by person and stores a PDF of the exact toolbox talk including signature and date.

## Access Control & Role-Based UX
- **Wide variety of logins**
  - Distinct logins/roles with different access levels:
    - Installer: limited scope (field execution and assigned tasks).
    - Foreman: broader visibility/control.
    - Supervisor: most visibility/control.
    - Owner: full access to everything.
  - Request for recommendations on how to separate permissions and tailor UI to each role; more context to be defined later.

## Action items
- Define role-based access boundaries and UI differences across installer/foreman/supervisor/owner (requested recommendations; specifics to be continued).
- Decide ID-binding approach at install time (QR vs short code vs hybrid) and how IDs are generated/managed in the system.
- Specify the undo/delete installation behavior and the supervisor/foreman-only exception views (uninstalled/failed installs) while preserving attempt history.
- Identify and source the certified toolbox talk content library and confirm the clock-in -> toolbox talk -> acknowledgement/signature -> PDF retention workflow requirements.
