import { lazy, Suspense, type RefObject } from "react";
const DictationButton = lazy(() => import("./DictationButton").then(module => ({default:module.DictationButton})));
export function VoiceControl({fieldRef}: {fieldRef:RefObject<HTMLInputElement | HTMLTextAreaElement | null>}) {
  return <Suspense fallback={null}><DictationButton fieldRef={fieldRef} /></Suspense>;
}
