// React binding for unsavedWork.ts.
//
// The claim is held for exactly as long as `active` is true, and released by
// the effect cleanup — on the flag going false or on unmount — so no surface
// can forget to release. Which states count as "unsaved" is the caller's
// judgement, and the bar is durability: a claim is released when the thing is
// saved on the phone or queued to send, when its words have been put into a
// field, or when the person deliberately discarded it. Stopping a microphone
// or closing a camera on its own is not enough — the bytes are still only in
// memory at that point.

import { useEffect } from "react";
import { claimUnsavedWork } from "./unsavedWork";

export function useUnsavedWorkWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return claimUnsavedWork();
  }, [active]);
}
