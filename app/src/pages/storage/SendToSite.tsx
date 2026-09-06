// A whole job goes to the job site (owner ask 2026-09-06). One screen per
// job: every unit that is physically here, ticked to go, with a tap to hold
// one back; one button moves the rest through the same check-out every
// screen uses ("On job site" IS checked out — one state, one ledger). Under
// it, the job's last page: "Unit Movement Finalized", which closes the
// job's material story in the warehouse. It refuses while anything is still
// in a box and offers the Boneyard as the way past; foreman and up only.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { listProjectsAnyStatus } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { isForemanPlus } from "../../lib/install/types";
import {
  boneyardJobLeftovers,
  finalizeJobMaterials,
  listActivePackages,
  listContainers,
  reopenJobMaterials,
  type StoragePackage,
} from "../../lib/storage";
import { pushToast } from "../../lib/toast";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { scopeHref } from "../../lib/warehouse/materialsScope";
import { checkoutPackagesOffline, writeToast } from "../../lib/warehouse/offlineWrites";
import { idsToSend, leftoverBlock, sendSummary, siteUnits } from "../../lib/warehouse/sendToSite";

export const SENT_TO_SITE_REASON = "Sent to job site";

// A stable empty list, so "no packages yet" is the same array every render.
const NO_ROWS: StoragePackage[] = [];

export function SendToSite() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);

  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });

  const job = (projects.data ?? []).find((p) => p.id === projectId) ?? null;
  const boxesById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const rows = packages.data ?? NO_ROWS;
  const units = useMemo(() => siteUnits(rows, projectId, boxesById), [rows, projectId, boxesById]);
  const onSite = rows.filter((p) => p.project_id === projectId && p.status === "checked_out").length;
  const block = leftoverBlock(rows, projectId, boxesById);

  const [staying, setStaying] = useState<Set<string>>(new Set());
  const going = idsToSend(units, staying);
  const toggle = (key: string) =>
    setStaying((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    void qc.invalidateQueries({ queryKey: ["storageContainers"] });
    void qc.invalidateQueries({ queryKey: ["projectsAll"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const send = useMutation({
    mutationFn: () => checkoutPackagesOffline(going, SENT_TO_SITE_REASON, projectId),
    onSuccess: (r) => {
      pushToast(writeToast(r, `${r.count} package${r.count === 1 ? "" : "s"} on the job site.`));
      refresh();
      setStaying(new Set());
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const boneyard = useMutation({
    mutationFn: () => boneyardJobLeftovers(projectId),
    onSuccess: (n) => {
      pushToast(`${n} package${n === 1 ? "" : "s"} moved to the Boneyard.`);
      refresh();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const finalize = useMutation({
    mutationFn: async () => {
      // The rule lives here, not only on the button: a hidden button is a
      // habit, a refused write is a rule (and the server refuses too).
      if (block) throw new Error(block);
      await finalizeJobMaterials(projectId);
    },
    onSuccess: () => {
      pushToast(`${job?.job_code ?? "Job"} finalized. It now lives in warehouse history.`);
      refresh();
      navigate("/warehouse/history");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const reopen = useMutation({
    mutationFn: () => reopenJobMaterials(projectId),
    onSuccess: () => {
      pushToast(`${job?.job_code ?? "Job"} is back on the warehouse page.`);
      refresh();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  if (projects.isSuccess && !job) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">Job not found.</p>
      </div>
    );
  }
  const code = job?.job_code ?? "…";
  const finalizedAt = job?.materials_finalized_at ?? null;
  const loading = !(projects.isSuccess && packages.isSuccess && containers.isSuccess);

  return (
    <div className="page send-page">
      <BackChip />
      <header className="page-header">
        <div>
          <p className="home-greeting">{job?.name ?? ""}</p>
          <h1>{code} → job site</h1>
        </div>
      </header>

      {finalizedAt ? (
        <section className="detail-card wh-card send-finalized" aria-label="Finalized">
          <p className="send-finalized-head">
            Unit movement finalized on {finalizedAt.slice(0, 10)}.
          </p>
          <p className="muted">
            Hidden from the warehouse page; listed in <Link to="/warehouse/history">warehouse history</Link>.
            {onSite > 0 ? ` ${onSite} piece${onSite === 1 ? "" : "s"} on the job site.` : ""}
          </p>
          {lead ? (
            <button className="button-like" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              {reopen.isPending ? "Reopening…" : "Reopen in the warehouse"}
            </button>
          ) : (
            <p className="muted">A foreman can reopen it if something comes back.</p>
          )}
        </section>
      ) : null}

      <section aria-label="Units here">
        <div className="wh-row">
          <h2 className="send-title">Here, ready to go</h2>
          {units.length > 0 ? (
            <div className="wh-actions">
              <button
                className="button-like"
                onClick={() => setStaying(staying.size === units.length ? new Set() : new Set(units.map((u) => u.key)))}
              >
                {staying.size === units.length ? "Send all" : "Keep all"}
              </button>
            </div>
          ) : null}
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : units.length === 0 ? (
          <p className="muted">
            Nothing of {code} is in the warehouse right now.
            {onSite > 0 ? ` ${onSite} piece${onSite === 1 ? "" : "s"} already on the job site.` : ""}
          </p>
        ) : (
          <ul className="send-list">
            {units.map((u) => {
              const goes = !staying.has(u.key);
              return (
                <li key={u.key}>
                  <label className={`send-unit${goes ? "" : " send-unit--stays"}`}>
                    <input
                      type="checkbox"
                      checked={goes}
                      onChange={() => toggle(u.key)}
                      aria-label={`${u.label} goes to the job site`}
                    />
                    <span className="send-unit-main">
                      <span className="send-unit-name">{u.label}</span>
                      <span className="send-unit-sub">
                        {u.here} piece{u.here === 1 ? "" : "s"} · {u.places.join(", ")}
                      </span>
                    </span>
                    <span className={`send-unit-tag${goes ? "" : " send-unit-tag--stays"}`}>
                      {goes ? "goes" : "stays"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {units.length > 0 ? (
          <div className="send-bar">
            <span>{sendSummary(units, staying)}</span>
            <button
              className="button-like active-pill"
              disabled={going.length === 0 || send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? "Moving…" : "Move to job site"}
            </button>
          </div>
        ) : null}
        <p className="muted send-hint">
          Untick a unit to keep it here. Moving writes the same "checked out" line
          a check-out does, with the reason "{SENT_TO_SITE_REASON}"; each line can be undone from the unit card.
        </p>
      </section>

      {!finalizedAt ? (
        <section className="detail-card wh-card send-finish" aria-label="Finish up">
          <h2 className="send-title">Finish up</h2>
          <p className="muted">
            {onSite} piece{onSite === 1 ? "" : "s"} on the job site.{" "}
            {block ?? `Nothing of ${code} is left in the warehouse.`}
          </p>
          <div className="wh-actions">
            {block ? (
              <button className="button-like" disabled={boneyard.isPending} onClick={() => boneyard.mutate()}>
                {boneyard.isPending ? "Moving…" : "Move leftovers to the Boneyard"}
              </button>
            ) : null}
            <button
              className="button-like active-pill"
              disabled={!!block || !lead || finalize.isPending || loading}
              title={block ?? (lead ? "Close this job's material story; it moves to warehouse history" : "A foreman or above finalizes")}
              onClick={() => finalize.mutate()}
            >
              {finalize.isPending ? "Finalizing…" : "Unit Movement Finalized"}
            </button>
          </div>
          {!lead ? <p className="muted">A foreman or above finalizes a job.</p> : null}
          <p className="muted">
            <Link to={scopeHref({ projectId, pendingName: null })}>Open {code}'s materials ledger</Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}
