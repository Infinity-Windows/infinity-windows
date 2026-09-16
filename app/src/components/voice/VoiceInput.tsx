import { useRef, type InputHTMLAttributes } from "react";
import { VoiceControl } from "./VoiceControl";
import "./dictation.css";

/** For existing single-line descriptions; numbers, names and codes stay plain inputs. */
export function VoiceInput({voiceDisabled = false, ...props}: InputHTMLAttributes<HTMLInputElement> & {voiceDisabled?: boolean}) {
  const fieldRef = useRef<HTMLInputElement | null>(null);
  if (voiceDisabled) return <input {...props} />;
  return <span className="voice-field">
    <input {...props} ref={fieldRef} />
    {!props.disabled && !props.readOnly && <VoiceControl fieldRef={fieldRef} />}
  </span>;
}
