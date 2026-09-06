# Edge functions that act for the system, not for a signed-in person

Every edge function here runs on the service-role key, which bypasses row
security. The rule (`scripts/check-function-auth.sh`, run by CI) is that a
function must ask who is calling — `requireCaller` or `verifyCaller` from
`_shared/auth.ts` — or be listed here with the reason it does not. The
reason is the useful half: it turns "nobody checked" into a decision somebody
can disagree with in review. A function on this list that later gains a
caller check fails CI too, so the list cannot go stale quietly.

The check reads this file by the backticked name at the start of each
bullet. Keep that shape.

- `gc-link` — reached by a general contractor who has no account and never
  will. The credential is the 32-random-byte link token, checked inside the
  function against a stored sha256 (`gc_link_open`). A JWT would prove
  nothing here; the gateway still refuses a request with no Authorization
  header at all (wave H, H2; see `supabase/config.toml`).
- `redeem-crew-invite` — reached by someone who has no account yet, which is
  the whole point. The credential is the invite code, checked inside the
  function (`_shared/crewInvites.ts`); `verifyCaller` would only report that
  there is no end user, and the function says so in its own header.
- `pipeline-sweep` — parameterless, idempotent pg_cron target. The poke
  carries no auth on purpose; every decision (the 7 AM company-local gate,
  the day windows, the once-per-thing claim) is made in
  `claim_pipeline_nudges()` in SQL, so a stray call does nothing the next
  scheduled run would not (wave J, J4; `verify_jwt = false`).
- `still-on-the-job-sweep` — the same shape: parameterless, idempotent, the
  once-per-shift claim lives in `claim_still_on_the_job_nudges()` (wave K, K2;
  `verify_jwt = false`).
- `summon-warning-sweep` — the same shape again: parameterless, idempotent,
  decides everything from the database (`verify_jwt = false`).
