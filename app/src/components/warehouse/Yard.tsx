// The yard: every box drawn as a box (warehouse redesign wave 3). The
// building is first and widest, a conex shows its door end, crates ride
// inside the box that holds them, and a job stripe says whose material is
// where before any words do. A lit box is where Find's answer sits.
import { Link } from "react-router-dom";
import type { YardTile } from "../../lib/warehouse/yard";
import { useT, type TFn } from "../../lib/i18n";

const KIND_KEYS: Record<string, string> = {
  crate: "warehouse.yard.kind.crate",
  truck: "warehouse.yard.kind.truck",
  trailer: "warehouse.yard.kind.trailer",
  building: "warehouse.yard.kind.building",
  bay: "warehouse.yard.kind.bay",
};

function kindLabel(kind: string, t: TFn): string {
  if (kind === "conex") return "";
  const key = KIND_KEYS[kind];
  return key ? t(key as Parameters<TFn>[0]) : kind;
}

function tileLine(tile: YardTile, t: TFn): string {
  // Same words the old container tiles used, so "1 package · BLACK22 ×1"
  // still reads the same on the page (and in the tests that pin it).
  const jobs = tile.jobs.slice(0, 3).map((j) => `${j.jobCode} ×${j.count}`).join(", ");
  let line = t(tile.inside === 1 ? "warehouse.yard.packages.one" : "warehouse.yard.packages.many", {
    n: tile.inside,
  });
  if (tile.inside > 0 && jobs) line += ` · ${jobs}`;
  if (tile.children.length > 0) {
    line += ` · ${t(tile.children.length === 1 ? "warehouse.yard.holding.one" : "warehouse.yard.holding.many", { n: tile.children.length })}`;
  }
  if (tile.oldestDays > 0) line += ` · ${t("warehouse.yard.oldest", { n: tile.oldestDays })}`;
  return line;
}

export function Yard({ tiles, onAdd }: { tiles: YardTile[]; onAdd: () => void }) {
  const t = useT();
  return (
    <div className="yard" role="list" aria-label={t("warehouse.yard.ariaLabel")}>
      {tiles.map((tile) => (
        <Link
          key={tile.id}
          to={`/storage/c/${tile.id}`}
          role="listitem"
          className={`yard-box yard-box--${tile.kind}${tile.glow ? " yard-box--glow" : ""}${tile.kind === "building" ? " yard-box--wide" : ""}`}
          data-testid="yard-box"
        >
          {tile.kind === "conex" || tile.kind === "truck" || tile.kind === "trailer" ? (
            <span className="yard-door" aria-hidden="true" />
          ) : null}
          <span className="yard-name">{tile.name}</span>
          <span className="yard-kind">{kindLabel(tile.kind, t)}</span>
          <span className="yard-line">{tileLine(tile, t)}</span>
          {tile.inside > 0 ? (
            <span className="yard-stripe" aria-hidden="true">
              {tile.jobs.map((j) => (
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
          {tile.children.length > 0 ? (
            <span className="yard-crates">
              {tile.children.map((c) => (
                <span key={c.id} className={`yard-crate${c.glow ? " yard-crate--glow" : ""}`}>
                  {c.name} · {c.inside}
                </span>
              ))}
            </span>
          ) : null}
        </Link>
      ))}
      <button type="button" className="yard-box yard-box--add" onClick={onAdd}>
        <span className="yard-name">{t("warehouse.yard.newContainer")}</span>
        <span className="yard-line">{t("warehouse.yard.newContainerHint")}</span>
      </button>
    </div>
  );
}
