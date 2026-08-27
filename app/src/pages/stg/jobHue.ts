// Stable per-job hue for the STG calendar's dots/labels. Checked before
// writing this: lib/schedule/jobHue.ts does not exist on master yet, so
// this is the tiny LOCAL hash function the spec allows in that case — scoped
// to app/src/pages/stg only. If a shared lib/schedule/jobHue.ts lands later,
// this can delegate to (or be deleted in favor of) it; deduping the two is
// explicitly fine to leave for then, not a blocker now.
export function jobHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}
