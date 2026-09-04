import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, ImagePlus, RefreshCw, X } from "lucide-react";
import {
  enqueueReceiptAnswer,
  enqueueReceiptCapture,
  enqueueUpload,
  subscribeSynced,
} from "../lib/offline/outbox";
import {
  capturePhotoMeta,
  stampPhoto,
  stampPhotoFile,
  toPhotoMetaFields,
  type StampMeta,
} from "../lib/photo/stampPhoto";
import { supabase } from "../lib/supabase";
import { formatApiError } from "../lib/errors";
import { pushToast } from "../lib/toast";
import { useClock } from "../lib/clockContext";
import { useT } from "../lib/i18n";
import { listProjects } from "../lib/api";
import { getClockCostCodesForProject } from "../lib/costCodes";
import {
  extractReceipt,
  listThisWeekJobSuggestions,
  receiptPhotoPath,
  type JobSuggestion,
} from "../lib/receipts";

export interface BeforeAfterValue {
  before: File | null;
  after: File | null;
  /** Capture metadata (GPS + timestamp) burned into each shot, for persistence. */
  beforeMeta?: StampMeta | null;
  afterMeta?: StampMeta | null;
}

type PhotoCaptureSheetProps =
  | {
      mode: "job";
      projectId: string | null;
      /** Watermark label (e.g. the job code) burned into each shot. */
      label?: string | null;
      /** Receipts store as attachments.kind 'document' but still get watermarked. */
      kind?: "photo" | "receipt";
      onClose: () => void;
      /** Fired after at least one photo is queued, so the feed can refetch. */
      onQueued?: () => void;
    }
  | {
      mode: "beforeAfter";
      value: BeforeAfterValue;
      onChange: (next: BeforeAfterValue) => void;
      /** Optional job/opening label burned into the watermark. */
      label?: string | null;
      /**
       * Which slots to offer. The Check stage shows only ["before"] — the
       * before photo is captured while "before" still exists — and Capture
       * keeps both so a bad first shot can be retaken.
       */
      slots?: ("before" | "after")[];
    }
  | {
      /**
       * One stamped shot handed back to the caller — the phase-proof camera
       * (flashing photos). Same live rear camera, same GPS + timestamp
       * watermark, same file-picker fallback as everything else.
       */
      mode: "single";
      value: File | null;
      onChange: (file: File) => void;
      label?: string | null;
      /** Button copy, e.g. "Photo of the finished flashing". */
      prompt: string;
      /**
       * Wave O: burn the GPS + timestamp watermark in, or don't. Defaults to
       * true, which is every existing caller — a phase-proof photo is evidence
       * about a place and a time, and the stamp IS the proof.
       *
       * A photo of an OSHA card is the opposite: it is a picture of a piece of
       * paper somebody is holding, the stamp says nothing true about the card,
       * and burning a GPS fix onto a document that already carries a full legal
       * name adds a fact nobody asked for. It also costs a location lookup —
       * capturePhotoMeta waits up to eight seconds for a fix — for a photo
       * taken at a desk.
       */
      stamp?: boolean;
      /** Replaces the "GPS and time are added automatically" line under the
       * button, for a capture that adds neither. */
      hint?: string;
    };

/**
 * The single photo-capture surface for the whole app. `mode="job"` is the
 * general "add a job photo/receipt" bottom sheet (offline-outbox queued);
 * `mode="beforeAfter"` is the install-proof before/after pair (CompanyCam
 * pattern, ghosted alignment) fed back to the caller. Both share one camera
 * pipeline: rear-camera live capture or file picker, each shot watermarked with
 * GPS + timestamp via stampPhoto. Falls back to the file picker when the camera
 * is unavailable (desktop, denied permission, dead spot). Works offline.
 */
export function PhotoCaptureSheet(props: PhotoCaptureSheetProps) {
  if (props.mode === "beforeAfter") return <BeforeAfterCapture {...props} />;
  if (props.mode === "single") return <SinglePhotoCapture {...props} />;
  return <JobPhotoCapture {...props} />;
}

/** Start the rear camera while `active`, wiring the stream into `videoRef`. */
function useCameraStream(active: boolean, onError: (message: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const stopStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    if (!active) {
      stopStream();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        onError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return videoRef;
}

/** Grab the current video frame as a JPEG blob (0.85 quality). */
function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
  });
}

/** What the upload flow's one skippable question (P3) has settled on so far.
 * Both halves start unanswered — "everything skippable, a bare photo is a
 * valid receipt" (spec) — and Close always works regardless of what, if
 * anything, got picked. */
interface ReceiptAnswer {
  passthrough: boolean | null;
  projectId: string | null;
  pendingJobName: string | null;
  /** Wave Z: which kind of purchase this was — the same cost-code list the
   * clock offers for this job (its own subset if it has one, else the whole
   * active library, general always included). */
  costCodeId: string | null;
}

/**
 * The upload flow's one question, shown right after a receipt photo is
 * queued (P3): "Bill this to the customer?" plus the job it's for — recent-
 * this-week chips with a visible reason (the Horizon suggestion mechanism
 * the spec calls out to port), a searchable picker for anything else, and a
 * free-text fallback for a job that isn't built in the app yet (the same
 * waiting-job convention packages.pending_job_name already uses). Answering
 * either half queues ONE enqueueReceiptAnswer, dependent on the capture
 * entry so it can never race ahead of the row actually being filed.
 */
function ReceiptFollowUp({
  receiptId,
  entryId,
  presetProjectId,
  presetJobLabel,
  onClose,
}: {
  receiptId: string;
  entryId: string;
  /** Already known (the page's own job filter) — skips the job question. */
  presetProjectId: string | null;
  presetJobLabel: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const { profileId } = useClock();
  const [answer, setAnswer] = useState<ReceiptAnswer>({
    passthrough: null,
    projectId: presetProjectId,
    pendingJobName: null,
    costCodeId: null,
  });
  const [pickingJob, setPickingJob] = useState(false);
  const [search, setSearch] = useState("");
  const [waitingName, setWaitingName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const suggestions = useQuery({
    queryKey: ["receiptJobSuggestions", profileId],
    queryFn: () => listThisWeekJobSuggestions(profileId!),
    enabled: !presetProjectId && Boolean(profileId),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: pickingJob,
  });
  // Wave Z: the SAME picker logic the clock uses — the job's own cost-code
  // subset if it has one, else the whole active library, with the general
  // fallback always present and common codes first. Reused, not re-derived:
  // two lists of cost codes that could disagree is how a receipt ends up
  // filed under a code the job does not allow.
  const costCodes = useQuery({
    queryKey: ["clockCostCodes", answer.projectId || "all"],
    queryFn: () => getClockCostCodesForProject(answer.projectId),
  });

  // A code held over from the previous job may not be in the new job's subset.
  // Same guard ClockInBlock keeps for the same reason.
  useEffect(() => {
    if (!answer.costCodeId) return;
    const list = costCodes.data;
    if (!list) return;
    if (!list.some((c) => c.id === answer.costCodeId)) {
      setAnswer((a) => ({ ...a, costCodeId: null }));
    }
  }, [costCodes.data, answer.costCodeId]);

  // Fire-and-forget: the row updates when it lands (P3). The FIRST attempt
  // can beat the offline outbox's own drain — enqueueReceiptCapture returns
  // as soon as the write is durably queued, not once it has actually
  // reached the server — so extract-receipt's "no such receipt" (the row
  // isn't filed yet) is retried on every subsequent successful drain
  // (subscribeSynced) rather than treated as a real failure. Never blocks
  // the question UI and never surfaces an error to the user either way — a
  // receipt that never gets read automatically is still a valid receipt,
  // recoverable later from the office table's Re-scan.
  useEffect(() => {
    let cancelled = false;
    let done = false;
    const attempt = () => {
      if (cancelled || done) return;
      extractReceipt(receiptId)
        .then(() => {
          done = true;
        })
        .catch(() => {
          /* retried on the next sync signal */
        });
    };
    attempt();
    const unsubscribe = subscribeSynced(attempt);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [receiptId]);

  const filteredProjects = (projects.data ?? []).filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${p.job_code} ${p.name}`.toLowerCase().includes(q);
  });

  const pickSuggestion = (s: JobSuggestion) => {
    setAnswer((a) => ({ ...a, projectId: s.projectId, pendingJobName: null }));
    setPickingJob(false);
    setWaitingName("");
  };
  const pickProject = (id: string) => {
    setAnswer((a) => ({ ...a, projectId: id, pendingJobName: null }));
    setPickingJob(false);
  };
  const applyWaitingName = () => {
    const trimmed = waitingName.trim();
    setAnswer((a) => ({ ...a, projectId: null, pendingJobName: trimmed || null }));
    setPickingJob(false);
  };

  const jobLabel = () => {
    if (presetProjectId) return presetJobLabel ?? "this job";
    if (answer.pendingJobName) return `“${answer.pendingJobName}” (waiting job)`;
    if (answer.projectId) {
      const s = (suggestions.data ?? []).find((x) => x.projectId === answer.projectId);
      if (s) return `${s.jobCode} — ${s.name}`;
      const p = (projects.data ?? []).find((x) => x.id === answer.projectId);
      return p ? `${p.job_code} — ${p.name}` : "that job";
    }
    return null;
  };

  const save = async () => {
    setSaving(true);
    try {
      await enqueueReceiptAnswer({
        receiptId,
        dependsOn: entryId,
        projectId: answer.projectId,
        pendingJobName: answer.pendingJobName,
        isPassthrough: answer.passthrough,
        costCodeId: answer.costCodeId,
      });
      setSaved(true);
    } catch (e) {
      pushToast(`Couldn't save that answer — ${formatApiError(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const answeredSomething =
    answer.passthrough !== null ||
    answer.projectId !== presetProjectId ||
    answer.pendingJobName !== null ||
    answer.costCodeId !== null;

  return (
    <div className="jobphoto-followup">
      <p className="ok jobphoto-count">Receipt saved — syncing in the background.</p>

      <p className="field-label">Bill this to the customer?</p>
      <div className="row-gap">
        <button
          type="button"
          className={answer.passthrough === true ? "primary" : ""}
          onClick={() => setAnswer((a) => ({ ...a, passthrough: true }))}
        >
          Yes
        </button>
        <button
          type="button"
          className={answer.passthrough === false ? "primary" : ""}
          onClick={() => setAnswer((a) => ({ ...a, passthrough: false }))}
        >
          No
        </button>
      </div>

      {!presetProjectId && (
        <>
          <p className="field-label">Which job?</p>
          {jobLabel() && <p className="muted">Filed to {jobLabel()}.</p>}
          {(suggestions.data ?? []).length > 0 && (
            <div className="capture-chip-row">
              {(suggestions.data ?? []).map((s) => (
                <button
                  key={s.projectId}
                  type="button"
                  className="capture-chip"
                  title={s.reason}
                  onClick={() => pickSuggestion(s)}
                >
                  {s.jobCode || s.name}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="capture-list-toggle"
            onClick={() => setPickingJob((v) => !v)}
          >
            {pickingJob ? "Hide job list" : "Find a job, or type one that isn't in the app yet"}
          </button>
          {pickingJob && (
            <div className="capture-picker">
              <input
                className="capture-search"
                placeholder="Search jobs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search jobs"
              />
              <div className="capture-project-list">
                {filteredProjects.slice(0, 20).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="capture-project-item"
                    onClick={() => pickProject(p.id)}
                  >
                    <span className="capture-project-code">{p.job_code}</span>
                    <span className="capture-project-name">{p.name}</span>
                  </button>
                ))}
              </div>
              <label className="field-label">Not built in the app yet?</label>
              <div className="row-gap">
                <input
                  value={waitingName}
                  onChange={(e) => setWaitingName(e.target.value)}
                  placeholder="Type the job name"
                  aria-label="Job name"
                />
                <button type="button" disabled={!waitingName.trim()} onClick={applyWaitingName}>
                  Use this name
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Wave Z: which kind of purchase. Skippable like everything else on
          this sheet — a bare photo is still a valid receipt — but answering it
          here is what lets the office post it to the job without guessing. */}
      {(costCodes.data ?? []).length > 0 && (
        <>
          <p className="field-label">{t("receipt.costCode.label")}</p>
          <div className="clock-costcode-list">
            {(costCodes.data ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                className={
                  answer.costCodeId === c.id
                    ? "clock-costcode-item selected"
                    : "clock-costcode-item"
                }
                onClick={() =>
                  setAnswer((a) => ({
                    ...a,
                    costCodeId: a.costCodeId === c.id ? null : c.id,
                  }))
                }
              >
                <span className="clock-costcode-code">
                  {c.code} — {c.label}
                </span>
                {c.description && (
                  <span className="clock-costcode-desc">{c.description}</span>
                )}
              </button>
            ))}
          </div>
          <p className="muted">{t("receipt.costCode.help")}</p>
        </>
      )}

      {saved ? (
        <button type="button" className="primary big" onClick={onClose}>
          Done
        </button>
      ) : (
        <div className="row-gap">
          <button type="button" className="primary big" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : answeredSomething ? "Save" : "Skip"}
          </button>
          {answeredSomething && (
            <button type="button" className="big" onClick={onClose}>
              Skip
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JobPhotoCapture({
  projectId,
  label,
  kind = "photo",
  onClose,
  onQueued,
}: Extract<PhotoCaptureSheetProps, { mode: "job" }>) {
  const t = useT();
  const isReceipt = kind === "receipt";
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [queued, setQueued] = useState(0);
  const [filedReceipt, setFiledReceipt] = useState<{ id: string; entryId: string } | null>(null);

  const videoRef = useCameraStream(cameraOn, (message) => {
    setCameraError(message);
    setCameraOn(false);
  });

  const queueBlob = async (raw: Blob) => {
    setBusy(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);

      if (isReceipt) {
        // Phone-side compression per the spec (1280px longest edge, JPEG
        // 0.82) — tighter than a job photo's default, since a receipt only
        // needs to be legible to Claude vision and to a human zooming in on
        // a line item, not print-quality. stampPhoto falls back to the
        // original blob on any decode failure, so this never blocks a snap.
        const stamped = await stampPhoto(raw, meta, { maxDimension: 1280, quality: 0.82 });
        const id = crypto.randomUUID();
        const path = receiptPhotoPath(id);
        const entryId = await enqueueReceiptCapture({
          id,
          path,
          contentType: "image/jpeg",
          projectId,
          note: caption.trim() || null,
          blob: stamped,
        });
        setFiledReceipt({ id, entryId });
        onQueued?.();
        return;
      }

      const stamped = await stampPhoto(raw, meta);
      const fields = toPhotoMetaFields(meta);
      const createdBy = (await supabase.auth.getUser()).data.user?.email ?? null;
      const stamp = Date.now();
      const rand = Math.random().toString(16).slice(2, 8);
      const prefix = projectId ?? "unassigned";
      await enqueueUpload({
        kind,
        bucket: "install-media",
        path: `${prefix}/feed/${stamp}-${rand}.jpg`,
        contentType: "image/jpeg",
        projectId,
        createdBy,
        caption: caption.trim() || null,
        lat: fields.lat,
        lng: fields.lng,
        accuracyM: fields.accuracyM,
        takenAt: fields.takenAt,
        blob: stamped,
      });
      setQueued((n) => n + 1);
      onQueued?.();
    } catch (e) {
      // Silent otherwise: a too-large photo (or a full offline store) would
      // just vanish with the busy spinner and no trace, same failure the
      // ticket-11 damage-photo flow (ArrivePackages) reports for the same
      // enqueue call — same voice here.
      pushToast(`Couldn't save that ${isReceipt ? "receipt" : "photo"} — ${formatApiError(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const snap = () => {
    const video = videoRef.current;
    if (!video) return;
    void grabFrame(video).then((blob) => {
      if (blob) void queueBlob(blob);
    });
  };

  const pickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      if (file.type.startsWith("image/")) await queueBlob(file);
    }
  };

  const title = isReceipt ? t("photo.title.addReceipt") : t("photo.title.addPhotos");

  if (filedReceipt) {
    return (
      <>
        <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
        <div
          className="jobphoto-sheet sheet-enter"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="capture-grip" aria-hidden />
          <div className="capture-head">
            <h2 className="capture-title">{title}</h2>
            <button type="button" className="capture-close" aria-label={t("photo.a11y.close")} onClick={onClose}>
              <X size={20} />
            </button>
          </div>
          <ReceiptFollowUp
            receiptId={filedReceipt.id}
            entryId={filedReceipt.entryId}
            presetProjectId={projectId}
            presetJobLabel={label ?? null}
            onClose={onClose}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        className="jobphoto-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="capture-grip" aria-hidden />
        <div className="capture-head">
          <h2 className="capture-title">{title}</h2>
          <button type="button" className="capture-close" aria-label={t("photo.a11y.close")} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <p className="muted jobphoto-sub">
          {label ? <>{t("photo.for")} <strong>{label}</strong>. </> : null}
          {t("photo.stamped")}
        </p>

        {cameraOn ? (
          <div className="jobphoto-stage">
            <video ref={videoRef} playsInline muted className="ba-video" />
            <div className="row-gap">
              <button className="primary big" disabled={busy} onClick={snap}>
                {busy ? t("photo.action.saving") : t("photo.action.capture")}
              </button>
              <button className="big" onClick={() => setCameraOn(false)}>
                {t("photo.action.done")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="field-label">{t("photo.label.caption")}</label>
            <input
              className="jobphoto-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={isReceipt ? "e.g. Home Depot — shims" : "e.g. South elevation, unit 3"}
            />
            <div className="jobphoto-actions">
              <button
                type="button"
                className="jobphoto-action"
                onClick={() => setCameraOn(true)}
              >
                <Camera size={22} aria-hidden />
                <span>{t("photo.action.useCamera")}</span>
              </button>
              <label className="jobphoto-action" style={{ cursor: "pointer" }}>
                <ImagePlus size={22} aria-hidden />
                <span>{t("photo.action.uploadFiles")}</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple={!isReceipt}
                  style={{ display: "none" }}
                  onChange={(e) => void pickFiles(e)}
                />
              </label>
            </div>
          </>
        )}

        {cameraError && <p className="muted">{t("photo.cameraUnavailable")}</p>}
        {busy && !cameraOn && <p className="muted">{t("photo.stampingGps")}</p>}
        {queued > 0 && (
          <p className="ok jobphoto-count">
            {queued} photo{queued === 1 ? "" : "s"} queued — syncing in the background.
          </p>
        )}
      </div>
    </>
  );
}

function BeforeAfterCapture({
  value,
  onChange,
  label,
  slots,
}: Extract<PhotoCaptureSheetProps, { mode: "beforeAfter" }>) {
  const t = useT();
  const [mode, setMode] = useState<"idle" | "before" | "after">("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stamping, setStamping] = useState(false);

  const metaKey = (slot: "before" | "after"): "beforeMeta" | "afterMeta" =>
    slot === "before" ? "beforeMeta" : "afterMeta";

  const applyPhoto = async (slot: "before" | "after", raw: File) => {
    setStamping(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);
      const stamped = await stampPhotoFile(raw, meta);
      onChange({ ...value, [slot]: stamped, [metaKey(slot)]: meta });
    } finally {
      setStamping(false);
    }
  };

  const videoRef = useCameraStream(mode !== "idle", (message) => {
    setCameraError(message);
    setMode("idle");
  });

  const beforeUrl = useObjectUrl(value.before);
  const afterUrl = useObjectUrl(value.after);

  const snap = () => {
    const video = videoRef.current;
    if (!video || mode === "idle") return;
    const slot = mode;
    void grabFrame(video).then((blob) => {
      if (!blob) return;
      const file = new File([blob], `${slot}-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      setMode("idle");
      void applyPhoto(slot, file);
    });
  };

  const pickFile = (slot: "before" | "after") => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (file) void applyPhoto(slot, file);
    e.target.value = "";
  };

  if (mode !== "idle") {
    return (
      <div className="ba-camera">
        <div className="ba-camera-stage">
          <video ref={videoRef} playsInline muted className="ba-video" />
          {mode === "after" && beforeUrl && (
            <img src={beforeUrl} alt={t("photo.beforeGhostAlt")} className="ba-ghost" />
          )}
        </div>
        <div className="row-gap">
          <button className="primary big" onClick={snap}>
            {mode === "before" ? t("photo.captureBefore") : t("photo.captureAfter")}
          </button>
          <button className="big" onClick={() => setMode("idle")}>
            {t("photo.action.cancel")}
          </button>
        </div>
        {mode === "after" && beforeUrl && (
          <p className="muted">{t("photo.lineUpGhost")}</p>
        )}
      </div>
    );
  }

  const only = slots ?? (["before", "after"] as const);
  return (
    <div className={only.length === 1 ? "ba-grid one" : "ba-grid"}>
      {only.map((slot) => (
        <CaptureSlot
          key={slot}
          title={slot === "before" ? t("photo.before") : t("photo.after")}
          hint={slot === "after" ? t("photo.afterHint") : t("photo.gpsTimeAuto")}
          url={slot === "before" ? beforeUrl : afterUrl}
          onCamera={() => setMode(slot)}
          onFile={pickFile(slot)}
        />
      ))}
      {stamping && (
        <p className="muted" style={{ gridColumn: "1 / -1" }}>
          {t("photo.stampingGps")}
        </p>
      )}
      {cameraError && (
        <p className="muted" style={{ gridColumn: "1 / -1" }}>
          {t("photo.cameraUnavailableFile")}
        </p>
      )}
    </div>
  );
}


/**
 * One photo slot, dressed properly: the whole tile is the camera button
 * (dashed ember frame, camera badge, one clear instruction), the file picker
 * is the quiet second path underneath, and a filled slot shows the shot with
 * a Retake/File bar over its footer. Shared by the before/after pair and the
 * single-shot phase camera so every capture in the app feels the same.
 */
function CaptureSlot({
  title,
  hint,
  url,
  onCamera,
  onFile,
}: {
  title: string;
  hint?: string;
  url: string | null;
  onCamera: () => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const t = useT();
  if (url) {
    return (
      <div className="cap-slot filled">
        <img src={url} alt={title} className="cap-photo" />
        <div className="cap-photo-bar">
          <button type="button" className="cap-bar-btn" onClick={onCamera}>
            <RefreshCw size={14} aria-hidden /> {t("photo.action.retake")}
          </button>
          <label className="cap-bar-btn">
            <ImagePlus size={14} aria-hidden /> {t("photo.action.file")}
            <input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
        </div>
      </div>
    );
  }
  return (
    <div className="cap-slot">
      <button type="button" className="cap-empty" onClick={onCamera}>
        <span className="cap-cam-badge" aria-hidden>
          <Camera size={26} />
        </span>
        <span className="cap-cta">{title}</span>
        <span className="cap-sub">{hint ?? t("photo.tapToOpenCamera")}</span>
      </button>
      <label className="cap-file-alt">
        <ImagePlus size={13} aria-hidden /> {t("photo.chooseFromFiles")}
        <input type="file" accept="image/*" hidden onChange={onFile} />
      </label>
    </div>
  );
}

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function SinglePhotoCapture({
  value,
  onChange,
  label,
  prompt,
  stamp = true,
  hint,
}: Extract<PhotoCaptureSheetProps, { mode: "single" }>) {
  const t = useT();
  const [live, setLive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stamping, setStamping] = useState(false);

  const applyPhoto = async (raw: File) => {
    // An unstamped shot skips the GPS wait entirely — see `stamp` above.
    if (!stamp) {
      onChange(raw);
      return;
    }
    setStamping(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);
      const stamped = await stampPhotoFile(raw, meta);
      onChange(stamped);
    } finally {
      setStamping(false);
    }
  };

  const videoRef = useCameraStream(live, (message) => {
    setCameraError(message);
    setLive(false);
  });
  const url = useObjectUrl(value);

  const snap = () => {
    const video = videoRef.current;
    if (!video) return;
    void grabFrame(video).then((blob) => {
      if (!blob) return;
      const file = new File([blob], `${stamp ? "phase" : "card"}-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      setLive(false);
      void applyPhoto(file);
    });
  };

  if (live) {
    return (
      <div className="ba-camera">
        <div className="ba-camera-stage">
          <video ref={videoRef} playsInline muted className="ba-video" />
        </div>
        <div className="row-gap">
          <button className="primary big" onClick={snap}>{t("photo.action.capture")}</button>
          <button className="big" onClick={() => setLive(false)}>{t("photo.action.cancel")}</button>
        </div>
      </div>
    );
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void applyPhoto(f);
    e.target.value = "";
  };
  return (
    <div className="ba-grid one">
      <CaptureSlot
        title={prompt}
        hint={hint ?? (stamp ? t("photo.gpsTimeAuto") : undefined)}
        url={url}
        onCamera={() => setLive(true)}
        onFile={pick}
      />
      {stamping && <p className="muted">{t("photo.stampingGps")}</p>}
      {cameraError && (
        <p className="muted">{cameraError} — {t("photo.useFileInstead")}</p>
      )}
    </div>
  );
}
