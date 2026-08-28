// Wave A3: the badge on a draft the scheduling AI wrote (wave A2's
// draft_assignments), never a human. Same technique InstallChip
// (components/install/InstallChip.tsx) and DayFlowChip both use — a small
// pill, its own component and CSS class because "AI-proposed" is a
// provenance flag on a schedule assignment, not an install state or a
// day-flow reading. Tone is the app's accent color specifically
// (a1-ai-scheduler-spec.md, A3: "InstallChip tones, accent") rather than the
// ok/warn/danger set those two use — this isn't a status, it's a source.
//
// CONTEXT.md: **AI-proposed** — a draft the assistant wrote; badged until
// published; the publish records a human approved an AI plan. The CALLER
// decides when to show this (CrewBoard renders it only while status is
// still 'draft' — created_via itself never clears at publish, so the badge
// is a display rule, not a data rule).
import { Sparkles } from "lucide-react";

export function AiProposedChip() {
  return (
    <span className="ai-proposed-chip" title="Drafted by the AI assistant — not yet published">
      <Sparkles size={10} aria-hidden /> AI
    </span>
  );
}
