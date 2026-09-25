import { Suspense, type RefObject } from "react";
import { lazyOptional } from "../../lib/pwa/lazyOptional";
// The mic is an extra on a notes field, never the field itself. When its code
// cannot download (one bar, or a deploy renamed it), the field renders without
// it and keeps working; it used to take the whole app down (crash report 8WEYC,
// 2026-09-22 — see lib/pwa/lazyOptional.tsx).
const DictationButton = lazyOptional(() => import("./DictationButton").then(module => ({default:module.DictationButton})));
export function VoiceControl({fieldRef}: {fieldRef:RefObject<HTMLInputElement | HTMLTextAreaElement | null>}) {
  return <Suspense fallback={null}><DictationButton fieldRef={fieldRef} /></Suspense>;
}
