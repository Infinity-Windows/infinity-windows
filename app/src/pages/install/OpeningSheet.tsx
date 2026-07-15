import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Scanner } from "../../components/Scanner";
import { getWindowByWindowId, searchUnits } from "../../lib/api";
import {
  assignWindowToOpening,
  getOpening,
  submitInstallEvent,
} from "../../lib/install/api";
import {
  enqueueUpload,
  flushQueue,
  initQueueAutoFlush,
  pendingUploadCount,
} from "../../lib/install/queue";
import { MEMO_TOPICS, type MemoTopics } from "../../lib/install/types";
import { supabase } from "../../lib/supabase";

function pickAudioMime(): string {
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

export function OpeningSheet() {
  const { projectId = "", openingId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [scanOpen, setScanOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<string | null>(null);

  const [photos, setPhotos] = useState<File[]>([]);
  const [minutes, setMinutes] = useState("");
  const [grade, setGrade] = useState<number | null>(null);
  const [topics, setTopics] = useState<Partial<MemoTopics>>({});
  const [pending, setPending] = useState(0);

  useEffect(() => {
    initQueueAutoFlush();
    pendingUploadCount().then(setPending).catch(() => {});
  }, []);

  const opening = useQuery({
    queryKey: ["opening", openingId],
    queryFn: () => getOpening(openingId),
  });
  const searchResults = useQuery({
    queryKey: ["unitSearch", search],
    queryFn: () => searchUnits(search),
    enabled: search.trim().length >= 2,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["opening", openingId] });
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
  };

  const assign = useMutation({
    mutationFn: async (windowUuid: string) =>
      assignWindowToOpening(openingId, windowUuid),
    onSuccess: () => {
      setMessage("Window assigned.");
      setScanOpen(false);
      setSearch("");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const assignByWindowId = async (windowId: string) => {
    try {
      const unit = await getWindowByWindowId(windowId);
      if (!unit) throw new Error(`Unknown window ${windowId}`);
      assign.mutate(unit.id);
    } catch (e) {
      setMessage(String(e));
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      rec.start();
      recorderRef.current = rec;
      startedAtRef.current ??= new Date().toISOString();
      setRecording(true);
    } catch (e) {
      setMessage(`Mic unavailable: ${String(e)}`);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const submit = useMutation({
    mutationFn: async () => {
      const o = opening.data;
      if (!o) throw new Error("Opening not loaded.");

      const event = await submitInstallEvent({
        openingId,
        minutes: minutes ? Number(minutes) : null,
        qualityGrade: grade,
        startedAt: startedAtRef.current,
        ...topics,
      });

      // Media goes through the offline queue: uploads survive dead spots and
      // retry on reconnect.
      const { data: userData } = await supabase.auth.getUser();
      const createdBy = userData.user?.email ?? null;
      const stamp = Date.now();
      if (audioBlob) {
        const ext = audioBlob.type.includes("mp4") ? "m4a" : "webm";
        await enqueueUpload(
          {
            bucket: "install-media",
            path: `${projectId}/${o.opening_code}/${stamp}-memo.${ext}`,
            contentType: audioBlob.type || "audio/webm",
            kind: "voice_memo",
            installEventId: event.id,
            windowId: o.assigned_window_id,
            createdBy,
          },
          audioBlob,
        );
      }
      for (const [i, photo] of photos.entries()) {
        await enqueueUpload(
          {
            bucket: "install-media",
            path: `${projectId}/${o.opening_code}/${stamp}-photo-${i + 1}.jpg`,
            contentType: photo.type || "image/jpeg",
            kind: "photo",
            installEventId: event.id,
            windowId: o.assigned_window_id,
            createdBy,
          },
          photo,
        );
      }
      const flush = await flushQueue();
      return flush;
    },
    onSuccess: (flush) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      if (flush.remaining > 0) {
        setMessage(
          `Install recorded. ${flush.remaining} file(s) queued — they'll upload when you're back in signal.`,
        );
        setPending(flush.remaining);
      } else {
        navigate(`/install/${projectId}`);
      }
    },
    onError: (e) => setMessage(String(e)),
  });

  const o = opening.data;
  if (opening.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!o) return <div className="page"><p className="error">Opening not found.</p></div>;

  const installed = o.status === "installed";

  return (
    <div className="page">
      <header className="page-header">
        <h1>{o.opening_code}</h1>
        <Link to={`/install/${projectId}`} className="button-like">Map</Link>
      </header>

      <div className="detail-card">
        <p>
          <strong>{o.window_types?.type_code ?? "Type not set"}</strong>{" "}
          <span className="muted">{o.window_types?.name}</span>
        </p>
        {o.label && <p className="muted">{o.label}</p>}
        <p>
          Status: <span className={installed ? "ok" : "warn-text"}>{o.status}</span>
        </p>
        {o.window_types && (
          <p>
            <Link to={`/install/brain/${o.window_types.id}`} className="suggest">
              Type brain: {o.window_types.type_code} tips →
            </Link>
          </p>
        )}
        {pending > 0 && (
          <p className="warn-text">{pending} upload(s) waiting for signal.</p>
        )}
      </div>

      {message && (
        <p className={message.startsWith("Window") || message.startsWith("Install") ? "ok" : "error"}>
          {message}
        </p>
      )}

      {/* --- Assign inventory unit --- */}
      <h2>Physical window</h2>
      {o.assigned_window_id && o.windows ? (
        <p>
          <Link to={`/w/${encodeURIComponent(o.windows.window_id)}`}>
            <strong>{o.windows.window_id}</strong>
          </Link>{" "}
          <span className="ok">assigned</span>
        </p>
      ) : installed ? (
        <p className="muted">Installed without a tracked unit.</p>
      ) : (
        <>
          <p className="muted">
            Scan the QR on the window you're putting in this opening, or search.
          </p>
          <button className="big" onClick={() => setScanOpen(!scanOpen)}>
            {scanOpen ? "Close scanner" : "Scan window QR"}
          </button>
          {scanOpen && (
            <Scanner
              hint="Scan the window's license-plate QR."
              onScan={(payload) => {
                if (payload.kind === "window") {
                  void assignByWindowId(payload.windowId);
                } else {
                  setMessage("That's a slot label — scan a window label.");
                }
              }}
            />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search W-… or type code"
          />
          {search.trim().length >= 2 && (
            <ul className="unit-list">
              {(searchResults.data ?? [])
                .filter((u) => u.status !== "installed")
                .slice(0, 8)
                .map((u) => (
                  <li key={u.id} className="find-row">
                    <strong>{u.window_id}</strong>
                    <span className="muted">{u.window_types?.type_code}</span>
                    <button
                      className="link"
                      style={{ marginLeft: "auto" }}
                      onClick={() => assign.mutate(u.id)}
                    >
                      Assign
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}

      {/* --- Capture --- */}
      {!installed && (
        <>
          <h2>Install memo</h2>
          <p className="muted">
            Hit record and talk through the prompts — one take, under two
            minutes.
          </p>
          <button
            className={recording ? "big record-btn recording" : "big record-btn"}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? "■ Stop recording" : audioBlob ? "● Re-record memo" : "● Record memo"}
          </button>
          {audioUrl && !recording && (
            <audio controls src={audioUrl} className="audio-preview" />
          )}

          <ol className="topic-prompts">
            {MEMO_TOPICS.map((t) => (
              <li key={t.key} className={recording ? "active" : ""}>
                {t.prompt}
              </li>
            ))}
          </ol>

          <details className="topic-fields">
            <summary className="muted">Type notes instead (optional)</summary>
            {MEMO_TOPICS.map((t) => (
              <div key={t.key}>
                <label className="field-label">{t.prompt}</label>
                <input
                  value={topics[t.key] ?? ""}
                  onChange={(e) =>
                    setTopics({ ...topics, [t.key]: e.target.value || null })
                  }
                />
              </div>
            ))}
          </details>

          <label className="field-label">Photos</label>
          <label className="action-btn" style={{ cursor: "pointer" }}>
            {photos.length > 0 ? `${photos.length} photo(s) added — add more` : "Add photos"}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                setPhotos([...photos, ...Array.from(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>

          <label className="field-label">Minutes it took</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="e.g. 45"
          />

          <label className="field-label">Quality grade</label>
          <div className="grade-row">
            {[1, 2, 3, 4, 5].map((g) => (
              <button
                key={g}
                className={grade === g ? "grade-btn selected" : "grade-btn"}
                onClick={() => setGrade(g)}
              >
                {g}
              </button>
            ))}
          </div>

          <button
            className="primary big"
            disabled={submit.isPending || recording}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Saving…" : "Submit install"}
          </button>
          {!o.assigned_window_id && (
            <p className="muted">
              No unit linked yet — you can still submit; the memo attaches to
              the opening and type.
            </p>
          )}
        </>
      )}
    </div>
  );
}
