import { isUuid, type SetupDraft } from "../../../supabase/functions/_shared/fieldTools";
import type { FieldReceipt } from "./fieldAsk";
import type { ClockInPick, TimeShift } from "./timeclock";
import { shiftGuard } from "./shiftGuard";

/** A waiting Ask receipt can guide the person to the right clock screen.
 * The receipt's job ID is server-issued; the draft supplies display text only. */
export interface AskClockHandoff {
  reason: "needs_clock" | "wrong_job";
  projectId: string | null;
  jobName: string | null;
}

export function askClockHandoff(receipt: FieldReceipt, draft?: SetupDraft | null): AskClockHandoff | null {
  if (receipt.status !== "needs_choice" || (receipt.reason !== "needs_clock" && receipt.reason !== "wrong_job")) return null;
  const projectId = isUuid(receipt.project_id) ? receipt.project_id.toLowerCase() : null;
  const job = draft?.job;
  const jobName = projectId && job?.project_id?.toLowerCase() === projectId && typeof job.name === "string"
    ? job.name.trim().slice(0, 80) || null
    : null;
  return { reason: receipt.reason, projectId, jobName };
}

export function askClockPick(handoff: AskClockHandoff): ClockInPick {
  return { projectId: handoff.projectId, costCodeId: null, note: null, mode: null, returnToAsk: true };
}

/** Open directly on the switch confirmation when a handoff's requested job differs.
 * A break or an overlong shift still gets the normal clock safeguards first. */
export function askClockEntryMode(shift: TimeShift | null, pick?: ClockInPick | null): "pick" | "main" | "switch" {
  if (!shift) return "pick";
  if (!(pick?.returnToAsk || pick?.switchToProject) || !pick.projectId || pick.projectId.toLowerCase() === shift.project_id?.toLowerCase() || shift.break_started_at) return "main";
  const guard = shiftGuard(shift, Date.now());
  return guard.state === "over-cap" || guard.state === "needs-finish" ? "main" : "switch";
}

export function askClockLabel(handoff: AskClockHandoff, es: boolean): string {
  if (handoff.reason === "wrong_job") {
    return handoff.jobName ? (es ? `Cambiar a ${handoff.jobName}` : `Switch to ${handoff.jobName}`) : (es ? "Cambiar de obra" : "Switch job");
  }
  return handoff.jobName ? (es ? `Marcar entrada en ${handoff.jobName}` : `Clock in to ${handoff.jobName}`) : (es ? "Abrir reloj de trabajo" : "Open job clock");
}
