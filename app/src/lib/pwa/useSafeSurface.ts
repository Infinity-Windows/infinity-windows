// React bindings for safeSurface.ts. A claim that is returned straight out of
// an effect is the shape that cannot leak on unmount, so every screen and
// sheet uses one of these two hooks rather than calling the registry itself.

import { useEffect } from "react";
import { claimOverlay, claimSafeSurface } from "./safeSurface";

/**
 * Declare the screen calling this a safe surface for as long as it is
 * mounted. Only for a screen someone has read and can say holds nothing —
 * see safeSurface.ts for the short list.
 */
export function useSafeSurface(): void {
  useEffect(() => claimSafeSurface(), []);
}

/**
 * Declare that a sheet, drawer or dialog is open on top of the screen while
 * `open` is true. `useFocusTrap` calls this for every modal it traps, so most
 * sheets get it for free; a dialog that traps no focus calls it itself.
 */
export function useOverlayWhile(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    return claimOverlay();
  }, [open]);
}
