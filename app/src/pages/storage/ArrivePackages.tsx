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
import { listProjects, listProjectsAnyStatus } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { StationChip } from "../../components/warehouse/StationChip";
import { Explain } from "../../components/ui/Explain";
import { PhotoCaptureSheet } from "../../components/PhotoCaptureSheet";
import { enqueueIssuePhoto } from "../../lib/offline/outbox";
import { playErrorTone, playSuccessTone } from "../../lib/sound";
import { STATION_OFF_TRUCK } from "../../lib/warehouse/stations";
import {
  arrivePackages,
  categoryLabel,
  damagePhotoPath,
  ISSUE_PHOTOS_BUCKET,
  listActivePackages,
  partLabel,
} from "../../lib/storage";
import { useT } from "../../lib/i18n";

type Verdict = "ok" | "damaged";

export function ArrivePackages() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Finished jobs keep naming their material (owner ask, 2026-08-26): the
  // NAME map reads every job; any picker on this page stays active-only.
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const [projectId, setProjectId] = useState(params.get("job") ?? "");
  const [verdicts, setVerdicts] = useState<Map<string, Verdict>>(new Map());
  const [note, setNote] = useState("");
  // Per-package, not per-submission (ticket 11) — one shared note covering
  // six broken packages is already the weak part of this screen, and one
  // shared photo would be worse. Keyed by package id; a package that never
  // gets marked Damaged just never gets an entry.
  const [photos, setPhotos] = useState<Map<string, File>>(new Map());

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);

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

  const setPhoto = (id: string, file: File) =>
    setPhotos((prev) => new Map(prev).set(id, file));

  const submit = useMutation({
    mutationFn: async () => {
      // Photos are queued BEFORE arrive_packages is called, never after.
      // arrive_packages should only ever be told about a path something has
      // actually promised to deliver bytes to — not one whose upload might
      // never even reach the queue (too large, offline storage full). A
      // photo that fails here does not block the report itself: damage
      // reported with no picture beats damage never reported.
      const photoPaths: Record<string, string> = {};
      const photoFailures: string[] = [];
      for (const id of damaged) {
        const file = photos.get(id);
        if (!file) continue;
        const path = damagePhotoPath(projectId, id, Date.now());
        try {
          await enqueueIssuePhoto({
            bucket: ISSUE_PHOTOS_BUCKET,
            path,
            contentType: file.type || "image/jpeg",
            blob: file,
          });
          photoPaths[id] = `${ISSUE_PHOTOS_BUCKET}/${path}`;
        } catch (e) {
          photoFailures.push(formatApiError(e));
        }
      }
      await arrivePackages({
        okIds: ok,
        damagedIds: damaged,
        projectId,
        note: note || null,
        photos: photoPaths,
      });
      return { photoFailures };
    },
    onSuccess: ({ photoFailures }) => {
      playSuccessTone();
      pushToast(
        damaged.length > 0
          ? t(damaged.length === 1 ? "storage.arrive.logged.damagedOne" : "storage.arrive.logged.damagedMany", { n: damaged.length })
          : t(ok.length === 1 ? "storage.arrive.logged.goodOne" : "storage.arrive.logged.goodMany", { n: ok.length }),
      );
      if (photoFailures.length > 0) {
        pushToast(
          t(photoFailures.length === 1 ? "storage.arrive.photoFail.one" : "storage.arrive.photoFail.many", {
            n: photoFailures.length,
            reason: photoFailures[0],
          }),
          "error",
        );
      }
      setVerdicts(new Map());
      setNote("");
      setPhotos(new Map());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["issues"] });
      navigate("/warehouse");
    },
    onError: (e) => {
      playErrorTone();
      pushToast(formatApiError(e), "error");
    },
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{t("storage.arrive.storage")}</p>
          <h1>{t("storage.arrive.title")}</h1>
        </div>
      </header>
      <StationChip station={STATION_OFF_TRUCK} />

      <Explain id="arrival-check">{t("storage.arrive.explain")}</Explain>

      <h2>{t("storage.arrive.whichJob")}</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">{t("storage.arrive.pickJob")}</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>

      {projectId && (
        <>
          <h2>{t("storage.arrive.whatTurnedUp", { n: outForJob.length })}</h2>
          <div className="home-projects">
            {outForJob.map((p) => {
              const v = verdicts.get(p.id);
              return (
                <div key={p.id} className="project-card home-project">
                  <div className="home-project-head">
                    <div className="wh-row-main">
                      <div className="wh-row-title">
                        {p.short_code ?? p.serial}
                      </div>
                      <div className="wh-row-sub">
                        {partLabel(p, t) ?? t("storage.arrive.noPartNumber")}
                        {p.category ? ` · ${categoryLabel(p.category, t)}` : ""}
                        {(p.package_marks ?? []).length > 0 &&
                          ` · ${t("storage.arrive.marks", { marks: (p.package_marks ?? []).map((m) => m.mark_code).join(", ") })}`}
                      </div>
                    </div>
                    <div className="row-gap">
                      <button
                        className={v === "ok" ? "button-like active-pill" : "button-like"}
                        onClick={() => set(p.id, "ok")}
                      >
                        {t("storage.arrive.good")}
                      </button>
                      <button
                        className={v === "damaged" ? "button-like active-pill" : "button-like"}
                        onClick={() => set(p.id, "damaged")}
                      >
                        {t("storage.arrive.damaged")}
                      </button>
                    </div>
                  </div>
                  {v === "damaged" && (
                    <div style={{ marginTop: 8 }}>
                      <PhotoCaptureSheet
                        mode="single"
                        value={photos.get(p.id) ?? null}
                        onChange={(file) => setPhoto(p.id, file)}
                        label={p.short_code ?? p.serial}
                        prompt={t("storage.arrive.photoPrompt")}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {outForJob.length === 0 && (
              <p className="muted">
                {t("storage.arrive.nothingCheckedOut", { job: jobCode.get(projectId) ?? t("storage.arrive.thisJob") })}
              </p>
            )}
          </div>

          <label className="field-label">{t("storage.arrive.noteOptional")}</label>
          <input
            placeholder={t("storage.arrive.notePlaceholder")}
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
                ? t("storage.arrive.logging")
                : t("storage.arrive.logButton", { total: verdicts.size, damaged: damaged.length })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
