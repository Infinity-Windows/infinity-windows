import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage, useT } from "../../lib/i18n";
import "../../lib/i18n/qcEvidenceCatalog";
import { MEMO_TOPICS, type MemoTopics, type OpeningStatus } from "../../lib/install/types";
import { loadQcUnitEvidence } from "../../lib/qcEvidence";
import type { QcEvidenceMedia, QcEvidenceSource } from "../../lib/qcEvidenceTypes";
import type { TKey } from "../../lib/i18n/catalog";
import "./qcUnitEvidence.css";

const TOPIC_KEYS: Record<keyof MemoTopics, TKey> = {
  difficulty: "qcEvidence.topic.difficulty", went_well: "qcEvidence.topic.went_well",
  went_poorly: "qcEvidence.topic.went_poorly", obstacles: "qcEvidence.topic.obstacles",
  tools_helped: "qcEvidence.topic.tools_helped", time_vs_estimate: "qcEvidence.topic.time_vs_estimate",
  safety_notes: "qcEvidence.topic.safety_notes", do_again: "qcEvidence.topic.do_again",
};
const SOURCE_KEYS: Record<QcEvidenceSource, TKey> = {
  install: "qcEvidence.install", unit: "qcEvidence.direct",
  assigned_window: "qcEvidence.legacy", flashing: "qcEvidence.flashing",
};
const STATUS_KEYS: Record<OpeningStatus, TKey> = {
  planned: "qcEvidence.planned", assigned: "qcEvidence.assignedStatus", installed: "qcEvidence.installed",
};

export function QcUnitEvidence({
  openingId, projectId, viewerId, panelId, history, onClose,
}: {
  openingId: string; projectId: string; viewerId: string; panelId: string;
  history: boolean; onClose: () => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const [failedMedia, setFailedMedia] = useState<Set<string>>(new Set());
  const [photoLimit, setPhotoLimit] = useState(24);
  const [memoLimit, setMemoLimit] = useState(12);
  const [notesLimit, setNotesLimit] = useState(20);
  const record = useQuery({
    queryKey: ["qcUnitEvidence", viewerId, projectId, openingId],
    queryFn: () => loadQcUnitEvidence(openingId, projectId),
    enabled: Boolean(viewerId),
    staleTime: 30_000,
    refetchOnMount: "always",
    retry: false,
  });
  const stamp = (value: string | null | undefined) => {
    if (!value || !Number.isFinite(Date.parse(value))) return t("qcEvidence.notRecorded");
    return new Date(value).toLocaleString(lang === "es" ? "es-MX" : "en-US");
  };
  const size = (width: number | null | undefined, height: number | null | undefined) =>
    typeof width === "number" && Number.isFinite(width) && width > 0
      && typeof height === "number" && Number.isFinite(height) && height > 0
      ? width + " × " + height + " in" : t("qcEvidence.notRecorded");
  const refresh = () => {
    setFailedMedia(new Set());
    void record.refetch();
  };
  const unavailable = (id: string) => setFailedMedia(current => new Set([...current, id]));
  const mediaCard = (media: QcEvidenceMedia) => {
    const failed = !media.signedUrl || failedMedia.has(media.id);
    const install = record.data?.events.find(event => event.id === media.installEventId);
    return (
      <figure className="qc-evidence-file" key={media.id}>
        <figcaption>
          <strong>{t(SOURCE_KEYS[media.source])}</strong>
          <div className="muted">{stamp(media.createdAt)}</div>
          {install?.voided_at && <p>{t("qcEvidence.sentBack")}{install.void_reason ? " · " + install.void_reason : ""}</p>}
          {media.caption && <p>{media.caption}</p>}
        </figcaption>
        {failed ? <p role="status">{t(media.kind === "photo" ? "qcEvidence.photoUnavailable" : "qcEvidence.voiceUnavailable")}</p>
          : media.kind === "photo" ? (
            <a href={media.signedUrl!} target="_blank" rel="noreferrer noopener" aria-label={t("qcEvidence.openPhoto")}>
              <img src={media.signedUrl!} alt={media.caption || t("qcEvidence.photo")} loading="lazy" onError={() => unavailable(media.id)} />
            </a>
          ) : (
            <audio controls preload="metadata" src={media.signedUrl!} aria-label={media.caption || t("qcEvidence.voice")} onError={() => unavailable(media.id)} />
          )}
        {media.signedUrl && (
          <a className="link qc-evidence-open-file" href={media.signedUrl} target="_blank" rel="noreferrer noopener">
            {t(media.kind === "photo" ? "qcEvidence.openPhoto" : "qcEvidence.openAudio")}
          </a>
        )}
        {media.transcript && <div className="qc-evidence-note"><strong>{t("qcEvidence.transcript")}</strong><p>{media.transcript}</p></div>}
      </figure>
    );
  };
  const data = record.data;
  const opening = data?.opening;
  const photos = (data?.media ?? []).filter(item => item.kind === "photo");
  const memos = (data?.media ?? []).filter(item => item.kind === "voice_memo");
  const events = [...(data?.events ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const incomplete = (data?.problems.length ?? 0) > 0;
  const mediaComplete = Boolean(data?.sources.eventsLoaded && data.sources.attachmentsLoaded && data.sources.legacyLoaded)
    && !data?.problems.some(problem => problem.source !== "phase");
  const photosComplete = mediaComplete && data?.sources.phaseLoaded;
  return (
    <section className="detail-card qc-unit-evidence" id={panelId} aria-label={t("qcEvidence.title")}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <header className="qc-evidence-header">
        <h3>{t("qcEvidence.title")}</h3>
        <div className="row-gap">
          <button type="button" className="button-like" disabled={record.isFetching} onClick={refresh}>{t("qcEvidence.refresh")}</button>
          <button type="button" className="button-like" onClick={onClose}>{t("qcEvidence.close")}</button>
        </div>
      </header>
      {history && <p className="muted">{t("qcEvidence.current")}</p>}
      {record.isPending ? <p role="status">{t(record.fetchStatus === "paused" ? "qcEvidence.offline" : "qcEvidence.loading")}</p>
        : !data || !opening ? <p role="alert">{t("qcEvidence.error")}</p> : (
          <>
            {record.isError && <p role="alert">{t("qcEvidence.cachedError")}</p>}
            {record.fetchStatus === "paused" && <p role="status">{t("qcEvidence.offline")}</p>}
            <dl className="qc-evidence-facts">
              <div><dt>{t("qcEvidence.job")}</dt><dd>{[opening.projects?.job_code, opening.projects?.name].filter(Boolean).join(" · ") || t("qcEvidence.notRecorded")}</dd></div>
              <div><dt>{t("qcEvidence.unit")}</dt><dd>{opening.opening_code}</dd></div>
              {opening.label && <div><dt>{t("qcEvidence.label")}</dt><dd>{opening.label}</dd></div>}
              <div><dt>{t("qcEvidence.type")}</dt><dd>{[opening.window_types?.type_code, opening.window_types?.name].filter(Boolean).join(" · ") || t("qcEvidence.notRecorded")}</dd></div>
              <div><dt>{t("qcEvidence.size")}</dt><dd>{size(opening.window_types?.width_in, opening.window_types?.height_in)}</dd></div>
              <div><dt>{t("qcEvidence.openingSize")}</dt><dd>{size(opening.ro_width_in, opening.ro_height_in)}</dd></div>
              <div><dt>{t("qcEvidence.status")}</dt><dd>{t(STATUS_KEYS[opening.status] ?? "qcEvidence.notRecorded")}</dd></div>
              <div><dt>{t("qcEvidence.assigned")}</dt><dd>{opening.assignee?.display_name || t("qcEvidence.notRecorded")}</dd></div>
              <div><dt>{t("qcEvidence.window")}</dt><dd>{opening.windows?.display_name || opening.windows?.window_id || opening.windows?.serial || t("qcEvidence.notRecorded")}</dd></div>
            </dl>
            {(opening.window_types?.notes || opening.windows?.notes) && <div className="qc-evidence-note">
              <strong>{t("qcEvidence.notes")}</strong>
              {opening.window_types?.notes && <p>{opening.window_types.notes}</p>}
              {opening.windows?.notes && <p>{opening.windows.notes}</p>}
            </div>}
            <Link className="link qc-evidence-open-file" to={"/projects/" + projectId + "/opening/" + openingId}>{t("qcEvidence.fullRecord")}</Link>
            {incomplete && <div className="qc-evidence-problems" role="status">
              {data.problems.some(problem => problem.reason === "unavailable") && <p>{t("qcEvidence.partial")}</p>}
              {data.problems.some(problem => problem.reason === "ambiguous") && <p>{t("qcEvidence.ambiguous")}</p>}
              {data.problems.some(problem => problem.reason === "conflict") && <p>{t("qcEvidence.conflict")}</p>}
              {data.problems.some(problem => problem.reason === "incomplete") && <p>{t("qcEvidence.incomplete")}</p>}
            </div>}
            <h4>{t("qcEvidence.photos")}</h4>
            <div className="qc-evidence-media">{photos.slice(0, photoLimit).map(mediaCard)}</div>
            {photos.length === 0 && <p className="muted">{t(photosComplete ? "qcEvidence.noPhotos" : "qcEvidence.unknownPhotos")}</p>}
            {photos.length > photoLimit && <div className="row-gap"><span>{t("qcEvidence.showing", { n: photoLimit, total: photos.length })}</span><button type="button" className="button-like" onClick={() => setPhotoLimit(n => n + 24)}>{t("qcEvidence.morePhotos")}</button></div>}
            <h4>{t("qcEvidence.memos")}</h4>
            <div className="qc-evidence-media">{memos.slice(0, memoLimit).map(mediaCard)}</div>
            {memos.length === 0 && <p className="muted">{t(mediaComplete ? "qcEvidence.noMemos" : "qcEvidence.unknownMemos")}</p>}
            {memos.length > memoLimit && <div className="row-gap"><span>{t("qcEvidence.showing", { n: memoLimit, total: memos.length })}</span><button type="button" className="button-like" onClick={() => setMemoLimit(n => n + 12)}>{t("qcEvidence.moreMemos")}</button></div>}
            <h4>{t("qcEvidence.installNotes")}</h4>
            {events.slice(0, notesLimit).map(event => <article className="qc-evidence-round" key={event.id}>
              <strong>{stamp(event.created_at)}</strong>
              {event.voided_at && <p>{t("qcEvidence.sentBack")}{event.void_reason ? " · " + event.void_reason : ""}</p>}
              {typeof event.minutes === "number" && Number.isFinite(event.minutes) && event.minutes >= 0 && <p className="muted">{t("qcEvidence.minutes", { n: event.minutes })}</p>}
              {typeof event.quality_grade === "number" && event.quality_grade >= 1 && event.quality_grade <= 5 && <p className="muted">{t("qcEvidence.selfGrade", { n: event.quality_grade })}</p>}
              {MEMO_TOPICS.filter(topic => event[topic.key]?.trim()).map(topic => <div className="qc-evidence-note" key={topic.key}><strong>{t(TOPIC_KEYS[topic.key])}</strong><p>{event[topic.key]}</p></div>)}
              {event.transcript_raw && <div className="qc-evidence-note"><strong>{t("qcEvidence.installTranscript")}</strong><p>{event.transcript_raw}</p></div>}
            </article>)}
            {events.length === 0 && data.sources.eventsLoaded && <p className="muted">{t("qcEvidence.noInstallNotes")}</p>}
            {events.length > notesLimit && <button type="button" className="button-like" onClick={() => setNotesLimit(n => n + 20)}>{t("qcEvidence.moreNotes")}</button>}
            <p className="muted">{t("qcEvidence.savedOnly")}</p>
          </>
        )}
    </section>
  );
}
