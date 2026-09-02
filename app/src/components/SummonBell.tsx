// The in-app ring (owner, 2026-08-14): the moment a summon lands anywhere,
// every signed-in device shows a banner with the window, the caller, and
// an Answer path — plus as much noise as the platform allows. Push covers
// closed apps; this covers the open one.
//
// The ring obeys the same two rules the landing strip does (owner ask,
// 2026-09-02): a call you declined and a call that has ended — expired after
// a day, or closed by the caller — take the banner down with them. A banner
// still shouting "Answer to help" for a summon nobody can answer is exactly
// the pile-up the Decline button exists to stop.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { summonExpired } from "../lib/install/summons";

interface RingRow {
  id: string;
  project_id: string;
  opening_id: string;
  requested_by: string;
  needed: number;
  created_at?: string;
}

export function SummonBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [ring, setRing] = useState<{
    row: RingRow;
    code: string;
    caller: string;
  } | null>(null);
  const meRef = useRef<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;
    void supabase.auth.getUser().then(({ data }) => {
      meRef.current = data.user?.id ?? null;
    });
    const channel = supabase
      .channel(`summon-bell-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "summons" },
        (payload) => {
          const row = payload.new as RingRow;
          // A new summon should appear on the landing strips the moment it
          // exists, not on their next poll (owner report, 2026-08-19).
          void queryClient.invalidateQueries({ queryKey: ["liveSummonsAll"] });
          if (row?.project_id) {
            void queryClient.invalidateQueries({ queryKey: ["summons", row.project_id] });
          }
          if (!row?.id || row.requested_by === meRef.current) return;
          // Same one-day rule as the strip: a call that is already over
          // never rings, however it reached us.
          if (row.created_at && summonExpired(row.created_at)) return;
          void (async () => {
            const [{ data: opening }, { data: caller }] = await Promise.all([
              supabase
                .from("project_openings")
                .select("opening_code")
                .eq("id", row.opening_id)
                .maybeSingle(),
              supabase
                .from("profiles")
                .select("display_name")
                .eq("id", row.requested_by)
                .maybeSingle(),
            ]);
            setRing({
              row,
              code: (opening as { opening_code?: string } | null)?.opening_code ?? "a unit",
              caller: (caller as { display_name?: string } | null)?.display_name ?? "an installer",
            });
            // As much noise as a browser allows without a prior gesture:
            // vibration where supported; audio may be blocked — fine, the
            // banner and the push carry it.
            try {
              navigator.vibrate?.([200, 100, 200, 100, 400]);
            } catch {
              /* not supported */
            }
          })();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "summon_declines" },
        (payload) => {
          const row = payload.new as { summon_id?: string; profile_id?: string };
          if (!row?.summon_id || row.profile_id !== meRef.current) return;
          void queryClient.invalidateQueries({ queryKey: ["liveSummonsAll"] });
          // You said you can't come — take the banner with it.
          setRing((cur) => (cur && cur.row.id === row.summon_id ? null : cur));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "summons" },
        (payload) => {
          const row = payload.new as { id?: string; status?: string };
          if (!row?.id || row.status !== "closed") return;
          void queryClient.invalidateQueries({ queryKey: ["liveSummonsAll"] });
          // Ended by the caller, or swept away a day after it went out.
          setRing((cur) => (cur && cur.row.id === row.id ? null : cur));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  if (!ring) return null;
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        right: 8,
        zIndex: 1000,
        background: "var(--accent, #ff4a2f)",
        color: "#fff",
        borderRadius: 12,
        padding: "12px 14px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ fontSize: 22 }} aria-hidden>
        🔔
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Heavy lift — {ring.code}</strong>
        <div style={{ fontSize: 13, opacity: 0.95 }}>
          {ring.caller} needs {ring.row.needed} — answer to help (+10 pts)
        </div>
      </div>
      <button
        className="button-like"
        style={{ background: "#fff", color: "#000", fontWeight: 700 }}
        onClick={() => {
          const r = ring;
          setRing(null);
          navigate(`/projects/${r.row.project_id}/opening/${r.row.opening_id}`);
        }}
      >
        Answer
      </button>
      <button
        aria-label="Dismiss"
        className="button-like"
        onClick={() => setRing(null)}
      >
        ✕
      </button>
    </div>
  );
}
