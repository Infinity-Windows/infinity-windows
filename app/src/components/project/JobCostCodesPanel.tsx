// The per-job cost-code editor (standard-tracking-jobs slice 3, foreman+).
//
// A job's OPTIONAL pickable subset of the company cost-code library: tick the
// codes that apply to this job and crew see only those (plus the general
// fallback) at clock-in. Tick none and the job shows the full active list — the
// behaviour every job has today. Writes go through the foreman+ RPCs
// (setProjectCostCodes); this component is a checklist over the active library.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listCostCodes } from "../../lib/timeclock";
import { listProjectCostCodes, setProjectCostCodes } from "../../lib/costCodes";
import { pushToast, toastError } from "../../lib/toast";
import { useT } from "../../lib/i18n";

export function JobCostCodesPanel({ projectId }: { projectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();

  const all = useQuery({ queryKey: ["allActiveCostCodes"], queryFn: listCostCodes });
  const assigned = useQuery({
    queryKey: ["projectCostCodes", projectId],
    queryFn: () => listProjectCostCodes(projectId),
  });

  // Local edit state: the set of chosen ids, seeded from what the job has once
  // it loads. `ready` guards against re-seeding over the user's edits on a
  // background refetch.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (assigned.isSuccess && !ready) {
      setChosen(new Set(assigned.data.map((c) => c.id)));
      setReady(true);
    }
  }, [assigned.isSuccess, assigned.data, ready]);

  const activeCodes = useMemo(() => all.data ?? [], [all.data]);

  const save = useMutation({
    mutationFn: () => setProjectCostCodes(projectId, [...chosen]),
    onSuccess: () => {
      pushToast(t("jobcost.saved"), "info");
      void queryClient.invalidateQueries({ queryKey: ["projectCostCodes", projectId] });
      // The clock-in picker reads a per-job list; refresh every scope so a
      // worker clocking into this job sees the change immediately.
      void queryClient.invalidateQueries({ queryKey: ["clockCostCodes"] });
    },
    onError: (e) => toastError(e),
  });

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dirty = useMemo(() => {
    const current = new Set((assigned.data ?? []).map((c) => c.id));
    if (current.size !== chosen.size) return true;
    for (const id of chosen) if (!current.has(id)) return true;
    return false;
  }, [assigned.data, chosen]);

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0 }}>{t("jobcost.title")}</h2>
      <p className="wh-row-sub" style={{ margin: "4px 0 8px" }}>
        {t("jobcost.help")}
      </p>

      {all.isLoading && <p className="muted">{t("jobcost.loading")}</p>}
      {!all.isLoading && activeCodes.length === 0 && (
        <p className="muted">{t("jobcost.empty")}</p>
      )}

      {activeCodes.length > 0 && (
        <>
          <p className="wh-row-sub" style={{ margin: "0 0 8px" }}>
            {chosen.size === 0
              ? t("jobcost.allShown")
              : t("jobcost.subsetCount", { n: chosen.size, total: activeCodes.length })}
          </p>
          <ul className="jobcost-list">
            {activeCodes.map((c) => {
              const on = chosen.has(c.id);
              return (
                <li key={c.id}>
                  <label className="jobcost-row">
                    <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                    <span className="jobcost-code">{c.code}</span>
                    <span className="jobcost-label">{c.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            className="action-btn primary"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("jobcost.saving") : t("jobcost.save")}
          </button>
        </>
      )}
    </section>
  );
}
