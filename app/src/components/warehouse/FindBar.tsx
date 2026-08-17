// The question the warehouse exists to answer, pinned so it never scrolls
// away (warehouse ticket 08, grill Q3/Q4).
//
// Typed and scanned go down the same path. The answer is the CHAIN — unit ->
// package -> crate -> conex — not a list of results to dig through.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ScanLine, X } from "lucide-react";
import { Scanner } from "../Scanner";
import type { QrPayload } from "../../lib/qr";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { partLabel } from "../../lib/storage";
import {
  findInWarehouse,
  type FindAnswer,
  type PackageHit,
  type UnitLike,
} from "../../lib/warehouse/find";

/** Pull a searchable string out of any scanned payload. */
function payloadQuery(p: QrPayload): string | null {
  switch (p.kind) {
    case "packageSerial":
      return p.serial;
    case "containerSerial":
      return p.serial;
    case "window":
      return p.windowId;
    case "windowCode":
      return p.code;
    case "windowSerial":
      return p.serial;
    case "location":
      return p.address;
    case "locationSerial":
      return p.serial;
    default:
      return null;
  }
}

export function FindBar({
  packages,
  containers,
  projects,
  scheduledMarks,
  units,
}: {
  packages: StoragePackage[];
  containers: StorageContainer[];
  projects: { id: string; job_code: string; name: string | null }[];
  scheduledMarks: { project_id: string; mark_code: string }[];
  units: UnitLike[];
}) {
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);

  const answer = useMemo(
    () => findInWarehouse(query, { packages, containers, projects, scheduledMarks, units }),
    [query, packages, containers, projects, scheduledMarks, units],
  );

  return (
    <div className="wh-find">
      <div className="locate-search">
        <input
          placeholder="Find: window 16, PKG-000123, W-DH3252-0001, S-01-A, Conex 3, BLACK22…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find anything in the warehouse"
        />
        {query ? (
          <button className="locate-go" onClick={() => setQuery("")} aria-label="Clear">
            <X size={18} />
          </button>
        ) : (
          <button
            className="locate-go"
            onClick={() => setScanning((v) => !v)}
            aria-label="Scan"
          >
            <ScanLine size={20} />
          </button>
        )}
      </div>

      {scanning && (
        <Scanner
          onScan={(p) => {
            const q = payloadQuery(p);
            if (q) {
              setQuery(q);
              setScanning(false);
            }
          }}
        />
      )}

      {answer && <Answer answer={answer} />}
    </div>
  );
}

function Rows({ hits }: { hits: PackageHit[] }) {
  if (hits.length === 0) return null;
  return (
    <ul className="unit-list" style={{ margin: "6px 0 0" }}>
      {hits.map(({ pkg, where }) => (
        <li key={pkg.id} className="find-row">
          <Link to={`/pkg/${pkg.serial}`} style={{ minWidth: 0 }}>
            <strong>{partLabel(pkg) ?? (pkg.short_code ?? pkg.serial)}</strong>{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              {pkg.short_code ?? pkg.serial} · {where}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Answer({ answer }: { answer: FindAnswer }) {
  if (answer.kind === "miss") {
    return (
      <div className="wh-answer">
        <strong>Nothing found for “{answer.query}”</strong>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {answer.suggestion}
        </p>
      </div>
    );
  }

  if (answer.kind === "unit") {
    const tone =
      answer.report.complete === true
        ? "ok"
        : answer.report.complete === false || answer.report.totalsDisagree
          ? "warn"
          : undefined;
    return (
      <div className={`wh-answer${tone ? ` tone-${tone}` : ""}`}>
        <strong>
          Window {answer.markCode} · {answer.jobCode}
        </strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{answer.headline}</p>
        <Rows hits={answer.hits} />
      </div>
    );
  }

  if (answer.kind === "unit-row") {
    const u = answer.unit;
    return (
      <div className="wh-answer">
        <strong>{u.window_id}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>
          {u.window_types?.name ?? u.window_types?.type_code ?? "window"} — {answer.where}
        </p>
        <Link className="button-like" style={{ marginTop: 8 }} to={`/w/${encodeURIComponent(u.window_id)}`}>
          Open this window
        </Link>
      </div>
    );
  }

  if (answer.kind === "slot") {
    return (
      <div className="wh-answer">
        <strong>{answer.address}</strong>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          {answer.units.length} window{answer.units.length === 1 ? "" : "s"} on this shelf
        </p>
        <ul className="unit-list" style={{ margin: "6px 0 0" }}>
          {answer.units.map((u) => (
            <li key={u.id} className="find-row">
              <Link to={`/w/${encodeURIComponent(u.window_id)}`} style={{ minWidth: 0 }}>
                <strong>{u.window_id}</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  {u.window_types?.type_code ?? ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Rows hits={answer.hits} />
      </div>
    );
  }

  if (answer.kind === "package") {
    const { pkg, where } = answer.hit;
    return (
      <div className="wh-answer">
        <strong>{pkg.short_code ?? pkg.serial}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>
          {partLabel(pkg) ?? "No part number on label"} — {where}
        </p>
        <Link className="button-like" style={{ marginTop: 8 }} to={`/pkg/${pkg.serial}`}>
          Open its history
        </Link>
      </div>
    );
  }

  const title =
    answer.kind === "container" ? answer.container.name : answer.jobCode;
  const sub =
    answer.kind === "container"
      ? `${answer.hits.length} package${answer.hits.length === 1 ? "" : "s"} inside`
      : `${answer.hits.length} package${answer.hits.length === 1 ? "" : "s"} tagged for this job`;
  return (
    <div className="wh-answer">
      <strong>{title}</strong>
      <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>{sub}</p>
      <Rows hits={answer.hits.slice(0, 12)} />
      {answer.kind === "container" && (
        <Link
          className="button-like"
          style={{ marginTop: 8 }}
          to={`/storage/c/${answer.container.id}`}
        >
          Open {answer.container.name}
        </Link>
      )}
    </div>
  );
}
