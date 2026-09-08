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
import { useT } from "../../lib/i18n";

export const SENT_TO_SITE_REASON = "Sent to job site";

// A stable empty list, so "no packages yet" is the same array every render.
const NO_ROWS: StoragePackage[] = [];

export function SendToSite() {
  const t = useT();
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
  const units = useMemo(() => siteUnits(rows, projectId, boxesById, t), [rows, projectId, boxesById, t]);
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
      pushToast(writeToast(r, t(r.count === 1 ? "storage.sendToSite.onSite.one" : "storage.sendToSite.onSite.many", { n: r.count }), t));
      refresh();
      setStaying(new Set());
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const boneyard = useMutation({
    mutationFn: () => boneyardJobLeftovers(projectId),
    onSuccess: (n) => {
      pushToast(t(n === 1 ? "storage.sendToSite.movedBoneyard.one" : "storage.sendToSite.movedBoneyard.many", { n }));
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
      pushToast(t("storage.sendToSite.finalized", { job: job?.job_code ?? t("storage.sendToSite.jobFallback") }));
      refresh();
      navigate("/warehouse/history");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const reopen = useMutation({
    mutationFn: () => reopenJobMaterials(projectId),
    onSuccess: () => {
      pushToast(t("storage.sendToSite.reopened", { job: job?.job_code ?? t("storage.sendToSite.jobFallback") }));
      refresh();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  if (projects.isSuccess && !job) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">{t("storage.sendToSite.notFound")}</p>
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
          <h1>{t("storage.sendToSite.h1", { job: code })}</h1>
        </div>
      </header>

      {finalizedAt ? (
        <section className="detail-card wh-card send-finalized" aria-label={t("storage.sendToSite.finalizedAria")}>
          <p className="send-finalized-head">
            {t("storage.sendToSite.finalizedOn", { date: finalizedAt.slice(0, 10) })}
          </p>
          <p className="muted">
            {t("storage.sendToSite.hiddenListed.pre")}
            <Link to="/warehouse/history">{t("storage.sendToSite.hiddenListed.link")}</Link>
            {t("storage.sendToSite.hiddenListed.post")}
            {onSite > 0 ? ` ${t(onSite === 1 ? "storage.sendToSite.onSiteCount.one" : "storage.sendToSite.onSiteCount.many", { n: onSite })}` : ""}
          </p>
          {lead ? (
            <button className="button-like" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              {reopen.isPending ? t("storage.sendToSite.reopening") : t("storage.sendToSite.reopenButton")}
            </button>
          ) : (
            <p className="muted">{t("storage.sendToSite.foremanReopens")}</p>
          )}
        </section>
      ) : null}

      <section aria-label={t("storage.sendToSite.unitsHereAria")}>
        <div className="wh-row">
          <h2 className="send-title">{t("storage.sendToSite.readyToGo")}</h2>
          {units.length > 0 ? (
            <div className="wh-actions">
              <button
                className="button-like"
                onClick={() => setStaying(staying.size === units.length ? new Set() : new Set(units.map((u) => u.key)))}
              >
                {staying.size === units.length ? t("storage.sendToSite.sendAll") : t("storage.sendToSite.keepAll")}
              </button>
            </div>
          ) : null}
        </div>
        {loading ? (
          <p className="muted">{t("storage.sendToSite.loading")}</p>
        ) : units.length === 0 ? (
          <p className="muted">
            {t("storage.sendToSite.nothingHere", { job: code })}
            {onSite > 0 ? ` ${t(onSite === 1 ? "storage.sendToSite.alreadyOnSite.one" : "storage.sendToSite.alreadyOnSite.many", { n: onSite })}` : ""}
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
                      aria-label={t("storage.sendToSite.goesToSite", { label: u.label })}
                    />
                    <span className="send-unit-main">
                      <span className="send-unit-name">{u.label}</span>
                      <span className="send-unit-sub">
                        {t(u.here === 1 ? "storage.sendToSite.piece.one" : "storage.sendToSite.piece.many", { n: u.here })} · {u.places.join(", ")}
                      </span>
                    </span>
                    <span className={`send-unit-tag${goes ? "" : " send-unit-tag--stays"}`}>
                      {goes ? t("storage.sendToSite.goes") : t("storage.sendToSite.stays")}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {units.length > 0 ? (
          <div className="send-bar">
            <span>{sendSummary(units, staying, t)}</span>
            <button
              className="button-like active-pill"
              disabled={going.length === 0 || send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? t("storage.sendToSite.moving") : t("storage.sendToSite.moveToSite")}
            </button>
          </div>
        ) : null}
        <p className="muted send-hint">
          {t("storage.sendToSite.hint", { reason: SENT_TO_SITE_REASON })}
        </p>
      </section>

      {!finalizedAt ? (
        <section className="detail-card wh-card send-finish" aria-label={t("storage.sendToSite.finishUpAria")}>
          <h2 className="send-title">{t("storage.sendToSite.finishUp")}</h2>
          <p className="muted">
            {t(onSite === 1 ? "storage.sendToSite.onSiteCount.one" : "storage.sendToSite.onSiteCount.many", { n: onSite })}{" "}
            {block ?? t("storage.sendToSite.nothingLeft", { job: code })}
          </p>
          <div className="wh-actions">
            {block ? (
              <button className="button-like" disabled={boneyard.isPending} onClick={() => boneyard.mutate()}>
                {boneyard.isPending ? t("storage.sendToSite.moving") : t("storage.sendToSite.moveToBoneyard")}
              </button>
            ) : null}
            <button
              className="button-like active-pill"
              disabled={!!block || !lead || finalize.isPending || loading}
              title={block ?? (lead ? t("storage.sendToSite.finalizeHintLead") : t("storage.sendToSite.finalizeHintNotLead"))}
              onClick={() => finalize.mutate()}
            >
              {finalize.isPending ? t("storage.sendToSite.finalizing") : t("storage.sendToSite.finalizeButton")}
            </button>
          </div>
          {!lead ? <p className="muted">{t("storage.sendToSite.foremanFinalizes")}</p> : null}
          <p className="muted">
            <Link to={scopeHref({ projectId, pendingName: null })}>{t("storage.sendToSite.openLedger", { job: code })}</Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}
