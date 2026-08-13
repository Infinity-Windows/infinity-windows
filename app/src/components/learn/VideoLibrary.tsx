// The Learn tab's video library (owner spec): each lesson is a window type
// with a title, the video itself (uploaded or YouTube), and two drop-down
// transcripts — "Transcript Summary" to review the video, "Transcript
// Full" to read along. Supervisors author everything; installers watch.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listWindowTypes } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import {
  learningVideoUrl,
  listLearningVideos,
  saveLearningVideo,
  uploadLearningVideo,
  youtubeEmbedUrl,
  type LearningVideo,
} from "../../lib/learnVideos";

function Player({ video }: { video: LearningVideo }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (video.video_path) {
      learningVideoUrl(video.video_path)
        .then((u) => live && setSignedUrl(u))
        .catch(() => live && setSignedUrl(null));
    }
    return () => {
      live = false;
    };
  }, [video.video_path]);

  const embed = video.youtube_url ? youtubeEmbedUrl(video.youtube_url) : null;
  if (embed) {
    return (
      <iframe
        className="learn-video-frame"
        src={embed}
        title={video.title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }
  if (video.video_path) {
    return signedUrl ? (
      <video className="learn-video-frame" src={signedUrl} controls preload="metadata" />
    ) : (
      <p className="muted">Loading video…</p>
    );
  }
  return <p className="muted">No video attached.</p>;
}

export function VideoLibrary({ canAuthor }: { canAuthor: boolean }) {
  const qc = useQueryClient();
  const videos = useQuery({ queryKey: ["learningVideos"], queryFn: listLearningVideos });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
  const [editing, setEditing] = useState<LearningVideo | "new" | null>(null);

  const typeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data ?? []) m.set(t.id, t.name || t.type_code);
    return m;
  }, [types.data]);

  return (
    <div>
      {canAuthor && (
        <button className="button-like active-pill" onClick={() => setEditing("new")}>
          Add training video
        </button>
      )}
      {videos.isError && <p className="error">{formatApiError(videos.error)}</p>}

      <div className="home-projects" style={{ marginTop: 8 }}>
        {(videos.data ?? []).map((v) => (
          <div key={v.id} className="project-card" style={{ padding: 12 }}>
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{v.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {v.window_type_id
                    ? typeName.get(v.window_type_id) ?? "Window type"
                    : v.topic ?? "General"}
                </div>
              </div>
              {canAuthor && (
                <button className="button-like studio-mini" onClick={() => setEditing(v)}>
                  ✎ Edit
                </button>
              )}
            </div>
            <Player video={v} />
            {v.summary && (
              <details>
                <summary className="tcx-label">Transcript Summary</summary>
                <p className="learn-transcript">{v.summary}</p>
              </details>
            )}
            {v.transcript && (
              <details>
                <summary className="tcx-label">Transcript Full</summary>
                <p className="learn-transcript">{v.transcript}</p>
              </details>
            )}
          </div>
        ))}
        {(videos.data ?? []).length === 0 && !videos.isLoading && (
          <p className="muted">
            No training videos yet{canAuthor ? " — add the first one." : "."}
          </p>
        )}
      </div>

      {editing && (
        <VideoForm
          initial={editing === "new" ? null : editing}
          types={(types.data ?? []).map((t) => ({ id: t.id, name: t.name || t.type_code }))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["learningVideos"] });
          }}
        />
      )}
    </div>
  );
}

function VideoForm({
  initial,
  types,
  onClose,
  onSaved,
}: {
  initial: LearningVideo | null;
  types: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [windowTypeId, setWindowTypeId] = useState(initial?.window_type_id ?? "");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [youtube, setYoutube] = useState(initial?.youtube_url ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [transcript, setTranscript] = useState(initial?.transcript ?? "");

  const youtubeBad = youtube.trim() !== "" && !youtubeEmbedUrl(youtube);

  const save = useMutation({
    mutationFn: async (retire?: boolean) => {
      let videoPath = initial?.video_path ?? null;
      if (file) videoPath = await uploadLearningVideo(file);
      return saveLearningVideo({
        id: initial?.id ?? null,
        title,
        windowTypeId: windowTypeId || null,
        topic: topic || null,
        videoPath,
        youtubeUrl: youtube || null,
        summary: summary || null,
        transcript: transcript || null,
        active: !retire,
      });
    },
    onSuccess: (_v, retire) => {
      pushToast(retire ? "Video removed from Learn." : "Training video saved.");
      onSaved();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const hasSource = Boolean(file || initial?.video_path || (youtube.trim() && !youtubeBad));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {initial ? `Edit ${initial.title}` : "New training video"}
        </p>
        <label className="field-label">Title</label>
        <input
          placeholder="Installing the XO slider"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="field-label">Window type</label>
        <select value={windowTypeId} onChange={(e) => setWindowTypeId(e.target.value)}>
          <option value="">General / other (name it below)</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {!windowTypeId && (
          <input
            placeholder="Topic, e.g. Corner window sets"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        )}
        <label className="field-label">Video — upload a file…</label>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <label className="field-label">…or paste a YouTube address</label>
        <input
          placeholder="https://youtu.be/…"
          value={youtube}
          onChange={(e) => setYoutube(e.target.value)}
        />
        {youtubeBad && <p className="error">That doesn't look like a YouTube address.</p>}
        <label className="field-label">Transcript Summary (for reviewing the video)</label>
        <textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <label className="field-label">Transcript Full (to read along)</label>
        <textarea
          rows={6}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <button
            className="button-like active-pill"
            disabled={!title.trim() || !hasSource || save.isPending}
            onClick={() => save.mutate(false)}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {initial && (
            <button
              className="button-like"
              style={{ color: "var(--danger, #f87171)" }}
              disabled={save.isPending}
              onClick={() => save.mutate(true)}
            >
              Remove
            </button>
          )}
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
