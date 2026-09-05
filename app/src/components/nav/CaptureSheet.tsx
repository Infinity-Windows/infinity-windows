// The one Capture button's sheet — the owner's ask, 2026-09-05: "a capture
// button like in horizon solar where someone can upload receipts or do a daily
// log … you should see the capture button on every tab and view through the
// app, it should also be able to capture a photo and assign it to a job, in
// fact, thats how the receipt should work too."
//
// TWO THINGS ABOUT THIS SHEET ARE DELIBERATE AND EASY TO UNDO BY ACCIDENT.
//
// 1. Photo, receipt and daily log OPEN IN PLACE. They used to navigate to
//    /photos?…&capture=1, which threw away whatever screen the person was on —
//    a foreman halfway through a unit sheet lost it to snap a receipt. The
//    deep links still work (the Photos page still reads ?capture=1, and
//    e2e/receipts.spec.ts drives them), they are just no longer how the button
//    gets there.
//
// 2. The job is asked for BEFORE the camera, not after. Horizon hides its two
//    photo actions entirely until a project is known; we ask instead, with an
//    explicit "No job — general" answer, because the owner's ask is that
//    photos get assigned and a hidden button teaches nobody why.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  FolderOpen,
  NotebookPen,
  Receipt,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { listProjects } from "../../lib/api";
import { listRecentJobs } from "../../lib/timeclock";
import { listMyPublished } from "../../lib/schedule/api";
import { useClock } from "../../lib/clockContext";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useT, type TKey } from "../../lib/i18n";
import { isForemanPlus } from "../../lib/install/types";
import type { CrewRole } from "../../lib/install/types";
import { PhotoCaptureSheet } from "../PhotoCaptureSheet";
import { DailyLogDialog } from "../dailyLogs/DailyLogDialog";
import { localDateISO } from "../../lib/dailyLogDay";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface CaptureSheetProps {
  open: boolean;
  onClose: () => void;
  /** What the UI shows — effectiveRole, so a "view as installer" preview sees
   * the installer's tiles. The server is the real gate either way. */
  role: CrewRole | string | null | undefined;
}

/** Which flow is on screen instead of the tile grid. */
type Flow = "photo" | "receipt" | "dailyLog" | "photoDone" | null;

type TileKey = "photo" | "receipt" | "daily-log" | "gallery" | "scan";

interface CaptureTile {
  key: TileKey;
  labelKey: TKey;
  hintKey: TKey;
  Icon: LucideIcon;
  /** Hidden entirely for a role the server would refuse. */
  foremanPlusOnly?: boolean;
  /**
   * How much this tile needs a job before it can start.
   *
   * "none"     — it asks later, or does not care. A receipt's own follow-up
   *              question is the job question, and it is better placed there:
   *              the photo is already safely queued by then, so nothing is
   *              lost if the person walks away mid-answer.
   * "asks"     — ask once, and "No job — general" is a real answer. A photo
   *              with no job lands in the unassigned feed, which is a normal
   *              place for it to be.
   * "required" — no job, no write. file_daily_log takes a project and will
   *              refuse without one, so offering "No job" here would be a
   *              button that cannot work.
   */
  job: "none" | "asks" | "required";
}

/**
 * The five things a person captures in the field, in the order they happen.
 *
 * "Daily log" is foreman+ and hidden — not disabled — for an installer. That
 * is the settled Q6/Q7 decision, enforced by daily_logs' own RLS: installers
 * never see a log, so a tile that greys out would only advertise a door that
 * does not exist for them.
 */
const TILES: CaptureTile[] = [
  {
    key: "photo",
    labelKey: "capture.tile.photo",
    hintKey: "capture.tile.photoHint",
    Icon: Camera,
    job: "asks",
  },
  {
    key: "receipt",
    labelKey: "capture.tile.receipt",
    hintKey: "capture.tile.receiptHint",
    Icon: Receipt,
    job: "none",
  },
  {
    key: "daily-log",
    labelKey: "capture.tile.dailyLog",
    hintKey: "capture.tile.dailyLogHint",
    Icon: NotebookPen,
    foremanPlusOnly: true,
    job: "required",
  },
  {
    key: "gallery",
    labelKey: "capture.tile.gallery",
    hintKey: "capture.tile.galleryHint",
    Icon: FolderOpen,
    job: "none",
  },
  {
    key: "scan",
    labelKey: "capture.tile.scan",
    hintKey: "capture.tile.scanHint",
    Icon: ScanLine,
    job: "none",
  },
];

/** A job offered as a chip, with the reason it is being offered. */
interface JobChip {
  projectId: string;
  label: string;
  reason: string;
}

/** Quick-capture sheet opened by the Capture (+) FAB and the desktop rail. */
export function CaptureSheet({ open, onClose, role }: CaptureSheetProps) {
  const t = useT();
  const navigate = useNavigate();
  const { profileId, shift } = useClock();
  const [selectedId, setSelectedId] = useState<string>("");
  /** The person answered "no job" out loud, so stop asking. */
  const [noJob, setNoJob] = useState(false);
  const [search, setSearch] = useState("");
  const [showList, setShowList] = useState(false);
  const [flow, setFlow] = useState<Flow>(null);
  /** A tile waiting on the job question before it can start. */
  const [pending, setPending] = useState<TileKey | null>(null);
  const [queued, setQueued] = useState(0);
  const primedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  // The trap follows the TILE view only: each flow below renders its own
  // dialog with its own trap, and two traps fighting over Tab is worse than
  // none. `flow` being set means the tile grid is not on screen.
  const showingTiles = flow === null || flow === "photoDone";
  useFocusTrap(sheetRef, open && showingTiles, onClose);

  const canLog = isForemanPlus(role);

  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId!),
    enabled: open && Boolean(profileId),
  });
  const todayISO = todayLocalISO();
  const scheduledToday = useQuery({
    queryKey: ["mySchedule", profileId, todayISO, todayISO],
    queryFn: () => listMyPublished(profileId!, todayISO, todayISO),
    enabled: open && Boolean(profileId),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setNoJob(false);
      setSearch("");
      setShowList(false);
      setFlow(null);
      setPending(null);
      setQueued(0);
      primedRef.current = false;
    }
  }, [open]);

  // Default the capture context to today's job — the open shift you're on, or
  // today's published assignment — so captures land on the right job by
  // default. The open shift still wins over every chip below it: a person
  // standing on a job clocked into it, and that is the strongest signal the
  // app has about where they are.
  useEffect(() => {
    if (!open || primedRef.current) return;
    const todayJob = shift?.project_id ?? scheduledToday.data?.[0]?.project_id ?? null;
    if (todayJob) {
      primedRef.current = true;
      setSelectedId(todayJob);
    }
  }, [open, shift?.project_id, scheduledToday.data]);

  const filtered = useMemo(() => {
    const list = projects.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      `${p.job_code} ${p.name} ${p.address ?? ""}`.toLowerCase().includes(q),
    );
  }, [projects.data, search]);

  const selected = (projects.data ?? []).find((p) => p.id === selectedId);
  const projectId = selectedId || null;
  const jobLabel = selected ? `${selected.job_code} — ${selected.name}` : null;

  /**
   * The chips under the job question. Each carries the reason it is on screen,
   * because a suggestion with no reason is one more thing to double-check —
   * the same rule the receipt follow-up's own suggestions already follow.
   */
  const chips = useMemo<JobChip[]>(() => {
    const out: JobChip[] = [];
    const seen = new Set<string>();
    const push = (projectId: string, label: string, reason: string) => {
      if (!projectId || seen.has(projectId)) return;
      seen.add(projectId);
      out.push({ projectId, label, reason });
    };
    for (const r of recents.data ?? []) {
      push(r.projectId, r.jobCode || r.name, t("capture.job.reason.recent"));
    }
    return out;
  }, [recents.data, t]);

  const startFlow = (key: TileKey, pid: string | null) => {
    setPending(null);
    if (key === "photo") return setFlow("photo");
    if (key === "receipt") return setFlow("receipt");
    if (key === "daily-log") return setFlow("dailyLog");
    if (key === "gallery") {
      navigate(pid ? `/photos?project=${pid}` : "/photos");
      return onClose();
    }
    navigate("/scan");
    onClose();
  };

  const tapTile = (tile: CaptureTile) => {
    // The one question worth asking before the camera. A photo asks once and
    // takes "No job" for an answer; a daily log keeps asking until it has a
    // real job, because the server has no way to file one without.
    const needsAnswer =
      !projectId && (tile.job === "required" || (tile.job === "asks" && !noJob));
    if (needsAnswer) {
      setPending(tile.key);
      setShowList(true);
      return;
    }
    startFlow(tile.key, projectId);
  };

  /** Picking a job answers whatever question was waiting on it. */
  const chooseJob = (pid: string | null) => {
    setSelectedId(pid ?? "");
    setNoJob(pid == null);
    setShowList(false);
    const waiting = pending;
    if (!waiting) return;
    // "No job" cannot start a tile that requires one — the question stays up.
    if (pid == null && TILES.find((x) => x.key === waiting)?.job === "required") return;
    startFlow(waiting, pid);
  };

  if (!open) return null;

  // ---- The flows, each replacing the tile grid rather than stacking on it --

  if (flow === "photo" || flow === "receipt") {
    return (
      <PhotoCaptureSheet
        mode="job"
        kind={flow === "receipt" ? "receipt" : "photo"}
        projectId={projectId}
        label={selected?.job_code ?? null}
        // The job here was primed from the open shift, not typed by the
        // person — so the receipt's follow-up still asks, with this filled in.
        jobChangeable
        onQueued={() => setQueued((n) => n + 1)}
        onClose={() => {
          // A receipt closes the whole sheet: its own follow-up question is
          // the confirmation. A photo earns one more beat — "it's saved,
          // here's where it went" — so the person can see it landed.
          if (flow === "photo" && queued > 0) return setFlow("photoDone");
          onClose();
        }}
      />
    );
  }

  if (flow === "dailyLog" && projectId) {
    return (
      <DailyLogDialog
        projectId={projectId}
        logDate={localDateISO()}
        jobLabel={jobLabel ?? selected?.name ?? ""}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className="capture-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label={t("capture.title")}
      >
        <div className="capture-grip" aria-hidden />
        <div className="capture-head">
          <h2 className="capture-title">{t("capture.title")}</h2>
          <button
            type="button"
            className="capture-close"
            aria-label={t("capture.a11y.close")}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        {flow === "photoDone" ? (
          <div className="capture-done">
            <p className="ok">
              {queued === 1
                ? t("capture.photo.queuedOne")
                : t("capture.photo.queuedMany", { n: queued })}
            </p>
            <p className="muted">
              {jobLabel ? t("capture.photo.toJob", { job: jobLabel }) : t("capture.photo.toNoJob")}
            </p>
            <div className="capture-grid">
              <button
                type="button"
                className="capture-tile"
                onClick={() => {
                  navigate(projectId ? `/photos?project=${projectId}` : "/photos");
                  onClose();
                }}
              >
                <span className="capture-tile-icon">
                  <FolderOpen size={22} />
                </span>
                <span className="capture-tile-text">
                  <span className="capture-tile-label">{t("capture.photo.seeGallery")}</span>
                </span>
              </button>
              <button type="button" className="capture-tile" onClick={() => setFlow("photo")}>
                <span className="capture-tile-icon">
                  <Camera size={22} />
                </span>
                <span className="capture-tile-text">
                  <span className="capture-tile-label">{t("capture.photo.another")}</span>
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Job context — suggestion chips with reasons, then the full list */}
            <div className="capture-project">
              <p className="capture-project-label">
                {selected
                  ? t("capture.job.forJob")
                  : pending === "daily-log"
                    ? t("capture.job.pickForLog")
                    : pending
                      ? t("capture.job.pickForPhoto")
                      : t("capture.job.which")}
              </p>
              {selected ? (
                <button
                  type="button"
                  className="capture-project-current"
                  onClick={() => {
                    setSelectedId("");
                    setNoJob(false);
                    setShowList(true);
                  }}
                >
                  <strong>{selected.job_code}</strong> · {selected.name}
                  <span className="capture-project-change">{t("capture.job.change")}</span>
                </button>
              ) : (
                <>
                  {chips.length > 0 && (
                    <div className="capture-chip-row">
                      {chips.map((c) => (
                        <button
                          key={c.projectId}
                          type="button"
                          className="capture-chip"
                          onClick={() => chooseJob(c.projectId)}
                        >
                          {c.label}
                          <span className="capture-chip-reason">{c.reason}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="capture-project-row">
                    <button
                      type="button"
                      className="capture-list-toggle"
                      onClick={() => setShowList((v) => !v)}
                    >
                      <Search size={14} aria-hidden />{" "}
                      {showList ? t("capture.job.hideList") : t("capture.job.find")}
                    </button>
                    {/* An explicit answer, not an absence of one. A photo with
                        no job is a real thing (the unassigned feed) and saying
                        so out loud beats leaving the question hanging. Hidden
                        for the daily log, which cannot be filed without a job. */}
                    {pending !== "daily-log" && (
                      <button
                        type="button"
                        className="capture-list-toggle"
                        onClick={() => chooseJob(null)}
                      >
                        {t("capture.job.none")}
                      </button>
                    )}
                  </div>
                  {showList && (
                    <div className="capture-picker">
                      <input
                        className="capture-search"
                        placeholder={t("capture.job.search")}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label={t("capture.job.a11ySearch")}
                      />
                      <div className="capture-project-list">
                        {filtered.slice(0, 30).map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className="capture-project-item"
                            onClick={() => chooseJob(p.id)}
                          >
                            <span className="capture-project-code">{p.job_code}</span>
                            <span className="capture-project-name">{p.name}</span>
                          </button>
                        ))}
                        {filtered.length === 0 && (
                          <p className="muted">{t("capture.job.noMatch", { q: search })}</p>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="capture-grid">
              {TILES.filter((tile) => !tile.foremanPlusOnly || canLog).map((tile) => (
                <button
                  key={tile.key}
                  type="button"
                  className="capture-tile"
                  onClick={() => tapTile(tile)}
                >
                  <span className="capture-tile-icon">
                    <tile.Icon size={22} />
                  </span>
                  <span className="capture-tile-text">
                    <span className="capture-tile-label">{t(tile.labelKey)}</span>
                    <span className="capture-tile-hint">{t(tile.hintKey)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
