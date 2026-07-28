import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";

/**
 * Realtime channels are keyed by topic inside the Supabase client: calling
 * `supabase.channel(topic)` returns the EXISTING channel if one with that topic
 * is already registered. Because `removeChannel()` is async, a fast effect
 * re-run (a dependency change, or React's dev double-invoke) can hand back a
 * channel that has already been `.subscribe()`d — and then `.on()` throws
 * "cannot add postgres_changes callbacks after subscribe()", crashing the tree.
 * A unique suffix guarantees every subscription gets its own fresh channel.
 */
function uniqueTopic(base: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${base}-${rand}`;
}

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
      // A re-extract replaces every opening ROW, so an open single-opening
      // screen is looking at an id that no longer exists. Refetching is what
      // turns a silent dead page into the "this opening moved" recovery.
      queryClient.invalidateQueries({ queryKey: ["opening"] });
      queryClient.invalidateQueries({ queryKey: ["openingCounts"] });
      queryClient.invalidateQueries({ queryKey: ["voidedOpenings", projectId] });
    };

    const channel = supabase
      .channel(uniqueTopic(`openings-${projectId}`))
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
 * Supervisor Heartbeat: subscribe to ALL project_openings changes (no project
 * filter) so the cross-project live crew board reflects every start/finish the
 * instant it happens. Only enable on the Heartbeat page for supervisor+ — this
 * is a firehose across all jobs, not something to run on every device.
 */
export function useRealtimeAllOpenings(enabled: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["heartbeat"] });
    };

    const channel = supabase
      .channel(uniqueTopic("heartbeat-all-openings"))
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_openings" },
        invalidate,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "issues" },
        invalidate,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, queryClient]);
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
      .channel(uniqueTopic(`my-openings-${installerId}`))
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
