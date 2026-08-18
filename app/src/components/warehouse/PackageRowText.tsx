// One voice for every package list row (owner ask, 2026-08-18): the BIG line
// is what a foreman or installer is scanning the list FOR — the job, the
// window, the part, the piece. The serial and short code drop to the small
// line: they are for the scanner and the label printer, not the eye.
//
// "ZZTEST · #6 1/4 · Frame"           <- bold
// "PKG-000006 · 5QU2AF · not stored"  <- muted

import {
  CATEGORY_LABELS,
  jobLabel,
  pieceLine,
  type StoragePackage,
} from "../../lib/storage";

export function PackageRowText({
  p,
  jobCode,
  extra,
}: {
  p: StoragePackage;
  jobCode: Map<string, string>;
  /** Where it sits / how long it has — the tail of the small line. */
  extra?: string | null;
}) {
  const owner = jobLabel(p, jobCode);
  const piece =
    pieceLine(p) ?? (p.category ? CATEGORY_LABELS[p.category] : null);
  const head = [owner, piece].filter(Boolean).join(" · ");
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600 }}>
        {/* A blank sticker has no story yet — its code IS the headline. */}
        {head || (p.short_code ?? p.serial)}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {p.serial}
        {p.short_code ? ` · ${p.short_code}` : ""}
        {extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );
}
