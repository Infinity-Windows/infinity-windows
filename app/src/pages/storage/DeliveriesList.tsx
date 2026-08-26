// Recent trucks, newest first: each delivery is a standby list with an
// against-the-list score — expected vs arrived — linking to its tailgate
// screen. Foremen edit here (rename, delete); supervisors also put the
// truck on the schedule: date + time + who meets it, which lands as a
// published entry on Scheduling and those members' My Schedule.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { EmptyState } from "../../components/ui/States";
import { StageChip } from "../../components/warehouse/StageChip";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/errors";
import {
  deleteDelivery,
  listDeliveries,
  scheduleDelivery,
  updateDelivery,
} from "../../lib/storage";
import { listProfiles } from "../../lib/install/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus, isSupervisorPlus } from "../../lib/install/types";

export function DeliveriesList() {
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const boss = isSupervisorPlus(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [whenDraft, setWhenDraft] = useState("");
  const [crewDraft, setCrewDraft] = useState<Set<string>>(new Set());

  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const counts = useQuery({
    queryKey: ["deliveryCounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("packages")
        .select("delivery_id, status")
        .not("delivery_id", "is", null);
      if (error) throw error;
      const byDelivery = new Map<string, { expected: number; arrived: number }>();
      for (const row of data ?? []) {
        const d = row.delivery_id as string;
        const c = byDelivery.get(d) ?? { expected: 0, arrived: 0 };
        c.expected += 1;
        if (row.status !== "minted" && row.status !== "blank") c.arrived += 1;
        byDelivery.set(d, c);
      }
      return byDelivery;
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["deliveries"] });
    void qc.invalidateQueries({ queryKey: ["deliveryCounts"] });
  };

  const rename = useMutation({
    mutationFn: (args: { id: string; label: string }) =>
      updateDelivery(args.id, { label: args.label }),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDelivery(id),
    onSuccess: (r) => {
      setMessage(
        `Delivery deleted. ${r.killed} expected package${r.killed === 1 ? "" : "s"} went with the list; ${r.kept} arrived piece${r.kept === 1 ? "" : "s"} stayed real.`,
      );
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const schedule = useMutation({
    mutationFn: (args: { id: string; when: string; crew: string[] }) =>
      scheduleDelivery(args.id, new Date(args.when).toISOString(), args.crew),
    onSuccess: () => {
      setMessage("On the schedule — it shows on Scheduling and their My Schedule.");
      setEditing(null);
      refresh();
      void qc.invalidateQueries({ queryKey: ["schedule"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const toggleCrew = (id: string) =>
    setCrewDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Deliveries</h1>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>
      {message && <p className="scanner-hint">{message}</p>}
      <ul className="unit-list">
        {(deliveries.data ?? []).map((d) => {
          const c = counts.data?.get(d.id);
          // Same words as before ("3 of 12 arrived" / "all 3 arrived") — just
          // the leading count styled big/tabular and "arrived" in its stage
          // color (picks 1 + 2), instead of one plain string.
          const countText = c
            ? c.arrived >= c.expected
              ? `all ${c.expected}`
              : `${c.arrived} of ${c.expected}`
            : null;
          const open = editing === d.id;
          return (
            <li key={d.id} className="opening-review-row">
              <div className="wh-row">
                <Link to={`/storage/d/${d.id}`} className="link">
                  <strong>{d.label ?? "Delivery"}</strong>
                </Link>
                <span className="muted">
                  {d.expected_at
                    ? `truck ${new Date(d.expected_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}`
                    : (d.arrived_on ?? "")}{" "}
                  ·{" "}
                  {countText ? (
                    <>
                      <span className="wh-count">{countText}</span>{" "}
                      <StageChip stage="received">arrived</StageChip>
                    </>
                  ) : (
                    "…"
                  )}
                </span>
                {lead && (
                  <button
                    className="link"
                    onClick={() => {
                      setEditing(open ? null : d.id);
                      setNameDraft(d.label ?? "");
                      setWhenDraft(
                        d.expected_at ? d.expected_at.slice(0, 16) : "",
                      );
                      setCrewDraft(new Set());
                    }}
                  >
                    {open ? "Close" : "Edit…"}
                  </button>
                )}
              </div>
              {open && (
                <div className="detail-card wh-card">
                  <div className="wh-row">
                    <input
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      aria-label="Delivery name"
                      style={{ width: 220 }}
                    />
                    <button
                      className="button-like"
                      disabled={!nameDraft.trim() || rename.isPending}
                      onClick={() =>
                        rename.mutate({ id: d.id, label: nameDraft.trim() })
                      }
                    >
                      Rename
                    </button>
                    <button
                      className="button-like"
                      style={{ color: "var(--danger)" }}
                      disabled={remove.isPending}
                      onClick={() => {
                        const exp = c ? c.expected - c.arrived : 0;
                        if (
                          window.confirm(
                            `Delete this delivery? ${exp} still-expected package${exp === 1 ? "" : "s"} die with the list; anything already arrived stays real. This can't be undone.`,
                          )
                        ) {
                          remove.mutate(d.id);
                        }
                      }}
                    >
                      Delete delivery…
                    </button>
                  </div>
                  {boss && (
                    <div style={{ marginTop: 8 }}>
                      <label className="field-label" htmlFor={`when-${d.id}`}>
                        When does the truck come?
                      </label>
                      <div className="wh-row">
                        <input
                          id={`when-${d.id}`}
                          type="datetime-local"
                          value={whenDraft}
                          onChange={(e) => setWhenDraft(e.target.value)}
                        />
                        <button
                          className="primary"
                          disabled={!whenDraft || schedule.isPending}
                          onClick={() =>
                            schedule.mutate({
                              id: d.id,
                              when: whenDraft,
                              crew: [...crewDraft],
                            })
                          }
                        >
                          {schedule.isPending ? "Scheduling…" : "Put it on the schedule"}
                        </button>
                      </div>
                      <p className="muted" style={{ margin: "6px 0 2px", fontSize: 12 }}>
                        Who meets it?
                      </p>
                      <div className="row-gap">
                        {(profiles.data ?? [])
                          .filter((p) => p.active)
                          .map((p) => (
                            <button
                              key={p.id}
                              className={
                                crewDraft.has(p.id)
                                  ? "button-like active-pill"
                                  : "button-like"
                              }
                              onClick={() => toggleCrew(p.id)}
                            >
                              {p.display_name}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {(deliveries.data ?? []).length === 0 && (
        <EmptyState
          title="No deliveries yet."
          message="Log one from the warehouse page before the truck comes."
          action={
            <Link className="button-like active-pill" to="/storage/log-delivery">
              Log a delivery
            </Link>
          }
        />
      )}
    </div>
  );
}
