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
//    photo actions entirely until a project is known; we ask instead, because
//    the owner's ask is that photos get assigned and a hidden button teaches
//    nobody why. The question has no "no job" answer for a photo: an
//    attachment must hang off something (attachments_target), and a photo that
//    hangs off nothing is a row the database refuses — see TILES below.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import { useNearbyJob } from "../../lib/capture/useNearbyJob";
import { projectIdFromPath } from "../../lib/capture/routeJob";
import { readLastCaptureJob, writeLastCaptureJob } from "../../lib/capture/lastJob";

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
   *              lost if the person walks away mid-answer. A receipt with no
   *              job is a real, filable row — `receipts.project_id` is
   *              nullable, and gas gets bought before anybody knows the job.
   * "required" — no job, no write, and the sheet keeps asking. Both tiles
   *              that carry this have a server that cannot take the write
   *              without one: `file_daily_log` takes a project and refuses
   *              without it, and an `attachments` row must hang off something
   *              (`attachments_target`) — a photo with every target column
   *              null is a check violation no retry ever fixes.
   */
  job: "none" | "required";
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
    job: "required",
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
  const { pathname } = useLocation();
  const { profileId, shift } = useClock();
  const [selectedId, setSelectedId] = useState<string>("");
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
  useFocusTrap(sheetRef, open && (flow === null || flow === "photoDone"), onClose);

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

  // "You're near <job>" — never blocks, never waits past two seconds. Asked
  // for only while the tile grid is up; a flow that stamps photos warms its
  // own fix, and the holder is ref-counted so the watch spans both.
  const nearby = useNearbyJob(
    open && (flow === null || flow === "photoDone"),
    projects.data,
  );
  // Read once per open, not on every render: this is a device memory, and a
  // chip that changed under the person's thumb mid-decision would be worse
  // than no chip. `open` is the dependency on purpose.
  const lastJob = useMemo(() => (open ? readLastCaptureJob() : null), [open]);

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setSearch("");
      setShowList(false);
      setFlow(null);
      setPending(null);
      setQueued(0);
      primedRef.current = false;
    }
  }, [open]);

  // Default the capture context to the job in front of the person: the job
  // SCREEN they are standing on first, then the open shift, then today's
  // published assignment.
  //
  // The screen leads because this button rides every route, so it opens over a
  // job page as often as over Today — and on a job page the shift is the
  // weaker answer. A foreman clocked into job B who opens job A's page and
  // taps Capture is capturing for A; the page is a choice they just made,
  // where the open shift is a guess about where they are standing. Off a job
  // page the shift is the strongest thing the app knows and takes over.
  //
  // Primed once per opening (primedRef) and no more: Layout closes this sheet
  // on every route change, so the path cannot move under an open sheet, and a
  // job the person then picked by hand must not be overwritten by a refetch.
  useEffect(() => {
    if (!open || primedRef.current) return;
    const todayJob =
      projectIdFromPath(pathname) ??
      shift?.project_id ??
      scheduledToday.data?.[0]?.project_id ??
      null;
    if (todayJob) {
      primedRef.current = true;
      setSelectedId(todayJob);
    }
  }, [open, pathname, shift?.project_id, scheduledToday.data]);

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

  // A primed job the jobs list does not contain has to be given up, not kept
  // invisibly. `listProjects()` reads ACTIVE jobs only, and an open shift
  // carries no such filter — so a person still clocked into a job that was
  // closed or archived would otherwise capture to a job this sheet could not
  // name, on tiles that offered no way to change it. Once the list has
  // actually answered and the job is not in it, the question comes back.
  useEffect(() => {
    if (projects.isSuccess && selectedId && !selected) setSelectedId("");
  }, [projects.isSuccess, selectedId, selected]);

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
    // Where the phone actually is beats what it remembers, which beats what
    // the timesheet says. Each job appears once, under its strongest reason.
    if (nearby) push(nearby.projectId, nearby.label, t("capture.job.reason.near"));
    if (lastJob) {
      const p = (projects.data ?? []).find((x) => x.id === lastJob);
      if (p) push(p.id, p.job_code || p.name, t("capture.job.reason.last"));
    }
    for (const r of recents.data ?? []) {
      push(r.projectId, r.jobCode || r.name, t("capture.job.reason.recent"));
    }
    return out;
  }, [nearby, lastJob, projects.data, recents.data, t]);

  /** The tiles that actually record something — the only ones worth
   *  remembering a job for. Browsing the gallery is not capturing to a job,
   *  and a "Last time" chip that came from a look-around would be a lie in a
   *  chip whose whole value is that its reason is true. */
  const CAPTURES: TileKey[] = ["photo", "receipt", "daily-log"];

  const startFlow = (key: TileKey, pid: string | null) => {
    // Remembered at the moment of use, not at the moment of picking: opening
    // the list and closing it again should not change tomorrow's default.
    if (CAPTURES.includes(key)) writeLastCaptureJob(pid);
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
    // The one question worth asking before the camera, and it has no "skip"
    // for the two tiles that ask it: the server refuses both writes without a
    // job, so the question stays up until it has a real answer.
    if (!projectId && tile.job === "required") {
      setPending(tile.key);
      setShowList(true);
      return;
    }
    startFlow(tile.key, projectId);
  };

  /** Picking a job answers whatever question was waiting on it. */
  const chooseJob = (pid: string) => {
    setSelectedId(pid);
    setShowList(false);
    if (pending) startFlow(pending, pid);
  };

  if (!open) return null;

  // Neither a daily log nor a photo can be written without a job — the RPC
  // refuses one and attachments_target refuses the other — and nothing should
  // be able to reach that state (tapTile keeps asking until there is an
  // answer). If something ever does, this reads as no flow at all and the
  // picker comes back: a repeated question beats a camera with nowhere to save.
  const activeFlow: Flow =
    (flow === "dailyLog" || flow === "photo") && !projectId ? null : flow;

  // ---- The flows, each replacing the tile grid rather than stacking on it --

  if (activeFlow === "photo" || activeFlow === "receipt") {
    return (
      <PhotoCaptureSheet
        mode="job"
        kind={activeFlow === "receipt" ? "receipt" : "photo"}
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
          if (activeFlow === "photo" && queued > 0) return setFlow("photoDone");
          onClose();
        }}
      />
    );
  }

  if (activeFlow === "dailyLog" && projectId) {
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

        {activeFlow === "photoDone" ? (
          <div className="capture-done">
            <p className="ok">
              {queued === 1
                ? t("capture.photo.queuedOne")
                : t("capture.photo.queuedMany", { n: queued })}
            </p>
            <p className="muted">
              {t("capture.photo.toJob", { job: jobLabel ?? t("capture.job.yourJob") })}
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
                {selectedId
                  ? t("capture.job.forJob")
                  : pending === "daily-log"
                    ? t("capture.job.pickForLog")
                    : pending
                      ? t("capture.job.pickForPhoto")
                      : t("capture.job.which")}
              </p>
              {/* Keyed on selectedId, NOT on the row it looks up. A job primed
                  from the open shift is already the job every tile will file
                  to, and while the jobs list is still loading there is no row
                  to name it with — showing the chips in that gap would offer a
                  choice the tiles were not going to honour. */}
              {selectedId ? (
                <button
                  type="button"
                  className="capture-project-current"
                  onClick={() => {
                    setSelectedId("");
                    setShowList(true);
                  }}
                >
                  {selected ? (
                    <>
                      <strong>{selected.job_code}</strong> · {selected.name}
                    </>
                  ) : (
                    t("capture.job.yourJob")
                  )}
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
                  {/* There is deliberately no "No job — general" escape here.
                      It used to sit beside this button and it could not work:
                      a photo answering it produced an attachments row with
                      every target column null, which the database refuses
                      (attachments_target) — the picture uploaded, the row was
                      rejected, and the person was told it was filed. A receipt
                      needs no such answer: its tile never asks, because its own
                      follow-up question does, and a receipt with no job is a
                      row the receipts table takes happily. */}
                  <div className="capture-project-row">
                    <button
                      type="button"
                      className="capture-list-toggle"
                      onClick={() => setShowList((v) => !v)}
                    >
                      <Search size={14} aria-hidden />{" "}
                      {showList ? t("capture.job.hideList") : t("capture.job.find")}
                    </button>
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
