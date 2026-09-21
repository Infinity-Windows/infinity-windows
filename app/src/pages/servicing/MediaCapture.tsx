import { useEffect, useRef, useState } from "react";
import { Mic, Square, Camera, Video, Paperclip } from "lucide-react";
import { usePhotoPicker } from "../../lib/photo/usePhotoPicker";
import { useLanguage } from "../../lib/i18n";
import { useServiceText, type ServiceText } from "../../lib/servicing/text";
import { type ServiceMedia, type ServiceUnit } from "../../lib/servicing/model";
import { enqueueServiceMedia } from "../../lib/servicing/mediaQueue";
import { serviceMediaBlob, serviceMediaUrl } from "../../lib/servicing/api";
import { transcribeDescription } from "../../lib/dictation";
import { startVoiceRecording, voiceFilename, type VoiceRecording } from "../../lib/voiceRecording";
import "../../components/voice/dictation.css";
import { formatApiError } from "../../lib/errors";
export function ServiceMediaCapture({
  unit,
  media,
  user,
  busy,
  canEditUnit,
  lead,
  sync,
  saveTranscript,
  onUseTranscript,
}: {
  unit: ServiceUnit;
  media: ServiceMedia[];
  user: string;
  busy: boolean;
  canEditUnit: boolean;
  lead: boolean;
  sync: () => Promise<void>;
  saveTranscript: (m: ServiceMedia, text: string) => Promise<void>;
  onUseTranscript: (text: string) => Promise<void>;
}) {
  const tx = useServiceText(),
    { lang } = useLanguage();
  const [recording, setRecording] = useState(false),
    [working, setWorking] = useState(false),
    [savingVoice, setSavingVoice] = useState(false),
    [error, setError] = useState("");
  const [urls, setUrls] = useState<Record<string, string>>({}),
    [kind, setKind] = useState<ServiceMedia["kind"]>("before");
  const [starting, setStarting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const recorder = useRef<VoiceRecording | null>(null),
    micRequest = useRef<AbortController | null>(null),
    live = useRef(true),
    recordOwner = useRef({ unit, user });
  useEffect(() => {
    recordOwner.current = { unit, user };
  }, [unit, user]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (recorder.current) recorder.current.stop();
      else micRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!preview) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(preview); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  async function run(fn: () => Promise<void>) {
    if (live.current) { setError(""); setWorking(true); }
    try {
      await fn();
    } catch (e) {
      if (live.current) setError(formatApiError(e));
    } finally {
      if (live.current) { setWorking(false); setSavingVoice(false); }
    }
  }
  async function upload(
    file: Blob,
    name: string,
    type: ServiceMedia["kind"],
    owner = { unit, user },
  ) {
    await enqueueServiceMedia(
      owner.user,
      owner.unit.visit_id,
      owner.unit.id,
      type,
      file,
      name,
      type === "voice" ? lang : undefined,
    );
    await sync();
  }
  const pictures = usePhotoPicker({
    accept: kind === "receipt" ? "image/*,application/pdf" : "image/*",
    camera: true,
    onFiles: (files) =>
      run(async () => {
        for (const file of files) await upload(file, file.name, kind);
      }),
  });
  async function start() {
    if (starting || recording) return;
    setError(""); setStarting(true); setSeconds(0);
    const owner = recordOwner.current;
    micRequest.current = new AbortController();
    try {
      recorder.current = await startVoiceRecording({
        signal: micRequest.current.signal,
        onSeconds: value => { if (live.current) setSeconds(value); },
        onError: () => { if (live.current) { setRecording(false); setError(tx("recordingError")); } },
        onComplete: blob => {
          if (live.current) { setRecording(false); setPreview(blob); setSavingVoice(true); }
          void run(() => upload(blob, voiceFilename(blob, `service-memo-${Date.now()}`), "voice", owner));
        },
      });
      if (live.current) setRecording(true);
    } catch {
      if (live.current) setError(tx("recordingError"));
    } finally { if (live.current) setStarting(false); }
  }
  return (
    <section className="sv-card" aria-label={tx("evidence")}>
      <h2>{tx("memo")}</h2>
      <p className="muted">{tx("memoHelp")}</p>
      <ol className="sv-prompts">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <li key={n}>{tx(`prompt${n}` as ServiceText)}</li>
        ))}
      </ol>
      <button
        className={recording ? "sv-recording" : "primary"}
        disabled={busy || working || starting}
        onClick={() => (recording ? recorder.current?.stop() : void start())}
      >
        {recording ? <Square size={18} /> : <Mic size={18} />}{" "}
        {tx(starting ? "openingMic" : recording ? "stopRecord" : "record")}
        {recording && ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
      </button>
      {working && <p role="status">{tx(savingVoice ? "savingMemo" : "workingMedia")}</p>}
      {previewUrl && !recording && <div className="dictation-preview">
        <audio controls src={previewUrl} aria-label={tx("listenMemo")} />
        <a href={previewUrl} download={voiceFilename(preview!, "service-memo")}>{tx("saveAudio")}</a>
      </div>}
      <h3>{tx("evidence")}</h3>
      <p className="muted">{tx("evidenceHelp")}</p>
      <div className="sv-fields">
        <label>
          {tx("evidenceKind")}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ServiceMedia["kind"])}
          >
            {(
              ["before", "after", "photo", "voice", "video", "receipt"] as const
            ).map((k) => (
              <option key={k} value={k}>
                {tx(k)}
              </option>
            ))}
          </select>
        </label>
        {["voice", "video"].includes(kind) ? (
          <label className="sv-upload">
            {kind === "video" ? <Video size={18} /> : <Mic size={18} />}{" "}
            {tx("upload")}
            {kind === "video" ? (
              <input
                type="file"
                disabled={busy || working || recording}
                accept="video/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void run(() => upload(file, file.name, "video"));
                  e.target.value = "";
                }}
              />
            ) : (
              <input
                type="file"
                disabled={busy || working || recording}
                accept="audio/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void run(() => upload(file, file.name, "voice"));
                  e.target.value = "";
                }}
              />
            )}
          </label>
        ) : (
          <div className="sv-actions">
            <button
              disabled={busy || working || recording}
              onClick={pictures.openCamera}
            >
              <Camera size={18} />
              {tx("photo")}
            </button>
            <button
              disabled={busy || working || recording}
              onClick={pictures.openLibrary}
            >
              <Paperclip size={18} />
              {tx("upload")}
            </button>
            {pictures.inputs}
          </div>
        )}
      </div>
      {kind === "video" && (
        <label className="sv-upload">
          <Video size={18} />
          {tx("recordVideo")}
          {/* photo-input-on-purpose: video-only recording; separate video library input remains available above. Photos use usePhotoPicker. */}
          <input
            type="file"
            accept="video/*"
            capture="environment"
            disabled={busy || working || recording}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void run(() => upload(file, file.name, "video"));
              e.target.value = "";
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="sv-evidence-list">
        {media.map((m) => (
          <article key={m.id}>
            <strong>{tx(m.kind)}</strong>
            <span>{m.filename}</span>
            {urls[m.id] ? (
              m.kind === "voice" ? (
                <audio controls src={urls[m.id]} />
              ) : m.kind === "video" ? (
                <video controls src={urls[m.id]} />
              ) : m.content_type.startsWith("image/") ? (
                <img src={urls[m.id]} alt={m.caption || m.filename} />
              ) : (
                <a href={urls[m.id]} target="_blank" rel="noreferrer">
                  {m.filename}
                </a>
              )
            ) : (
              <button
                onClick={() =>
                  void run(async () => {
                    const url = await serviceMediaUrl(m);
                    setUrls((v) => ({ ...v, [m.id]: url }));
                  })
                }
              >
                {tx("open")}
              </button>
            )}
            {m.kind === "voice" && (
              <>
                <button
                  disabled={working || busy || (!lead && m.created_by !== user)}
                  onClick={() =>
                    void run(async () => {
                      const blob = await serviceMediaBlob(m, AbortSignal.timeout(45_000));
                      const text = await transcribeDescription(
                        blob,
                        lang,
                        new AbortController().signal,
                      );
                      await saveTranscript(m, text);
                    })
                  }
                >
                  {working ? tx("transcribing") : tx("transcribe")}
                </button>
                {m.transcript && (
                  <>
                    <p className="sv-narrative">{m.transcript}</p>
                    <button
                      disabled={working || busy || !canEditUnit}
                      onClick={() =>
                        void run(() => onUseTranscript(m.transcript))
                      }
                    >
                      {tx("useTranscript")}
                    </button>
                  </>
                )}
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
