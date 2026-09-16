import { useEffect, useRef, useState, type RefObject } from "react";
import { Mic, Square, X } from "lucide-react";
import { useLanguage, useT } from "../../lib/i18n";
import { appendDictation, transcribeDescription } from "../../lib/dictation";
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS } from "../../../../supabase/functions/_shared/dictation";
import "./dictation.css";

let recordingOwner: symbol | null = null;
type Field = HTMLTextAreaElement | HTMLInputElement;

export function DictationButton({ fieldRef }: { fieldRef: RefObject<Field | null> }) {
  const t = useT();
  const { lang } = useLanguage();
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing" | "retry">("idle");
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState("");
  const [overflowText, setOverflowText] = useState("");
  const owner = useRef(Symbol("dictation"));
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const clip = useRef<Blob | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (recordingOwner === owner.current) recordingOwner = null;
  };
  const discard = () => {
    generation.current++;
    request.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    clip.current = null;
  };
  useEffect(() => () => discard(), []);

  const transcribe = async (audio: Blob, token: number) => {
    setPhase("transcribing");
    setMessage("");
    request.current = new AbortController();
    try {
      const text = await transcribeDescription(audio, lang, request.current.signal);
      if (token !== generation.current) return;
      const field = fieldRef.current;
      if (!field || field.disabled || field.readOnly) { setPhase("idle"); return; }
      if (!text.trim()) { setMessage(t("dictation.empty")); setPhase("idle"); return; }
      const next = appendDictation(field.value, text, field instanceof HTMLTextAreaElement, field.maxLength);
      if (next === null) {
        setOverflowText(text);
        setMessage(t("dictation.tooMuchText"));
      } else {
        // Use the native setter so React observes a real input event and every
        // existing controlled form keeps its normal validation/save path.
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, next);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.focus({preventScroll: true});
        setMessage(t("dictation.added"));
      }
      clip.current = null;
      setPhase("idle");
    } catch (error) {
      if (token !== generation.current) return;
      const code = error instanceof Error ? error.message : "";
      setMessage(t(code === "daily_limit" || code === "dictation_limit" ? "dictation.limit" : "dictation.failed"));
      setPhase("retry");
    }
  };

  const start = async () => {
    if (recordingOwner && recordingOwner !== owner.current) { setMessage(t("dictation.otherField")); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setMessage(t("dictation.unsupported")); return; }
    if (!navigator.onLine) { setMessage(t("dictation.offline")); return; }
    recordingOwner = owner.current;
    const token = ++generation.current;
    setPhase("starting"); setMessage(""); setOverflowText(""); setSeconds(0);
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({audio: true});
      if (token !== generation.current) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream.current = microphone;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(microphone, { ...(mime ? {mimeType: mime} : {}), audioBitsPerSecond: 64_000 });
      recorder.current = rec;
      const chunks: Blob[] = [];
      let size = 0;
      let failed = false;
      rec.ondataavailable = e => {
        if (e.data.size) { chunks.push(e.data); size += e.data.size; }
        if (size > DICTATION_MAX_BYTES && rec.state === "recording") rec.stop();
      };
      rec.onerror = () => { if (token !== generation.current) return; failed = true; release(); setMessage(t("dictation.clipSize")); setPhase("idle"); };
      rec.onstop = () => {
        if (token !== generation.current || failed) return;
        release();
        if (!size || size > DICTATION_MAX_BYTES) { setMessage(t("dictation.clipSize")); setPhase("idle"); return; }
        const audio = new Blob(chunks, {type: rec.mimeType || mime || "audio/webm"});
        clip.current = audio;
        void transcribe(audio, token);
      };
      rec.start(500);
      setPhase("recording");
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= DICTATION_MAX_SECONDS && rec.state === "recording") rec.stop();
      }, 250);
    } catch {
      if (token !== generation.current) return;
      release(); setPhase("idle"); setMessage(t("dictation.permission"));
    }
  };
  return (
    <span className="dictation-controls" onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
      <span className="dictation-buttons">
        {phase === "idle" && <button type="button" className="dictation-button" aria-label={t("dictation.start")} onClick={() => void start()}><Mic size={16} aria-hidden="true" /><span aria-hidden="true">{t("dictation.start")}</span></button>}
        {phase === "starting" && <span role="status">{t("dictation.starting")}</span>}
        {phase === "recording" && <button type="button" className="dictation-button is-recording" onClick={() => recorder.current?.stop()}><Square size={14} aria-hidden="true" />{t("dictation.stop")} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</button>}
        {phase === "transcribing" && <span role="status">{t("dictation.transcribing")}</span>}
        {phase === "retry" && <button type="button" className="dictation-button" onClick={() => clip.current && void transcribe(clip.current, generation.current)}>{t("dictation.retry")}</button>}
        {phase !== "idle" && <button type="button" className="dictation-button" aria-label={t("dictation.cancel")} onClick={() => {discard(); setPhase("idle"); setMessage("");}}><X size={16} aria-hidden="true" />{t("dictation.cancel")}</button>}
      </span>
      {message && <span className="dictation-message" role="status">{message}</span>}
      {overflowText && <span className="dictation-overflow">{overflowText}</span>}
    </span>
  );
}
