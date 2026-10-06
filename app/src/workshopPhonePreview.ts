// A separate, workshop-only HTML entry: the outer preview never mounts App,
// clock providers or an outbox. Exactly one real app lives in the child frame.
import { admitWorkshopConfig, workshopPageProblems } from "./lib/workshopIsolation";
import { DISPLAY_MODE_KEY } from "./lib/displayMode";

const root = document.getElementById("preview-root")!;
const admission = admitWorkshopConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_WORKSHOP_SUPABASE_REF: import.meta.env.VITE_WORKSHOP_SUPABASE_REF,
  VITE_WORKSHOP_ORIGIN: import.meta.env.VITE_WORKSHOP_ORIGIN,
});
if (import.meta.env.MODE !== "workshop" || !admission.ok ||
    workshopPageProblems(window.location.origin, admission.config).length > 0) {
  root.textContent = "Phone preview is available only in the isolated Forge Workshop.";
} else {
  const priorKey = "forge.workshop.phone-prior-mode";
  // Repair the earlier preview's temporary setting once, if this tab used it.
  // The current preview never writes the shared display preference.
  try {
    const previous = sessionStorage.getItem(priorKey);
    if (previous !== null) {
      if (previous !== "auto") localStorage.setItem(DISPLAY_MODE_KEY, previous);
      else localStorage.removeItem(DISPLAY_MODE_KEY);
      sessionStorage.removeItem(priorKey);
    }
  } catch { /* The iframe override remains independent of storage. */ }
  const frame = document.createElement("iframe");
  frame.title = "Forge Workshop phone app";
  frame.src = `${import.meta.env.BASE_URL}?workshopPhone=1`;
  const shell = document.getElementById("phone-frame")!;
  const stage = document.getElementById("phone-stage")!;
  const fit = () => {
    // Scale the picture on a narrow Codex panel without changing the iframe's
    // real layout width. A 390px choice always remains a 390px app viewport.
    const scale = Math.min(1, stage.clientWidth / shell.offsetWidth);
    shell.style.transform = `translateX(-50%) scale(${scale})`;
    stage.style.height = `${Math.ceil(shell.offsetHeight * scale)}px`;
  };
  shell.appendChild(frame);
  fit();
  window.addEventListener("resize", fit);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(stage);
  const widths = document.getElementById("phone-width") as HTMLSelectElement;
  widths.addEventListener("change", () => {
    shell.style.setProperty("--phone-width", widths.value === "320" ? "320px" : "390px");
    fit();
  });
  (document.getElementById("exit-preview") as HTMLAnchorElement).href = import.meta.env.BASE_URL;
  const banner = document.getElementById("forge-workshop-banner");
  const inset = () => { root.style.paddingTop = `${Math.ceil(banner?.getBoundingClientRect().height ?? 0) + 16}px`; };
  inset();
  if (banner && typeof ResizeObserver !== "undefined") new ResizeObserver(inset).observe(banner);
}
