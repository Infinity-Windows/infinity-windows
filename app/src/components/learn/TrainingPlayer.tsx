// One "Using Forge" walkthrough: the warning first, then the video, then the
// chapters and the transcript. No autoplay — the person presses play.
//
// The warning sits ABOVE the video, not in a footer, because the one thing a
// viewer must not come away with is the idea that a proposed screen is a
// screen they can use today.

import { useEffect, useRef, useState } from "react";
import {
  chapterIndexAt,
  formatClock,
  isDesignPreview,
  type TrainingChapterStatus,
  type TrainingVideo,
} from "../../lib/appTraining";
import { useOnline, useTrainingMedia } from "../../lib/useAppTraining";
import { SkeletonCard } from "../ui/States";
import { useUsingForgeT, type UsingForgeT } from "./usingForgeCopy";

export function DesignPreviewNotice({
  video,
  t,
  compact = false,
}: {
  video: Pick<TrainingVideo, "contentStatus">;
  t: UsingForgeT;
  compact?: boolean;
}) {
  if (!isDesignPreview(video)) return null;
  return (
    <div className={compact ? "uf-preview uf-preview-compact" : "uf-preview"}>
      <span className="uf-badge">{t("uf.previewBadge")}</span>
      <p>{t("uf.previewText")}</p>
    </div>
  );
}

const STATUS_KEY: Record<TrainingChapterStatus, "uf.status.proposal" | "uf.status.live" | "uf.status.mixed"> = {
  proposal: "uf.status.proposal",
  live: "uf.status.live",
  mixed: "uf.status.mixed",
};

export function TrainingPlayer({
  video,
  userId,
  onBack,
}: {
  video: TrainingVideo;
  userId: string;
  onBack: () => void;
}) {
  const t = useUsingForgeT();
  const online = useOnline();
  const { state, retry } = useTrainingMedia(video, userId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  // Where playback had got to, so a link that expires mid-sitting (they last
  // an hour) comes back at the same moment rather than at the start.
  const lastTime = useRef(0);
  const [current, setCurrent] = useState(0);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const headingId = `uf-player-${video.id}`;

  // Signal back after a failure: try again on our own rather than making
  // somebody find the button.
  const failed = state.status === "error" || playbackFailed;
  useEffect(() => {
    if (!failed) return;
    const again = () => resume();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
    // resume() only touches refs, a setter and retry, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, retry]);

  function resume() {
    if (lastTime.current > 0) pendingSeek.current = lastTime.current;
    setPlaybackFailed(false);
    retry();
  }

  const seekTo = (seconds: number) => {
    const el = videoRef.current;
    setCurrent(chapterIndexAt(video.chapters, seconds));
    if (!el) {
      pendingSeek.current = seconds;
      return;
    }
    // Before metadata has loaded some browsers ignore currentTime; hold the
    // jump until they know how long the video is.
    if (el.readyState >= 1) el.currentTime = seconds;
    else pendingSeek.current = seconds;
  };

  const media = state.status === "ready" ? state.media : null;

  return (
    <section className="uf-player" aria-labelledby={headingId}>
      <button type="button" className="link uf-back" onClick={onBack}>
        ← {t("uf.back")}
      </button>
      <DesignPreviewNotice video={video} t={t} />
      <h2 id={headingId}>{video.title}</h2>
      <p className="uf-meta">
        <span className="uf-scope">{t(`uf.scope.${video.slug}`)}</span>
        <span>{formatClock(video.durationSeconds)}</span>
        <span>{t(`uf.narration.${video.language}`)}</span>
      </p>

      <div className="uf-stage">
        {state.status === "loading" && (
          <div role="status" aria-live="polite" className="uf-stage-wait">
            <SkeletonCard height={200} />
            <p className="muted">{t("uf.preparing")}</p>
          </div>
        )}
        {failed && (
          <div className="uf-problem" role="alert">
            <p className="uf-problem-title">
              {!online ? t("uf.offline") : playbackFailed ? t("uf.playbackFailed") : t("uf.mediaFailed")}
            </p>
            {online && !playbackFailed && <p className="muted">{t("uf.tryLater")}</p>}
            <button
              type="button"
              className="button-like"
              onClick={resume}
            >
              {t("uf.retry")}
            </button>
          </div>
        )}
        {media && !playbackFailed && (
          <video
            ref={videoRef}
            className="uf-video"
            controls
            playsInline
            preload="metadata"
            // No download button in browsers that offer one, no casting of a
            // private link to somebody else's screen, and no autoplay.
            controlsList="nodownload noremoteplayback"
            poster={media.posterUrl ?? undefined}
            src={media.videoUrl}
            aria-label={t("uf.videoLabel", { title: video.title })}
            onLoadedMetadata={(e) => {
              if (pendingSeek.current != null) {
                e.currentTarget.currentTime = pendingSeek.current;
                pendingSeek.current = null;
              }
            }}
            onTimeUpdate={(e) => {
              lastTime.current = e.currentTarget.currentTime;
              setCurrent(chapterIndexAt(video.chapters, e.currentTarget.currentTime));
            }}
            onError={() => setPlaybackFailed(true)}
          >
            {media.captionsUrl && (
              <track
                kind="captions"
                src={media.captionsUrl}
                srcLang={video.language}
                label={t(`uf.trackLabel.${video.language}`)}
                default
              />
            )}
          </video>
        )}
        {media && !playbackFailed && media.captionsFailed && (
          <p className="muted uf-note">{t("uf.captionsFailed")}</p>
        )}
        {media && !playbackFailed && !video.captionsPath && (
          <p className="muted uf-note">{t("uf.noCaptions")}</p>
        )}
      </div>
      <p className="muted uf-note">{t("uf.streamingNote")}</p>

      <h3 className="uf-subhead">{t("uf.chapters")}</h3>
      <p className="muted uf-note">{t("uf.statusHelp")}</p>
      <ol className="uf-chapters">
        {video.chapters.map((c, i) => {
          const time = formatClock(c.seconds);
          return (
            <li key={`${c.seconds}-${i}`}>
              <button
                type="button"
                className={i === current ? "uf-chapter active" : "uf-chapter"}
                aria-current={i === current ? "true" : undefined}
                aria-label={t("uf.chapterJump", { time, title: c.title })}
                disabled={!media || playbackFailed}
                onClick={() => seekTo(c.seconds)}
              >
                <span className="uf-chapter-time">{time}</span>
                <span className="uf-chapter-title">{c.title}</span>
                <span className={`uf-status uf-status-${c.status}`}>{t(STATUS_KEY[c.status])}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <details className="uf-transcript">
        <summary>{t("uf.transcript")}</summary>
        {video.transcript ? (
          <div className="uf-transcript-body" lang={video.language}>
            {video.transcript
              .split(/\n\s*\n/)
              .map((para) => para.trim())
              .filter(Boolean)
              .map((para, i) => (
                <p key={i}>{para}</p>
              ))}
          </div>
        ) : (
          <p className="muted">{t("uf.noTranscript")}</p>
        )}
      </details>
    </section>
  );
}
