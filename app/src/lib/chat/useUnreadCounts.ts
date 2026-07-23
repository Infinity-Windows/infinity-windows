import { useQuery } from "@tanstack/react-query";
import { getUnreadCounts } from "./api";

/**
 * Shared job-chat unread counts (project id → count) for badges across Home,
 * Projects and the project hub. One query key so the cache is shared and the
 * realtime hook can invalidate every badge at once. Degrades to {} on error so
 * a badge never blanks a page.
 */
export function useUnreadCounts() {
  return useQuery({
    queryKey: ["chatUnread"],
    queryFn: getUnreadCounts,
  });
}
