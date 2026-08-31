// Wave W (w-walls-spec.md, 2026-08-31), W5 — Studio is laptop/PC-only. The
// 3D editor needs real screen room; below this width the route shows a
// plain full-screen note instead (ModelStudio.tsx), no other device
// sniffing. Pulled out as a pure function so the threshold is one place and
// unit-testable without mounting the page.

export const STUDIO_MIN_WIDTH_PX = 900;

/** True when the viewport is too narrow for the Studio editor. */
export function isStudioTooNarrow(widthPx: number): boolean {
  return widthPx < STUDIO_MIN_WIDTH_PX;
}
