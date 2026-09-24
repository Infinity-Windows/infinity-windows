# ADR-0012: One registry says what Forge AI can do, and only a receipt says it did

Date: 2026-09-23. Status: accepted (owner-approved spec, Release 2 of the crew
redesign, `.scratch/crew-redesign/crew-redesign-spec.md` K2.1–K2.7;
grill log round 3).

## Context

Before this release the assistant's abilities were implicit: each tool module
(`fieldTools`, `learningTools`, `schedulingTools`, `askReporting`) was spliced
into the Ask function's tool list by hand, the Ask page showed a flat row of
starter chips that never collapsed, and nothing on the phone or in the
prompt said which things Ask could NOT do yet. A crew member could ask to
take supplies, be answered as if it were possible, and have no way to tell
whether anything happened — the model's prose was the only account of it.
The owner's bar for the whole program is "no fat and no errors": zero
misleading receipts.

## Decision

1. **One typed registry** (`supabase/functions/_shared/askCapabilities.ts`),
   pure and shared byte-for-byte by the app and the edge function, lists every
   action: roles, questions, what it changes, receipt kind, model tools, live
   or not (and which release ships it), and the screen it belongs to. The
   cards, "All actions" and the model's tool list derive from it, and a test
   pins both directions — every named tool exists, every existing tool is
   claimed — so a tool nobody registered cannot reach the model and a card
   cannot name a tool that does not exist. Unbuilt actions are absent from
   the cards and honest under All actions.
2. **The wall stays where it was.** The registry decides what a person is
   SHOWN and what the model is TOLD; permission is still enforced by the
   executors and the database (wave A2's PERMISSION MIRROR, ADR-level law in
   CONTEXT.md). Tools are offered to every caller; a below-rank caller gets
   the same plain refusal as before.
3. **Receipts are the only proof.** A changing reply shows its receipt with
   the status in three words taken from the receipt, never from prose; the
   phone contradicts any reply that reads as done without one. The model is
   told the same rule.
4. **The boundary is a test.** The AI never changes clocks or breaks, signs,
   approves, publishes or clocks anyone else. A source-level test reads the
   Ask function and its tool modules and fails on any such RPC. What the AI
   may do instead is offer a one-tap button whose tap uses the clock sheet's
   own path.
5. **Voice is heard as spoken.** Ask's microphone forces no language on the
   transcription provider; the model answers in the language the person used.

## Consequences

- Adding an action means adding one registry entry (and its executor); the
  cards, All actions, the prompt and the tool list follow. Forgetting the
  registry is a failing test, not a silent gap.
- Release 3 (Crew status, Units completed) and Release 4 (Take supplies)
  flip `live` on entries that already exist, and their cards appear.
- The receipt guard is deliberately over-eager: a reply that merely sounds
  done under an empty conversation is contradicted, and the cost of a false
  contradiction (one honest line) is lower than the cost of a false claim.
- The evaluation set (`scripts/ask-eval/`) is the standing measure of both
  the tool layer (stubbed model, in CI) and, on demand, a real model.
