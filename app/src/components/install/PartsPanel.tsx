// Parts — "do I have everything for this window?" on the unit's own sheet
// (warehouse ticket 03, grill Q34).
//
// One row per package tagged with this window's mark: which piece the label
// says it is, its sticker, and where it sits right now. The verdict on top is
// computed by lib/warehouse/unitParts — green only when every numbered piece
// is accounted for, and never a claim the labels didn't make.
//
// Raw facts about one unit, so every role sees it (CONTEXT.md: the Record's
// rule). The manufacturer's own number shows only when it differs — visible
// when it matters, never noise (grill Q34).

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { markBase } from "../../lib/install/extract";
import {
  listActivePackages,
  listContainers,
  partLabel,
} from "../../lib/storage";
import { partsHeadline, unitParts } from "../../lib/warehouse/unitParts";
import { Explain } from "../ui/Explain";

const TONE_COLOR = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  muted: "var(--muted)",
} as const;

export function PartsPanel({
  projectId,
  openingCode,
}: {
  projectId: string;
  openingCode: string | null | undefined;
}) {
  // Same query keys as the storage hub, so the sheet rides its cache.
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });

  const mark = openingCode ? markBase(openingCode).toUpperCase() : null;
  const report = useMemo(
    () => (mark ? unitParts(packages.data ?? [], projectId, mark) : null),
    [packages.data, projectId, mark],
  );

  const containerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of containers.data ?? []) m.set(c.id, c.name);
    return m;
  }, [containers.data]);

  if (!mark || !report) return null;
  const head = partsHeadline(report);

  const where = (p: (typeof report.rows)[number]): string => {
    if (p.status === "stored") {
      return p.container_id ? (containerName.get(p.container_id) ?? "in storage") : "in storage";
    }
    if (p.status === "checked_out") return "checked out";
    return "tagged — not stored yet";
  };

  return (
    <div className="detail-card">
      <h2 style={{ marginTop: 0 }}>Parts</h2>
      <Explain id="opening-parts">
        A window arrives as one or more packages, and the label&rsquo;s &ldquo;#16 2/3&rdquo;
        says which piece each one is. This lists every package tagged for this window and
        where it sits right now. Stickers go on at Receive; take a package out through
        Check out so the trail stays whole.
      </Explain>

      <p style={{ margin: "4px 0 8px", fontWeight: 600, color: TONE_COLOR[head.tone] }}>
        {head.text}
      </p>

      {report.rows.length > 0 && (
        <ul className="unit-list" style={{ margin: 0 }}>
          {report.rows.map((p) => (
            <li key={p.id} className="find-row">
              <Link to={`/pkg/${p.serial}`} style={{ minWidth: 0 }}>
                <strong>{partLabel(p) ?? "No part number on label"}</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.short_code ?? p.serial} · {where(p)}
                  {p.mfr_mark ? ` · their #${p.mfr_mark}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {report.rows.length === 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Stickers go on at Receive when the truck arrives — tagged packages show up here
          on their own.
        </p>
      )}
    </div>
  );
}
