# Continuous trip sheet

Status: implemented; awaiting review
Blocked by: None

## Scope

Replace six mutually exclusive tabs with one sheet and wrapping anchor links. Retain all existing fields, editors, crew/flight privacy, code-expiry logic and translations. Move the existing trip-only publish action below reviewable details without claiming schedule publication.

## Acceptance

All sections are readable in one scroll; jump links work by touch/keyboard; crew cannot access a draft; personal flights remain scoped; lodging fields survive opening/canceling their editor; browser checks pass on phone and computer.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

PR #591 contains the implementation. Nine fixture browser checks passed on the first run; unit/component coverage passes. Keep draft pending final validation and owner review. No merge/deploy authorization.
