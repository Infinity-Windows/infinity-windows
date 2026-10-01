import { useEffect, useRef, useState } from "react";
import { Camera, Database, Mic, Wifi } from "lucide-react";
import { useT } from "../lib/i18n";
import { checkAppConnection, checkPhoneStorage, mediaFailure, type PhoneCheckKind, type PhoneCheckResult } from "../lib/offline/phoneCheck";
import { startVoiceRecording, type VoiceRecording } from "../lib/voiceRecording";

type Results = Partial<Record<PhoneCheckKind, PhoneCheckResult>>;

export function PhoneCheck({ onResult }: { onResult: (kind: PhoneCheckKind, result: PhoneCheckResult | null) => void }) {
  const t = useT();
  const [results, setResults] = useState<Results>({});
  const [busy, setBusy] = useState<PhoneCheckKind | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const micTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(true);

  function save(kind: PhoneCheckKind, result: PhoneCheckResult | null) {
    if (!mountedRef.current) return;
    setResults(current => {
      const next = { ...current };
      if (result) next[kind] = result;
      else delete next[kind];
      return next;
    });
    onResult(kind, result);
  }

  function clearAudio() {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setAudioUrl(null);
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cameraRequestRef.current += 1;
      if (micTimerRef.current) clearTimeout(micTimerRef.current);
      abortRef.current?.abort();
      recordingRef.current?.cancel();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!cameraReady || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play().catch(() => undefined);
  }, [cameraReady]);

  async function runSimple(kind: "storage" | "connection") {
    if (busy) return;
    save(kind, null);
    setBusy(kind);
    const result = kind === "storage" ? await checkPhoneStorage() : await checkAppConnection();
    save(kind, result);
    if (mountedRef.current) setBusy(null);
  }

  async function runMicrophone() {
    if (busy) return;
    save("microphone", null);
    clearAudio();
    setBusy("microphone");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const recording = await startVoiceRecording({
        signal: controller.signal,
        onComplete: blob => {
          if (!mountedRef.current) return;
          if (micTimerRef.current) clearTimeout(micTimerRef.current);
          const url = URL.createObjectURL(blob);
          audioUrlRef.current = url;
          setAudioUrl(url);
          setBusy(null);
          recordingRef.current = null;
        },
        onError: error => {
          if (!mountedRef.current) return;
          save("microphone", mediaFailure(error));
          setBusy(null);
          recordingRef.current = null;
        },
      });
      if (!mountedRef.current || controller.signal.aborted) { recording.cancel(); return; }
      recordingRef.current = recording;
      micTimerRef.current = setTimeout(() => recording.stop(), 3_000);
    } catch (error) {
      save("microphone", mediaFailure(error));
      if (mountedRef.current) setBusy(null);
    }
  }

  async function runCamera() {
    if (busy) return;
    save("camera", null);
    stopCamera();
    setBusy("camera");
    const request = ++cameraRequestRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      save("camera", { status: "unsupported", reason: "unavailable", at: Date.now() });
      setBusy(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (!mountedRef.current || request !== cameraRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      setCameraReady(true);
      setBusy(null);
    } catch (error) {
      save("camera", mediaFailure(error));
      if (mountedRef.current) setBusy(null);
    }
  }

  function confirm(kind: "microphone" | "camera", worked: boolean) {
    save(kind, { status: worked ? "pass" : "fail", reason: worked ? "confirmed" : "not_working", at: Date.now() });
    if (kind === "camera") stopCamera();
    else clearAudio();
  }

  const items = [
    { kind: "storage" as const, icon: Database, action: () => void runSimple("storage") },
    { kind: "connection" as const, icon: Wifi, action: () => void runSimple("connection") },
    { kind: "microphone" as const, icon: Mic, action: () => void runMicrophone() },
    { kind: "camera" as const, icon: Camera, action: () => void runCamera() },
  ];

  return (
    <section className="detail-card" style={{ marginBottom: 12 }} data-testid="phone-check">
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("diag.phone.title")}</h2>
      <p className="muted">{t("diag.phone.intro")}</p>
      <div style={{ display: "grid", gap: 12 }}>
        {items.map(({ kind, icon: Icon, action }) => {
          const result = results[kind];
          return (
            <div key={kind} style={{ borderTop: "1px solid var(--border, #ddd)", paddingTop: 10 }} data-testid={`phone-check-${kind}`}>
              <button type="button" className="action-btn" onClick={action} disabled={busy !== null || cameraReady}>
                <Icon size={16} aria-hidden /> {t(`diag.phone.${kind}`)}
              </button>
              {busy === kind && <p className="muted" role="status">{t("diag.phone.working")}</p>}
              {result && <p role="status" style={{ margin: "6px 0" }}>
                <strong>{t(`diag.phone.${result.status}`)}:</strong> {t(`diag.phone.reason.${result.reason}`)}
                {kind === "connection" && result.durationMs != null ? ` ${t("diag.phone.duration", { ms: result.durationMs })}` : ""}
              </p>}
              {kind === "microphone" && audioUrl && <div style={{ marginTop: 8 }}>
                <p className="muted">{t("diag.phone.listen")}</p>
                <audio controls src={audioUrl} style={{ width: "100%" }} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <button type="button" className="action-btn" onClick={() => confirm("microphone", true)}>{t("diag.phone.heard")}</button>
                  <button type="button" className="action-btn" onClick={() => confirm("microphone", false)}>{t("diag.phone.noSound")}</button>
                </div>
              </div>}
              {kind === "camera" && cameraReady && <div style={{ marginTop: 8 }}>
                <p className="muted">{t("diag.phone.look")}</p>
                <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", maxWidth: 360, borderRadius: 8, background: "#111" }} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <button type="button" className="action-btn" onClick={() => confirm("camera", true)}>{t("diag.phone.see")}</button>
                  <button type="button" className="action-btn" onClick={() => confirm("camera", false)}>{t("diag.phone.noPicture")}</button>
                </div>
              </div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
