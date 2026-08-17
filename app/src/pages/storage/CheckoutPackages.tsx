// Going out: the same multi-select, two destinations.
//
// STAGE sets packages aside on the job's own bay so they go out together —
// still ours, still on hand, just on the job's shelf instead of in a conex.
// CHECK OUT concludes tracking (owner pick): history stays forever, and the
// mismatch guard flags a crate bound to a DIFFERENT job before it leaves
// under the wrong one.
//
// One picker for both because it is one decision with two endings — asking a
// crew to learn a second screen for "same crates, shorter trip" is how the
// staging step gets skipped.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import {
  checkoutPackagesOffline,
  writeToast,
} from "../../lib/warehouse/offlineWrites";
import { BackChip } from "../../components/BackChip";
import {
  CATEGORY_LABELS,
  listActivePackages,
  listCheckoutReasons,
  listContainers,
  mismatchedPackages,
  stagePackages,
} from "../../lib/storage";
import { isMissingStagingBayError } from "../../lib/staging";

export function CheckoutPackages() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const reasons = useQuery({ queryKey: ["checkoutReasons"], queryFn: listCheckoutReasons });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [otherNote, setOtherNote] = useState("");
  const [projectId, setProjectId] = useState("");
  const [containerFilter, setContainerFilter] = useState("");
  const [mode, setMode] = useState<"stage" | "out">("out");

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  const available = useMemo(
    () =>
      (packages.data ?? []).filter(
        (p) =>
          (p.status === "stored" || p.status === "received") &&
          (!containerFilter || p.container_id === containerFilter),
      ),
    [packages.data, containerFilter],
  );

  const pickedRows = available.filter((p) => picked.has(p.id));
  const mismatched = projectId ? mismatchedPackages(pickedRows, projectId) : [];
  const isOther = reason === "Other";
  const finalReason = isOther && otherNote.trim() ? `Other — ${otherNote.trim()}` : reason;

  // Default destination: the job most of the picked packages are bound to.
  const suggestedProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pickedRows) {
      if (p.project_id) counts.set(p.project_id, (counts.get(p.project_id) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }, [pickedRows]);

  const stage = useMutation({
    mutationFn: () => stagePackages([...picked], projectId),
    onSuccess: (n) => {
      pushToast(`${n} package${n === 1 ? "" : "s"} set aside for the job.`);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      navigate("/warehouse");
    },
    onError: (e) => {
      // The server refuses rather than using a shared stock shelf — say what
      // to do instead of showing the raw refusal.
      pushToast(
        isMissingStagingBayError(e)
          ? "This job has no staging bay yet. A foreman can add one from the job page, then try again."
          : formatApiError(e),
        "error",
      );
    },
  });

  const submit = useMutation({
    mutationFn: () => checkoutPackagesOffline([...picked], finalReason, projectId),
    onSuccess: (r) => {
      pushToast(
        writeToast(r, `${r.count} package${r.count === 1 ? "" : "s"} checked out.`),
      );
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      navigate("/storage");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Storage</p>
          <h1>{mode === "stage" ? "Set aside for a job" : "Check out"}</h1>
        </div>
      </header>

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button
          className={mode === "stage" ? "button-like active-pill" : "button-like"}
          onClick={() => setMode("stage")}
        >
          Set aside (staging)
        </button>
        <button
          className={mode === "out" ? "button-like active-pill" : "button-like"}
          onClick={() => setMode("out")}
        >
          Check out
        </button>
      </div>
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
        {mode === "stage"
          ? "Puts them on this job's own shelf so they go out together. Still ours, still on hand — check one back into a conex any time."
          : "Takes them out of storage to the job. This is the end of the trail; the history stays forever."}
      </p>

      <h2>1 · Packages ({picked.size} picked)</h2>
      <select
        value={containerFilter}
        onChange={(e) => setContainerFilter(e.target.value)}
      >
        <option value="">All containers</option>
        {(containers.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <div className="home-projects" style={{ marginTop: 6 }}>
        {available.map((p) => {
          const on = picked.has(p.id);
          const where =
            (containers.data ?? []).find((c) => c.id === p.container_id)?.name ??
            "not stored yet";
          return (
            <button
              key={p.id}
              className="project-card home-project"
              style={{ textAlign: "left" }}
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  return next;
                })
              }
            >
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {p.serial}
                    {p.short_code ? ` · ${p.short_code}` : ""}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {jobCode.get(p.project_id ?? "") ?? "no job"}
                    {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""} · {where}
                  </div>
                </div>
                <span style={{ fontSize: 20 }}>{on ? "☑" : "☐"}</span>
              </div>
            </button>
          );
        })}
        {available.length === 0 && <p className="muted">Nothing in storage.</p>}
      </div>

      {mode === "out" && (
        <>
      <h2>2 · Why</h2>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {(reasons.data ?? []).map((r) => (
          <button
            key={r.id}
            className={reason === r.label ? "button-like active-pill" : "button-like"}
            onClick={() => setReason(r.label)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {isOther && (
        <input
          placeholder="Say why"
          value={otherNote}
          onChange={(e) => setOtherNote(e.target.value)}
        />
      )}

        </>
      )}

      <h2>{mode === "out" ? "3 · To what job" : "2 · Which job"}</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">
          {suggestedProject
            ? `Pick the job… (most picked are ${jobCode.get(suggestedProject) ?? "?"})`
            : "Pick the job…"}
        </option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      {suggestedProject && !projectId && (
        <button
          className="button-like"
          style={{ marginTop: 6 }}
          onClick={() => setProjectId(suggestedProject)}
        >
          Use {jobCode.get(suggestedProject)}
        </button>
      )}

      {mismatched.length > 0 && (
        <p className="warn" style={{ color: "#b8860b", fontSize: 13 }}>
          ⚠ {mismatched.length} of these {mismatched.length === 1 ? "was" : "were"} tagged
          for a different job (
          {mismatched
            .map((p) => `${p.serial}→${jobCode.get(p.project_id ?? "") ?? "?"}`)
            .slice(0, 4)
            .join(", ")}
          ). Double-check before it leaves.
        </p>
      )}

      <div style={{ marginTop: 12 }}>
        {mode === "stage" ? (
          <button
            className="button-like active-pill"
            disabled={picked.size === 0 || !projectId || stage.isPending}
            onClick={() => stage.mutate()}
          >
            {stage.isPending ? "Setting aside…" : `Set aside ${picked.size}`}
          </button>
        ) : (
          <button
            className="button-like active-pill"
            disabled={
              picked.size === 0 ||
              !finalReason ||
              (isOther && !otherNote.trim()) ||
              !projectId ||
              submit.isPending
            }
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Checking out…" : `Check out ${picked.size}`}
          </button>
        )}
      </div>
    </div>
  );
}
