import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { DISPLAY_MODE_KEY, DisplayModeContext, displayLayout, parseDisplayMode, readDisplayMode, type DisplayMode } from "../lib/displayMode";

/** One presentation preference; never remount the app or change role/data state. */
export function DisplayModeProvider({ children }: { children: ReactNode }) {
  // The workshop frame overrides presentation locally; it must never change
  // the person's shared preference or flip their other open app tabs.
  const [phonePreview] = useState(() => {
    if (import.meta.env.MODE !== "workshop" || window.self === window.top) return false;
    const hinted = new URLSearchParams(window.location.search).get("workshopPhone") === "1";
    try {
      if (hinted) sessionStorage.setItem("forge.workshop.frame-phone", "1");
      return hinted || sessionStorage.getItem("forge.workshop.frame-phone") === "1";
    } catch { return hinted; }
  });
  const [mode, updateMode] = useState<DisplayMode>(readDisplayMode);
  const [width, setWidth] = useState(() => window.innerWidth);
  const layout = phonePreview ? "phone" : displayLayout(mode, width);
  const setMode = useCallback((next: DisplayMode) => {
    updateMode(next);
    try {
      if (next === "auto") localStorage.removeItem(DISPLAY_MODE_KEY);
      else localStorage.setItem(DISPLAY_MODE_KEY, next);
    } catch { /* The choice still works for this session when storage is blocked. */ }
  }, []);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    const storage = (event: StorageEvent) => {
      if (event.key === DISPLAY_MODE_KEY || event.key === null) {
        updateMode(event.key === null ? "auto" : parseDisplayMode(event.newValue));
      }
    };
    window.addEventListener("resize", resize);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.displayLayout = layout;
    return () => { delete document.documentElement.dataset.displayLayout; };
  }, [layout]);
  const value = useMemo(() => ({ mode, layout, setMode }), [mode, layout, setMode]);
  return <DisplayModeContext.Provider value={value}>{children}</DisplayModeContext.Provider>;
}
