# 01 — record.ts: queries + pure timeline/rounds builders

Status: resolved

- `listOpeningInstallEvents(openingId)` — all rounds, voided included, with
  memo topics, transcript_raw, photo_findings, grade, minutes, voider name.
- `listInstallMedia(eventIds)` — attachments (photo/video/voice_memo) by
  install_event_id, signed URLs (bucket-prefixed storage_path).
- `listOpeningRedos(openingId)` — all redos incl. resolved.
- `signedPhasePhoto(path)` — raw install-media path (phase photos are not
  bucket-prefixed).
- Pure: `groupRounds(events, media)`; `buildTimeline(sessions, redos, nameOf)`
  → plain-language rows. Tests in record.test.ts.

Comment (2026-08-17): built as specced; timeline covers start/finish/block(+
reason)/break/clock_out/handoff/auto_closed/helper + redo rows; rework sessions
labeled.
