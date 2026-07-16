import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";

/**
 * Keep openings fresh across every crew device. Subscribes to Postgres changes
 * on project_openings for one job and invalidates the relevant React Query
 * keys so the lead board and each installer's "My Work" update live — this is
 * what stops six people colliding on the same window.
 */
export function useRealtimeOpenings(projectId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["myOpenings"] });
      queryClient.invalidateQueries({ queryKey: ["dispatch", projectId] });
    };

    const channel = supabase
      .channel(`openings-${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "project_openings",
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

/**
 * Keep an installer's "My Work" live: any opening change refreshes their list
 * and confirm queue, so a foreman assignment shows up on the phone at once.
 */
export function useRealtimeMyOpenings(installerId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!installerId) return;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["myOpenings"] });
      queryClient.invalidateQueries({ queryKey: ["memosToConfirm"] });
      queryClient.invalidateQueries({ queryKey: ["myReadyCount"] });
    };

    const channel = supabase
      .channel(`my-openings-${installerId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_openings" },
        invalidate,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [installerId, queryClient]);
}
