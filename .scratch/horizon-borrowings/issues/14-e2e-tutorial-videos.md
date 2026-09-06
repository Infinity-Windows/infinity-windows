# 14 — Tutorial videos rendered by the e2e suite

Status: ready-for-agent
Blocked by: 02
Type: task
Size: L

## Horizon does

`e2e/tutorials/*.spec.ts` drive the real app with an overlay fixture
(`tutorialOverlay.ts`: highlight target, captions, step pauses) under a
dedicated Playwright project at 1920×1080 with video on.
`scripts/render-tutorial-video.mjs` burns captions to MP4,
`prepare-tutorial-audio.mjs` adds narration, `publish-tutorial-to-horizon.mjs`
uploads to a `tutorials` bucket and a `tutorial_videos` row, and
`tutorial-video.yml` / `tutorial-publish.yml` run it. A `/tutorials` page groups
videos by audience. `docs/friendly-tutorial-style.md` and
`docs/text-tutorial-style.md` set the voice.

## Forge today

`learning_videos` (upload or YouTube, dual transcripts, quizzes), the
`generate-howto` edge function, and 59 fixture-backed e2e specs on a phone
viewport. At ~10 PRs a day a recorded walkthrough is stale within a week.

## Build

1. A `tutorial` Playwright project (phone viewport, video on, slower actions)
   and an overlay fixture that highlights the tapped control and shows a
   caption per step, in the current language.
2. Five first tutorials as specs: clock in, save a job for offline (after 05),
   install an opening (check → install → capture), scan a package into a bay,
   send a summon.
3. `scripts/render-tutorial.mjs`: video → MP4 with burned captions (ffmpeg),
   both languages from the same spec by switching the i18n language.
4. Publish: upload to the learning-videos bucket and insert a `learning_videos`
   row tagged `tutorial`, replacing the previous render of the same key.
   Run from a `workflow_dispatch` workflow; later on a schedule after merges
   that touch the flows.
5. Style doc `docs/tutorial-style.md` in the repo's voice.

## Done when

- One command re-renders all five in both languages and the Learn tab shows
  the new versions.
- A spec that fails stops the publish (no half-updated set).
