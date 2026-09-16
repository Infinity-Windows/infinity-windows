import { isForemanPlus, isSupervisorPlus } from "./install/types";

const CREW_ROLES = new Set(["installer", "foreman", "lead", "supervisor", "admin", "owner", "big_boss"]);

/** UI counterpart to the RPC checks; missing/partner roles grant nothing. */
export function canEditTimecard(actorRole: string | null | undefined, actorId: string | undefined, targetRole: string | null | undefined, targetId: string): boolean {
  if (!actorId || !targetRole || !CREW_ROLES.has(targetRole)) return false;
  return isSupervisorPlus(actorRole) || (isForemanPlus(actorRole) && (actorId === targetId || targetRole === "installer"));
}

export function canApproveTimecard(actorRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  if (!targetRole || !CREW_ROLES.has(targetRole)) return false;
  return isSupervisorPlus(actorRole) || (isForemanPlus(actorRole) && ["installer", "foreman", "lead"].includes(targetRole));
}
