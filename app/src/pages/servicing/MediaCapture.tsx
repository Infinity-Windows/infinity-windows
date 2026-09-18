import { useEffect, useRef, useState } from "react";
import { Mic, Square, Camera, Video, Paperclip } from "lucide-react";
import { usePhotoPicker } from "../../lib/photo/usePhotoPicker";
import { useLanguage } from "../../lib/i18n";
import { useServiceText, type ServiceText } from "../../lib/servicing/text";
import { type ServiceMedia, type ServiceUnit } from "../../lib/servicing/model";
import { enqueueServiceMedia } from "../../lib/servicing/mediaQueue";
import { serviceMediaBlob, serviceMediaUrl } from "../../lib/servicing/api";
import { transcribeDescription } from "../../lib/dictation";
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
    [error, setError] = useState("");
  const [urls, setUrls] = useState<Record<string, string>>({}),
    [kind, setKind] = useState<ServiceMedia["kind"]>("before");
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    live = useRef(true),
    recordOwner = useRef({ unit, user });
  useEffect(() => {
    recordOwner.current = { unit, user };
  }, [unit, user]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    setError("");
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      if (live.current) setError(formatApiError(e));
    } finally {
      if (live.current) setWorking(false);
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
    setError("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(tx("recordingError"));
      const owner = recordOwner.current;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!live.current) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = mic;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(mic, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 64000,
      });
      recorder.current = rec;
      const chunks: Blob[] = [];
      let size = 0;
      rec.ondataavailable = (e) => {
        if (e.data.size) {
          chunks.push(e.data);
          size += e.data.size;
          if (size > 5 * 1024 * 1024 && rec.state === "recording") rec.stop();
        }
      };
      rec.onstop = () => {
        if (timer.current) clearTimeout(timer.current);
        mic.getTracks().forEach((t) => t.stop());
        if (live.current) setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType });
        void run(() =>
          upload(
            blob,
            `service-memo-${Date.now()}.${rec.mimeType.includes("mp4") ? "m4a" : "webm"}`,
            "voice",
            owner,
          ),
        );
      };
      rec.onerror = () => {
        mic.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setError(tx("recordingError"));
      };
      rec.start(1000);
      setRecording(true);
      timer.current = setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, 180000);
    } catch (e) {
      setError(formatApiError(e));
    }
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
        disabled={busy || working}
        onClick={() => (recording ? recorder.current?.stop() : void start())}
      >
        {recording ? <Square size={18} /> : <Mic size={18} />}{" "}
        {tx(recording ? "stopRecord" : "record")}
      </button>
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
                      const blob = await serviceMediaBlob(m);
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
