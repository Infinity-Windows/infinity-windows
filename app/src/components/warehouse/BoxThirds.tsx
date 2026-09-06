// The inside of a box, drawn (warehouse redesign wave 3): front, middle,
// back from the door end, pieces as chips coloured by job, and a row for
// what nobody has placed yet. Tap chips to select, tap a third to put them
// there — one optional tap at put-away instead of nine area buttons on a
// package sheet (owner decision 4, 2026-09-06). Writes go through the offline
// wrapper; an area is still a pointer that clears on every move (ADR-0006).
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { containerHue, packageTitle, type StoragePackage } from "../../lib/storage";
import { setPackageAreaOffline, writeToast } from "../../lib/warehouse/offlineWrites";
import { groupByThird, THIRDS, type Third } from "../../lib/warehouse/boxThirds";

const THIRD_LABEL: Record<Third, string> = { front: "Front · door", middle: "Middle", back: "Back" };

export function BoxThirds({
  stored,
  jobCode,
  glowPieceId,
}: {
  stored: StoragePackage[];
  jobCode: Map<string, string>;
  /** A piece Find pointed at — its chip and its third light up. */
  glowPieceId?: string | null;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const groups = groupByThird(stored);
  const glowThird = (THIRDS.find((t) => groups[t].some((p) => p.id === glowPieceId)) ?? null) as Third | null;

  const place = useMutation({
    mutationFn: async (third: Third) => {
      const ids = [...picked];
      let queued = false;
      for (const id of ids) {
        const r = await setPackageAreaOffline(id, third);
        queued = queued || r.queued;
      }
      return { n: ids.length, third, queued };
    },
    onSuccess: ({ n, third, queued }) => {
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      pushToast(writeToast({ count: n, queued }, `${n === 1 ? "1 piece" : `${n} pieces`} now at the ${third}.`));
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chip = (p: StoragePackage) => {
    const code = p.project_id ? (jobCode.get(p.project_id) ?? "?") : "Boneyard";
    const on = picked.has(p.id);
    return (
      <button
        key={p.id}
        type="button"
        className={`box-chip${on ? " box-chip--on" : ""}${p.id === glowPieceId ? " box-chip--glow" : ""}`}
        style={{ borderColor: `oklch(0.62 0.15 ${containerHue(code)})` }}
        onClick={() => toggle(p.id)}
        aria-pressed={on}
        title={packageTitle(p, jobCode)}
      >
        {packageTitle(p, jobCode)}
      </button>
    );
  };

  return (
    <section className="box-thirds" aria-label="Where in the box">
      <div className="wh-row" style={{ marginBottom: 6 }}>
        <span className="field-label" style={{ margin: 0 }}>Where in the box</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {picked.size > 0 ? `${picked.size} selected — tap a third to put ${picked.size === 1 ? "it" : "them"} there` : "tap pieces, then a third"}
        </span>
      </div>
      <div className="box-thirds-grid">
        {THIRDS.map((t) => (
          <div key={t} className={`box-third${glowThird === t ? " box-third--glow" : ""}`}>
            <button
              type="button"
              className="box-third-head"
              disabled={picked.size === 0 || place.isPending}
              onClick={() => place.mutate(t)}
              aria-label={`Put ${picked.size} selected at the ${t}`}
            >
              {THIRD_LABEL[t]} <span className="muted">· {groups[t].length}</span>
            </button>
            <div className="box-third-body">{groups[t].map(chip)}</div>
          </div>
        ))}
      </div>
      {groups.unplaced.length > 0 ? (
        <div className="box-unplaced">
          <span className="muted" style={{ fontSize: 12.5 }}>Not placed yet · {groups.unplaced.length}</span>
          <div className="box-third-body">{groups.unplaced.map(chip)}</div>
        </div>
      ) : null}
      {picked.size === 1 ? (
        <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
          <Link className="link" to={`/pkg/${stored.find((p) => picked.has(p.id))!.serial}`}>
            Open this piece
          </Link>
        </p>
      ) : null}
    </section>
  );
}
