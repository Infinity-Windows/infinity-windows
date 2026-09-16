import { useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { VoiceControl } from "./VoiceControl";
import "./dictation.css";

export function VoiceTextarea({ ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {ref?: Ref<HTMLTextAreaElement>}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  return <span className="voice-field">
    <textarea {...props} ref={element => {
      fieldRef.current = element;
      if (typeof ref === "function") return ref(element);
      else if (ref) ref.current = element;
    }} />
    {!props.disabled && !props.readOnly && <VoiceControl fieldRef={fieldRef} />}
  </span>;
}
