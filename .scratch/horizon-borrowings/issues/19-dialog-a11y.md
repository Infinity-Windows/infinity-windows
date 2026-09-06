# 19 — Dialog focus trap and aria-modal

Status: ready-for-agent
Type: task
Size: S

## Horizon does

Radix dialog/sheet primitives everywhere: focus moves into the dialog on open,
is trapped while open, returns on close; Escape closes; `aria-modal` and
labelled titles; body scroll locked.

## Forge today

53 hand-rolled `role="dialog"` elements across `app/src`, none with
`aria-modal` or a focus trap (grep on 2026-09-05). Keyboard users on the
office screens (timecards, scheduling, studio) can tab behind an open sheet.

## Build

1. One `useDialogA11y(ref, { onClose })` hook in `components/ui/`: on open,
   remember the opener, focus the first focusable, trap Tab/Shift+Tab inside,
   close on Escape, restore focus on close, set `aria-modal="true"` and lock
   body scroll. ~80 lines, tests with happy-dom.
2. Apply to the shared sheet/confirm components first (`ConfirmDanger`,
   `PhotoCaptureSheet`, the opening-sheet "More" sheet), then sweep the rest
   in one PR.
3. A house-rule check (extend ticket 10): a `role="dialog"` without
   `aria-modal` → fail.

## Done when

- Tab from the last control in a sheet lands on its first control.
- Escape closes every dialog that has a close button; ones that must not close
  (signature pad mid-stroke) opt out explicitly.
