import { errorMessage, isPermanentSqlState } from "../offline/outbox-core";

/** A read that could not reach an answer, rather than an authorization denial.
 * Never classify by navigator.onLine, TypeError, or a bare "timeout" word:
 * those can hide a real server refusal or a programming error. Profile reads
 * and owner-pilot admission share this narrow classification. */
export function isProfileReadNetworkFailure(err: unknown): boolean {
  const rec = err && typeof err === "object" ? (err as { status?: unknown; code?: unknown }) : null;
  const status = typeof rec?.status === "number" ? rec.status : null;
  if (status === 401 || status === 403) return false;
  if (status === 408 || status === 429 || (status !== null && status >= 500)) return true;
  if (isPermanentSqlState(typeof rec?.code === "string" ? rec.code : null)) return false;
  const msg = errorMessage(err).toLowerCase();
  if (/permission denied|not authorized|forbidden|row-level security/.test(msg)) return false;
  return /failed to fetch|networkerror when attempting to fetch|load failed|fetch failed|the network connection was lost|err_internet_disconnected|err_network_changed|err_connection_(refused|reset|closed|aborted)|err_name_not_resolved|request timed out|timed out while fetching/.test(msg);
}
