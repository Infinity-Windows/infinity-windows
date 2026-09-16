import { VoiceTextarea } from "../voice/VoiceTextarea";
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Keep saved and newly typed reports readable without a second scroll box.
 * Re-measure width too: rotating a phone changes the number of wrapped lines. */
export function LogTextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    const style = getComputedStyle(field);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    field.style.height = `${field.scrollHeight + border}px`;
  };
  useLayoutEffect(resize, [props.value]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  return <VoiceTextarea {...props} ref={ref} />;
}
