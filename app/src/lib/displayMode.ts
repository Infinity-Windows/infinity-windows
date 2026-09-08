import { createContext, useContext } from "react";

export type DisplayMode = "auto" | "phone" | "desktop";
export type DisplayLayout = Exclude<DisplayMode, "auto">;
export const DISPLAY_MODE_KEY = "infinity.display-mode";
export const PHONE_BREAKPOINT = 860;

export function parseDisplayMode(value: string | null): DisplayMode {
  return value === "phone" || value === "desktop" ? value : "auto";
}

export function displayLayout(mode: DisplayMode, width: number): DisplayLayout {
  return mode === "auto" ? (width < PHONE_BREAKPOINT ? "phone" : "desktop") : mode;
}

export function readDisplayMode(): DisplayMode {
  try { return parseDisplayMode(localStorage.getItem(DISPLAY_MODE_KEY)); }
  catch { return "auto"; }
}

export const DisplayModeContext = createContext<{
  mode: DisplayMode;
  layout: DisplayLayout;
  setMode: (mode: DisplayMode) => void;
}>({ mode: "auto", layout: "phone", setMode: () => {} });

export function useDisplayMode() { return useContext(DisplayModeContext); }
