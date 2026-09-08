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
import { useNavigate, useSearchParams } from "react-router-dom";
import { listLocations, listProjects, listProjectsAnyStatus } from "../../lib/api";
import { splitLines } from "../../lib/warehouse/splitUnits";
import { PackageRowText } from "../../components/warehouse/PackageRowText";
import { toLocationsById } from "../../lib/warehouse/containment";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import {
  checkoutPackagesOffline,
  stagePackagesOffline,
  writeToast,
} from "../../lib/warehouse/offlineWrites";
import { BackChip } from "../../components/BackChip";
import { StationChip } from "../../components/warehouse/StationChip";
import {
  listActivePackages,
  listCheckoutReasons,
  listContainers,
  mismatchedPackages,
} from "../../lib/storage";
import { isMissingStagingBayError } from "../../lib/staging";
import { STATION_OUT_DOOR } from "../../lib/warehouse/stations";
import { useT, type TFn } from "../../lib/i18n";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate, type Lang } from "../../lib/i18n/translate";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

/**
 * The mismatch warning, per mode — because the two modes do different things
 * to the package and the warning used to claim only one of them.
 *
 * Check out ends the trail: the package leaves the building. Set aside does
 * not — `stage_packages` moves it onto THIS job's staging bay and leaves it on
 * hand, so "before it leaves" was simply untrue in staging mode. Reworded, not
 * gated: staging is undone by re-staging or by scanning the package back into
 * a conex, so a warning is the whole cost of getting it wrong.
 */
export function mismatchWarning(mode: "stage" | "out", t: TFn = englishT): string {
  return t(mode === "stage" ? "storage.checkout.mismatch.stage" : "storage.checkout.mismatch.out");
}

export function CheckoutPackages() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  // Racks and bays, so a split line can say "staged for BLACK22" by name.
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Finished jobs keep naming their material (owner ask, 2026-08-26): the
  // NAME map reads every job; any picker on this page stays active-only.
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const reasons = useQuery({ queryKey: ["checkoutReasons"], queryFn: listCheckoutReasons });
  // `?ids=a,b` arrives pre-picked from the scan sheet's "Check out" (wave 2):
  // the person already scanned what they are taking; this screen only asks why
  // and for which job.
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((params.get("ids") ?? "").split(",").filter(Boolean)),
  );
  const [reason, setReason] = useState("");
  const [otherNote, setOtherNote] = useState("");
  const [projectId, setProjectId] = useState("");
  const [containerFilter, setContainerFilter] = useState("");
  const [mode, setMode] = useState<"stage" | "out">("out");

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);

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
  // Splitting a unit warns, never blocks (ticket 19): taking SOME of a
  // window's parts and leaving the rest is sometimes the job — the line just
  // makes sure it is never an accident.
  const splits = useMemo(
    () =>
      splitLines(
        picked,
        packages.data ?? [],
        new Map((containers.data ?? []).map((c) => [c.id, c])),
        toLocationsById(locations.data ?? []),
        t,
      ),
    [picked, packages.data, containers.data, locations.data, t],
  );
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

  // The rows behind the ticks, for the note a queued set-aside has to carry:
  // what this phone believed about each package at the moment it was ticked.
  // Without it, a set-aside that sits in a conex for ten minutes lands on top
  // of a checkout made one minute ago and records the package on this job's
  // shelf while it is on a truck to another one.
  //
  // Taken from the WHOLE list and not from `available`: `available` is filtered
  // by the container dropdown, so changing that filter after ticking would
  // quietly drop packages out of the write instead of setting them aside.
  const pickedBeliefs = useMemo(
    () => (packages.data ?? []).filter((p) => picked.has(p.id)),
    [packages.data, picked],
  );

  const stage = useMutation({
    mutationFn: () => stagePackagesOffline(pickedBeliefs, projectId),
    onSuccess: (r) => {
      pushToast(
        writeToast(
          r,
          t(r.count === 1 ? "storage.checkout.setAside.one" : "storage.checkout.setAside.many", { n: r.count }),
          t,
        ),
      );
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      navigate("/warehouse");
    },
    onError: (e) => {
      // The server refuses rather than using a shared stock shelf — say what
      // to do instead of showing the raw refusal.
      pushToast(
        isMissingStagingBayError(e) ? t("storage.checkout.noBayYet") : formatApiError(e),
        "error",
      );
    },
  });

  const submit = useMutation({
    mutationFn: () => checkoutPackagesOffline([...picked], finalReason, projectId),
    onSuccess: (r) => {
      pushToast(
        writeToast(r, t(r.count === 1 ? "storage.checkout.checkedOut.one" : "storage.checkout.checkedOut.many", { n: r.count }), t),
      );
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      navigate("/warehouse");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{t("storage.checkout.storage")}</p>
          <h1>{mode === "stage" ? t("storage.checkout.setAsideTitle") : t("storage.checkout.checkOutTitle")}</h1>
        </div>
      </header>
      <StationChip station={STATION_OUT_DOOR} />

      <div className="row-gap">
        <button
          className={mode === "stage" ? "button-like active-pill" : "button-like"}
          onClick={() => setMode("stage")}
        >
          {t("storage.checkout.setAsideStaging")}
        </button>
        <button
          className={mode === "out" ? "button-like active-pill" : "button-like"}
          onClick={() => setMode("out")}
        >
          {t("storage.checkout.checkOutButton")}
        </button>
      </div>
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
        {mode === "stage" ? t("storage.checkout.stageHint") : t("storage.checkout.outHint")}
      </p>

      <h2>{t("storage.checkout.step1", { n: picked.size })}</h2>
      <select
        value={containerFilter}
        onChange={(e) => setContainerFilter(e.target.value)}
      >
        <option value="">{t("storage.checkout.allContainers")}</option>
        {(containers.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <div className="home-projects" style={{ marginTop: 6 }}>
        {available.map((p) => {
          const on = picked.has(p.id);
          const where =
            (containers.data ?? []).find((c) => c.id === p.container_id)?.name ??
            t("storage.checkout.notStoredYet");
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
                <PackageRowText p={p} jobCode={jobCode} extra={where} />
                <span style={{ fontSize: 20 }}>{on ? "☑" : "☐"}</span>
              </div>
            </button>
          );
        })}
        {available.length === 0 && <p className="muted">{t("storage.checkout.nothingInStorage")}</p>}
      </div>

      {mode === "out" && (
        <>
      <h2>{t("storage.checkout.step2Why")}</h2>
      <div className="row-gap">
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
          placeholder={t("storage.checkout.sayWhy")}
          value={otherNote}
          onChange={(e) => setOtherNote(e.target.value)}
        />
      )}

        </>
      )}

      <h2>{mode === "out" ? t("storage.checkout.step3ToJob") : t("storage.checkout.step2WhichJob")}</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">
          {suggestedProject
            ? t("storage.checkout.pickJobSuggested", { job: jobCode.get(suggestedProject) ?? "?" })
            : t("storage.checkout.pickJob")}
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
          {t("storage.checkout.use", { job: jobCode.get(suggestedProject) ?? "?" })}
        </button>
      )}

      {mismatched.length > 0 && (
        <p className="warn" style={{ color: "#b8860b", fontSize: 13 }}>
          ⚠ {t(mismatched.length === 1 ? "storage.checkout.mismatched.one" : "storage.checkout.mismatched.many", {
            n: mismatched.length,
            list: mismatched
              .map((p) => `${p.serial}→${jobCode.get(p.project_id ?? "") ?? "?"}`)
              .slice(0, 4)
              .join(", "),
          })}{" "}
          {mismatchWarning(mode, t)}
        </p>
      )}

      {splits.length > 0 && (
        <div className="detail-card wh-card">
          {splits.map((line) => (
            <p key={line} style={{ margin: "4px 0", fontSize: 13.5 }}>
              {line}
            </p>
          ))}
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            {t("storage.checkout.splitHint")}
          </p>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {mode === "stage" ? (
          <button
            className="button-like active-pill"
            disabled={picked.size === 0 || !projectId || stage.isPending}
            onClick={() => stage.mutate()}
          >
            {stage.isPending ? t("storage.checkout.settingAside") : t("storage.checkout.setAsideN", { n: picked.size })}
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
            {submit.isPending ? t("storage.checkout.checkingOut") : t("storage.checkout.checkOutN", { n: picked.size })}
          </button>
        )}
      </div>
    </div>
  );
}
