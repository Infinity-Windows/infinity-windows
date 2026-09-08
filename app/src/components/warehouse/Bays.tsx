// The bays (owner call 2026-09-06): one per job, where material set aside
// for that job waits. Drawn on their own view, apart from the boxes, because
// eleven "X bay" tiles between Conex 4 and the Black Trailer hid the yard.
// Each bay can be turned off from here once the job's material has gone
// out — the same archive rule a box has (empty first), and a job gets a
// fresh bay on its own the next time something is set aside for it.
import { Link } from "react-router-dom";
import { bayOffBlock, type YardTile } from "../../lib/warehouse/yard";
import { useT } from "../../lib/i18n";

export function Bays({
  bays,
  busyId,
  onTurnOff,
}: {
  bays: YardTile[];
  /** The bay whose turn-off is in flight, so its button reads as working. */
  busyId: string | null;
  onTurnOff: (bay: YardTile) => void;
}) {
  const t = useT();
  if (bays.length === 0) {
    return <p className="muted bays-empty">{t("warehouse.bays.empty")}</p>;
  }
  return (
    <div className="yard bays" role="list" aria-label={t("warehouse.bays.ariaLabel")}>
      {bays.map((b) => {
        const block = bayOffBlock(b, t);
        return (
          <div
            key={b.id}
            role="listitem"
            className={`yard-box yard-box--bay${b.glow ? " yard-box--glow" : ""}${b.inside === 0 ? " yard-box--idle" : ""}`}
            data-testid="bay"
          >
            <Link to={`/storage/c/${b.id}`} className="yard-name bay-name">
              {b.name}
            </Link>
            <span className="yard-line">
              {b.inside === 0
                ? t("warehouse.bays.nothingSetAside")
                : t(b.inside === 1 ? "warehouse.bays.line.one" : "warehouse.bays.line.many", {
                    n: b.inside,
                    oldest: b.oldestDays > 0 ? ` · ${t("warehouse.yard.oldest", { n: b.oldestDays })}` : "",
                  })}
            </span>
            {b.inside > 0 ? (
              <span className="yard-stripe" aria-hidden="true">
                {b.jobs.map((j) => (
                  <i
                    key={j.projectId ?? "boneyard"}
                    style={{ flex: j.count, background: `oklch(0.62 0.15 ${j.hue})` }}
                    title={`${j.jobCode} ×${j.count}`}
                  />
                ))}
              </span>
            ) : (
              <span className="yard-stripe yard-stripe--empty" aria-hidden="true" />
            )}
            <button
              type="button"
              className="button-like bay-off"
              disabled={!!block || busyId === b.id}
              title={block ?? t("warehouse.bays.turnOffHint")}
              onClick={() => onTurnOff(b)}
            >
              {busyId === b.id ? t("warehouse.bays.turningOff") : t("warehouse.bays.turnOff")}
            </button>
          </div>
        );
      })}
    </div>
  );
}
