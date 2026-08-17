# 02 — Record UI on OpeningSheet + flashing photo + QC link

Status: resolved

- Record section under the Installed card (also shows when a not-installed
  opening carries history — sent-back/redo state).
- Rounds: label, installer, grade, filled memo topics, media (img/video/audio),
  "AI noticed" findings, transcript fold.
- Timeline list from buildTimeline.
- Flashing photo rendered via signedPhasePhoto.
- Qc.tsx rows link to the opening's sheet.
- All roles see it (spec decision 2).

Comment (2026-08-17): built as specced; media lazy-loads only when the Record
section is expanded (signed URLs are 1h, no need to sign for every sheet view).
