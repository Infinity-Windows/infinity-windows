import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";

/**
 * Realtime channels are keyed by topic inside the Supabase client: a fast
 * effect re-run can hand back a channel that has already been `.subscribe()`d,
 * and then `.on()` throws "cannot add postgres_changes callbacks after
 * subscribe()". A unique suffix guarantees every subscription gets its own
 * fresh channel (mirrors useRealtimeOpenings' uniqueTopic).
 */
function uniqueTopic(base: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${base}-${rand}`;
}

/**
 * Keep a job's chat live: subscribe to inserts on project_messages for one
 * project and invalidate the thread query so every device sees new messages the
 * instant they land.
 */
export function useRealtimeMessages(projectId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["projectMessages", projectId] });
      // Keep unread badges fresh: a new message on any job the user can see may
      // change its unread count (the query is shared across Home/Projects/tabs).
      queryClient.invalidateQueries({ queryKey: ["chatUnread"] });
    };

    const channel = supabase
      .channel(uniqueTopic(`project-messages-${projectId}`))
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "project_messages",
          filter: `project_id=eq.${projectId}`,
        },
        invalidate,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [projectId, queryClient]);
}
