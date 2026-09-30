# Forge AI field upgrade and safe walkthrough — 2026-09-30

## Scope and method

This is a fixture-backed review of the Forge app and the five AI ideas the owner approved. Playwright starts a local development server with an unreachable Supabase fixture host and a synthetic crew account. No production login, job, QC decision, or invoice is used. Source inspection complements the browser checks. The result measures code paths and fixture behavior, not how well an AI model handles real job photos, accents, plans, or a noisy site.

## What the walkthrough found

| Area | Finding | Action |
| --- | --- | --- |
| Field dictation | Description dictation used Whisper without Forge-specific terms. | Switched to `gpt-transcribe` with English/Spanish hints and install vocabulary. A synthetic four-second utterance was transcribed through the live API; real crew audio still needs field evaluation. |
| QC | The queue gave a foreman Pass and Callback controls, but no optional photo second look. | Added an after-photo review that reads one stored photo and returns observations and questions. It cannot write a QC result. When no after photo exists, the screen links to the opening record. |
| Drawing vs opening | The review screen already compares plan marks and spec marks, missing dimensions, missing drawings, size codes vs printed sizes, and rough-opening fit. It creates trackable issues for acknowledged gaps. | Reuse these checks. A second AI discrepancy panel would duplicate them and could create conflicting answers. Keep source drawings and foreman confirmation in the current flow. |
| Live Ask Infinity | Current voice records one memo, saves it, transcribes it, and sends it through Ask. It is a reliable sequential flow, not a continuous spoken conversation. | Built an opt-in GPT-Live pilot. The phone holds a live microphone/speaker session; each delegated business question cuts a recording, saves and transcribes it, and routes it through the existing Ask backend before a spoken answer. The current recorder stays available. The pilot is off by default pending a real signed-in device trial. |
| Training pictures | Generated illustrations could appear immediately, and full talk regeneration could replace edited material. | Added reviewer controls: revise a prompt, regenerate one image, approve for crew, and preserve hand-edited text/approved images. New images remain hidden until reviewed. |
| Permission gap | `safety_talks` allowed any authenticated user to UPDATE the row through the API, despite the foreman-only editor UI. | Added a restrictive foreman+ UPDATE policy and a server-side role check. The policy requires a rolled-back real-database dry run before merge. |

## Checks performed

- 51 pre-existing fixture browser checks passed across usability, dictation, scheduling review, Ask actions/reporting, opening sheets, and offline signing.
- One new fixture browser check passed: AI QC suggestion appears without deciding Pass or Callback.
- 7,185 app tests, 43 function-secret checks, lint, and the Node 22 production build passed on the implementation branch. Lint emitted its existing warnings. The full browser suite and database dry run are separate checks.
- OpenAI synthetic API calls confirmed the transcription request, GPT-6.1 Sol image-input JSON response shape, GPT Image 2.5 Flare generation/usage shape, and GPT-Live WebRTC session creation plus a delegated synthetic spoken question. These are integration shape checks, not field accuracy tests.

## Live voice pilot limits

- The pilot requires a build with `VITE_LIVE_ASK_PILOT=true` and server `LIVE_ASK_ENABLED=true`. Neither is enabled by this branch. Both the button and the server limit pilot access to the real owner account. Test with a consented device before exposing it to crew.
- The server reserves and records the full three-minute session cap against the spend guard. Short sessions can therefore appear more expensive in Forge than the provider's final seconds. Actual provider billing is separate; add a trusted reconciliation path before using Forge's figure as actual spend.
- A provider delegation is the turn boundary; partial live transcripts are never treated as saved evidence. If a browser cannot cut a playable segment, Forge cannot send that turn. Confirm this behavior on Safari and a noisy field connection.
- Real photo judgment, accents, safety diagrams, and crew usefulness remain unmeasured by the synthetic checks.
- Illustration approval updates the talk's JSON array. Two reviewers editing the same talk at the same moment can overwrite each other's review state; serialize this server-side if overlapping review becomes common.

## Next practical evaluation

Use a small owner-controlled pilot with consented crew audio, known after-install photos, and a few real drawing discrepancies. Have a foreman score whether each suggestion was useful, misleading, or missing, and retain the exact source photo/drawing revision. A voice pilot should measure whether every spoken operational turn has a saved source recording, one Ask receipt, and a recoverable error path. Production deployment and authenticated field behavior remain separate from these fixture results.

## Peer handoff

Claude Sonnet implemented the training illustration editor and the first live voice pilot slice in bounded, nonoverlapping files. Its receipts are `7e12d6ab-3aa2-4f06-a33d-57473a5e991d` and `bd6411d6-fd32-4ac0-93f3-8b4d1c1b4cb2`. Codex checked the provider contracts against current OpenAI documentation and live synthetic calls, corrected the GPT-Live request and event shapes, added the server and row permission checks, and ran the integrated checks. The owner still needs a signed-in device trial before voice is exposed to crew.
