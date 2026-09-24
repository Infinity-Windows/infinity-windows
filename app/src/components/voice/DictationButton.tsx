import { useEffect, useRef, useState, type RefObject } from "react";
import { Mic, Square, X } from "lucide-react";
import { useLanguage, useT } from "../../lib/i18n";
import { appendDictation, transcribeDescription } from "../../lib/dictation";
import { startVoiceRecording, voiceFilename, type VoiceRecording } from "../../lib/voiceRecording";
import { useUnsavedWorkWhile } from "../../lib/pwa/useUnsavedWork";
import "./dictation.css";

type Field = HTMLTextAreaElement | HTMLInputElement;

export function DictationButton({ fieldRef }: { fieldRef: RefObject<Field | null> }) {
  const t = useT();
  const { lang } = useLanguage();
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing" | "retry">("idle");
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState("");
  const [overflowText, setOverflowText] = useState("");
  const recorder = useRef<VoiceRecording | null>(null);
  const micRequest = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  /** Audio captured whose words have not been put into the field yet. */
  const [unapplied, setUnapplied] = useState(false);
  // The recording exists only in this component's memory from the moment the
  // microphone is asked for until its words land in the field: opening the
  // mic, recording, transcribing, a failed transcription waiting for Retry, a
  // clip whose words did not fit. An automatic app update reloading the page
  // during any of those destroys the memo (independent review, 2026-09-23 —
  // the update window saw no typing and no claim and reloaded over a live
  // recording). Released only when the words are applied or the person
  // cancels; stopping the mic alone is not durability.
  useUnsavedWorkWhile(phase !== "idle" || unapplied);
  useEffect(() => {
    if (!preview) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(preview); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  const clip = useRef<Blob | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const discard = () => {
    generation.current++;
    request.current?.abort();
    micRequest.current?.abort();
    recorder.current?.cancel();
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
      if (!text.trim()) { setMessage(t("dictation.empty")); setPhase("retry"); return; }
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
        setUnapplied(false);
      }
      clip.current = null;
      setPhase("idle");
    } catch (error) {
      if (token !== generation.current) return;
      const code = error instanceof Error ? error.message : "";
      setMessage(t(code === "daily_limit" || code === "dictation_limit" ? "dictation.limit" : code === "offline" ? "dictation.offline" : code === "transcription_timeout" ? "dictation.timeout" : "dictation.failed"));
      setPhase("retry");
    }
  };

  const start = async () => {
    const token = ++generation.current;
    setPhase("starting"); setMessage(""); setOverflowText(""); setSeconds(0);
    micRequest.current = new AbortController();
    try {
      recorder.current = await startVoiceRecording({
        signal: micRequest.current.signal,
        onSeconds: setSeconds,
        onError: () => { if (token === generation.current) { setMessage(t("dictation.recordingFailed")); setPhase("idle"); } },
        onComplete: audio => {
          if (token !== generation.current) return;
          clip.current = audio; setPreview(audio); setUnapplied(true);
          void transcribe(audio, token);
        },
      });
      if (token === generation.current) setPhase("recording");
    } catch (error) {
      if (token !== generation.current) return;
      const code = error instanceof Error ? error.message : "";
      setPhase("idle");
      setMessage(t(code === "microphone_busy" ? "dictation.otherField" : code === "microphone_unsupported" ? "dictation.unsupported" : "dictation.permission"));
    }
  };
  return (
    <span className="dictation-controls" onClick={e => { if (!(e.target instanceof Element && e.target.closest("audio, a"))) e.preventDefault(); e.stopPropagation(); }}>
      <span className="dictation-buttons">
        {phase === "idle" && <button type="button" className="dictation-button" aria-label={t("dictation.start")} onClick={() => void start()}><Mic size={16} aria-hidden="true" /><span aria-hidden="true">{t("dictation.start")}</span></button>}
        {phase === "starting" && <span role="status">{t("dictation.starting")}</span>}
        {phase === "recording" && <button type="button" className="dictation-button is-recording" onClick={() => recorder.current?.stop()}><Square size={14} aria-hidden="true" />{t("dictation.stop")} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</button>}
        {phase === "transcribing" && <span role="status">{t("dictation.transcribing")}</span>}
        {phase === "retry" && <button type="button" className="dictation-button" onClick={() => clip.current && void transcribe(clip.current, generation.current)}>{t("dictation.retry")}</button>}
        {phase !== "idle" && <button type="button" className="dictation-button" aria-label={t("dictation.cancel")} onClick={() => {discard(); setPreview(null); setUnapplied(false); setPhase("idle"); setMessage("");}}><X size={16} aria-hidden="true" />{t("dictation.cancel")}</button>}
      </span>
      {previewUrl && phase !== "recording" && phase !== "starting" && <span className="dictation-preview">
        <audio controls preload="metadata" src={previewUrl} aria-label={t("dictation.playback")} />
        <a href={previewUrl} download={voiceFilename(preview!, "forge-recording")}>{t("dictation.download")}</a>
      </span>}
      {message && <span className="dictation-message" role="status">{message}</span>}
      {overflowText && <span className="dictation-overflow">{overflowText}</span>}
    </span>
  );
}
