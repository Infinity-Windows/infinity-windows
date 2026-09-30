# Forge and HexCore: reviewed guidance and live voice pilot

## Where information lives

- Forge remains the source for unit photos, drawings, recordings, job records, and learning cases. A case carries scoped IDs and evidence links; it does not copy every field file into HexCore.
- HexCore remains the source for its approved lessons and reference files. The existing Hex-Portal returns exact reviewed lesson revisions after checking current Forge job access and HexCore sharing/withdrawal state.
- The new phone cache is only a temporary copy of a lesson the owner actually viewed through that live bridge. It stores up to eight exact job/question matches for one signed-in owner, expires each after one hour, and erases them on reconnect or account change. A cached lesson is visibly labeled as potentially outdated, cannot produce a new learning draft, and is excluded from later model context. Crew continue to use the live bridge. No original files are duplicated by this build.
- File reads and bridge requests do not themselves call an OpenAI model. AI is charged only for tasks such as voice, transcription, analysis, and answer generation; storage and transport have their own provider costs.

## Spoken Ask pilot

- Production builds show the entry point only to the real owner account; `VITE_LIVE_ASK_PILOT=false` can hide it in a subsequent build. The server still refuses sessions until the GitHub Actions `LIVE_ASK_ENABLED=true` repository variable is synced to Supabase by the backend workflow. Missing means off.
- The phone closes its microphone and Live session when it backgrounds, signs out, ends normally, or reaches three minutes. A server-owned provider-session row and one-minute expiry sweep close a session if the phone's timer stops. The spend ledger conservatively reserves four minutes for this window; it is not a statement of actual OpenAI billing.
- The expiry sweep accepts no user parameters. The database keeps provider session IDs, deadlines, and close times only; no voice content goes in that table. The OpenAI credential remains on the server.
- The owner-device acceptance is still required: start, speak, hear a delegated Forge answer, end at the cap, background/lock, account change, and check microphone and provider closure. A successful synthetic provider call and local tests do not establish a field pass.

## Review and release evidence

Claude Sonnet reviewed the scoped architecture and activation risks through the authorized local CLI, session `2e3efd2f-e834-4a17-ab97-12ed24a37d05`. Its main findings were to constrain the cache to guidance already served live, make offline staleness explicit, purge on reconnect, and add a server stop for voice sessions. Codex implemented those checks and owns the final code/release verification. The peer did not edit files or test production.

Claude Sonnet then reviewed the patch supplied inline, session `39d6c50e-ed73-4e71-a9f7-6b9e9ec2a588`. It requested a rolled-back production database probe, a documented system actor, and a retry plus actionable server log if both expiry-row insertion and provider hangup fail. Those changes were added. Its smaller cache observation led to clearing only the no-match question while keeping unrelated checked lessons. The production UI role comes from Forge's real profile query; the Edge function makes the authoritative owner-rank and access checks.

Before enabling the server pilot, confirm the migration, Edge function deployment, expiry cron job, and due-only endpoint in production. If any of those fails, leave `LIVE_ASK_ENABLED` off. Keep the pilot owner-only until the signed-in phone trial and spend evidence pass.

The new migration and its probe passed the [rolled-back real-database dry run](https://github.com/Infinity-Windows/infinity-windows/actions/runs/36769984297): exactly one one-minute expiry job, RLS enabled, service-role-only table access, a due row visible to the system, and an installer insert refused with `42501`. This proves the migration against the current production schema without leaving its changes behind. The actual merge deployment and live Edge endpoint still require separate checks.
