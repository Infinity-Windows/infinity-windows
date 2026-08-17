// Arrival check: what actually turned up at the job, and what turned up
// broken.
//
// This is the jobsite half of load-out. It is deliberately NOT required and
// NOT a status change — the package map says On site "follows the checkout;
// this is where it is, not something you do", and that stays true. It exists
// for the one thing arrival genuinely adds: catching transit damage while
// somebody is standing in front of it, so a replacement gets ordered on the
// day rather than discovered on the ladder.
//
// Any crew can file it. The person opening the crate is the installer, and
// making them find a foreman to report a cracked pane is how damage stops
// getting reported at all.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { Explain } from "../../components/ui/Explain";
import {
  arrivePackages,
  CATEGORY_LABELS,
  listActivePackages,
  partLabel,
} from "../../lib/storage";

type Verdict = "ok" | "damaged";

export function ArrivePackages() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [projectId, setProjectId] = useState(params.get("job") ?? "");
  const [verdicts, setVerdicts] = useState<Map<string, Verdict>>(new Map());
  const [note, setNote] = useState("");

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  // Only what actually left for this job can arrive at it.
  const outForJob = useMemo(
    () =>
      (packages.data ?? []).filter(
        (p) => p.status === "checked_out" && (!projectId || p.project_id === projectId),
      ),
    [packages.data, projectId],
  );

  const ok = [...verdicts.entries()].filter(([, v]) => v === "ok").map(([id]) => id);
  const damaged = [...verdicts.entries()].filter(([, v]) => v === "damaged").map(([id]) => id);

  const set = (id: string, v: Verdict) =>
    setVerdicts((prev) => {
      const next = new Map(prev);
      if (next.get(id) === v) next.delete(id);
      else next.set(id, v);
      return next;
    });

  const submit = useMutation({
    mutationFn: () =>
      arrivePackages({ okIds: ok, damagedIds: damaged, projectId, note: note || null }),
    onSuccess: () => {
      pushToast(
        damaged.length > 0
          ? `Arrival logged — ${damaged.length} flagged damaged, ${damaged.length === 1 ? "an issue is" : "issues are"} open.`
          : `Arrival logged — ${ok.length} package${ok.length === 1 ? "" : "s"} good.`,
      );
      setVerdicts(new Map());
      setNote("");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["issues"] });
      navigate("/warehouse");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Storage</p>
          <h1>Arrival check</h1>
        </div>
      </header>

      <Explain id="arrival-check">
        Only worth doing when something looks wrong. Tick anything that arrived
        broken and it raises an urgent issue naming that package, so a
        replacement gets ordered today instead of on the day somebody tries to
        install it. Skipping this changes nothing — the material is already at
        the job either way.
      </Explain>

      <h2>Which job</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Pick the job…</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>

      {projectId && (
        <>
          <h2>What turned up ({outForJob.length} out)</h2>
          <div className="home-projects">
            {outForJob.map((p) => {
              const v = verdicts.get(p.id);
              return (
                <div key={p.id} className="project-card home-project">
                  <div className="home-project-head">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.short_code ?? p.serial}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {partLabel(p) ?? "no part number"}
                        {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""}
                        {(p.package_marks ?? []).length > 0 &&
                          ` · marks ${(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}`}
                      </div>
                    </div>
                    <div className="row-gap">
                      <button
                        className={v === "ok" ? "button-like active-pill" : "button-like"}
                        onClick={() => set(p.id, "ok")}
                      >
                        Good
                      </button>
                      <button
                        className={v === "damaged" ? "button-like active-pill" : "button-like"}
                        onClick={() => set(p.id, "damaged")}
                      >
                        Damaged
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {outForJob.length === 0 && (
              <p className="muted">
                Nothing is checked out to {jobCode.get(projectId) ?? "this job"} right now.
              </p>
            )}
          </div>

          <label className="field-label">Note (optional)</label>
          <input
            placeholder="e.g. corner crushed on the truck"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div style={{ marginTop: 12 }}>
            <button
              className="button-like active-pill"
              disabled={verdicts.size === 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending
                ? "Logging…"
                : `Log ${verdicts.size} · ${damaged.length} damaged`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
