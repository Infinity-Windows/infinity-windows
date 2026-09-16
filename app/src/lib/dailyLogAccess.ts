import { isForemanPlus } from "./install/types";

/** Daily reporting is open to the internal crew; server checks exclude partners. */
export function canUseDailyLogs(role: string | null | undefined): boolean {
  return role === "installer" || isForemanPlus(role);
}
