# 12 — Photo markup and no-login share links

Status: needs-triage
Type: task
Size: M

Isaac decides first. The report's reasons: window damage disputes get settled
with a circled photo; handing a builder one set of photos today needs a login
or leaves the app. Share links fit the one-app principle (nothing leaves, the
outsider comes to it).

## Horizon does

- `components/photos/PhotoMarkupEditor.tsx` + `lib/photoMarkup.ts`: arrow,
  circle, freehand, text in three colors; coordinates stored in image-natural
  pixels; saved as a NEW photo linked via `photos.annotated_of`, the original
  is never overwritten.
- `lib/photoShareLinks.ts` + route `/share/$token`: a link scoped to explicit
  photo ids, a stage, or an album; 24-char base64url token (short enough for
  SMS); `expires_at`, `revoked_at`; read-only gallery, no auth; managers and
  crew leaders can create.

## Forge today

Photos have kinds, a 30-day trash with nightly sweep (`lib/photos.ts`),
in-place capture on every screen (#539), upload picker (#540). The GC portal
(`gc_links`, `/gc/:token`) already proves the tokenised-outsider pattern for a
whole job. No markup; no per-photo-set link.

## Build (if yes)

1. Markup: a canvas sheet opened from the photo viewer, four tools, save as a
   new `photos` row with `annotated_of` (migration adds the column), original
   untouched. Works offline through the photo outbox.
2. Share links: table `photo_share_links` (token, project, scope json, expiry,
   revoked, created_by), an RLS-free read via a SECURITY DEFINER RPC keyed by
   token (same shape as the GC link), a public route `/p/:token` that renders
   the gallery with no chrome. Foreman+ create/revoke from the photo grid's
   multi-select. Copy link + "Send" via the OS share sheet.
3. Both in both languages. e2e on the fixture harness for each.

## Done when

- Circling a frame produces a second photo beside the original in the job's
  gallery, and the original is byte-identical.
- A revoked link shows "This link was turned off" and nothing else.
