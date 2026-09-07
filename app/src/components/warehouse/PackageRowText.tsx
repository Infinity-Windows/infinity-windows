// One voice for every package list row (owner ask, 2026-08-18; renamed
// 2026-08-26): the BIG line is the package's real name — the same line its
// own sheet shows — job or waiting-job, mark, piece, plus the what-is-it
// word the owner asked to keep. The owner tag (Boneyard / waiting on job),
// serial, and short code drop to the small line: honest, but not the
// headline.
//
// "Hyer Res_Old Mill Estates Lot 47 #33: 1/1 · Glass"  <- bold
// "waiting on job · PKG-000311 · YHGD7N · 1d stored"   <- muted

import {
  categoryLabel,
  jobLabel,
  packageTitle,
  partTypeLabel,
  type PartType,
  type StoragePackage,
} from "../../lib/storage";
import { useT } from "../../lib/i18n";

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
  const t = useT();
  const name = packageTitle(p, jobCode, t);
  // The pool line ("5 pc glass") already names the kind inside the title,
  // and a crate's name IS the word crate ("Mad Moose #CRATE 1") — repeating
  // either after the dot would stutter.
  const kind =
    p.piece_count == null && p.part_type !== "crate"
      ? p.part_type
        ? partTypeLabel(p.part_type as PartType, t)
        : p.category
          ? categoryLabel(p.category, t)
          : null
      : null;
  const owner = jobLabel(p, jobCode, t);
  return (
    <div className="wh-row-main">
      <div className="wh-row-title">
        {/* A blank sticker has no story yet — its code IS the headline. */}
        {p.status === "blank"
          ? (p.short_code ?? p.serial)
          : [name, kind].filter(Boolean).join(" · ")}
      </div>
      <div className="wh-row-sub">
        {owner ? `${owner} · ` : ""}
        {p.serial}
        {p.short_code ? ` · ${p.short_code}` : ""}
        {extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );
}
