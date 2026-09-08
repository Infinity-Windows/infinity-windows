// The question the warehouse exists to answer, pinned so it never scrolls
// away (warehouse ticket 08, grill Q3/Q4).
//
// Typed and scanned go down the same path. The answer is the CHAIN — unit ->
// package -> crate -> conex — not a list of results to dig through.

import { useEffect, useMemo, useState } from "react";
import { unitHref } from "../../lib/warehouse/materialsScope";
import { Link } from "react-router-dom";
import { ScanLine, X } from "lucide-react";
import { Scanner } from "../Scanner";
import type { QrPayload } from "../../lib/qr";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { partLabel } from "../../lib/storage";
import type { PlaceLocation } from "../../lib/warehouse/containment";
import {
  findInWarehouse,
  type FindAnswer,
  type PackageHit,
  type FindInputs,
} from "../../lib/warehouse/find";
import { useT, type TFn } from "../../lib/i18n";

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
  supplies = [],
  locationsById,
  initialQuery,
  jobsWithModels,
  onAnswer,
}: {
  /** The yard lights up the boxes an answer points at (wave 3). */
  onAnswer?: (answer: FindAnswer | null) => void;
  packages: StoragePackage[];
  containers: StorageContainer[];
  projects: { id: string; job_code: string; name: string | null }[];
  scheduledMarks: { project_id: string; mark_code: string }[];
  supplies?: FindInputs["supplies"];
  /** Racks and staging bays, so a staged package names its job instead of
   * making somebody read a slot address. */
  locationsById: Map<string, PlaceLocation>;
  /** Prefills the box — a deep link from Studio/JobModelViewer's "Find it
   * in the warehouse" (#15) lands here already asking the right question,
   * instead of making somebody retype the mark they just tapped. */
  initialQuery?: string;
  /** Job ids with a saved Studio model (Studio 100x #16's door): gates the
   * "Show on the building" link on a window answer so it never points at
   * a job with nothing to show. */
  jobsWithModels?: Set<string>;
}) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [scanning, setScanning] = useState(false);
  /** The job picked when one mark belonged to more than one job — a real
   * job by id, or a waiting job by its typed name. */
  const [markChoice, setMarkChoice] = useState<{
    projectId: string | null;
    pendingName: string | null;
  } | null>(null);

  const answer = useMemo(
    () =>
      findInWarehouse(
        query,
        { packages, containers, projects, scheduledMarks, supplies, locationsById },
        {
          markProjectId: markChoice?.projectId ?? undefined,
          markPendingName: markChoice?.pendingName ?? undefined,
        },
        t,
      ),
    [
      query,
      packages,
      containers,
      projects,
      scheduledMarks,
      supplies,
      locationsById,
      markChoice,
      t,
    ],
  );

  // The yard lights up whatever the answer points at (wave 3).
  useEffect(() => {
    onAnswer?.(answer);
  }, [answer, onAnswer]);

  return (
    <div className="wh-find">
      <div className="locate-search">
        <input
          placeholder={t("warehouse.find.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // A new search means the old job pick is about something else.
            setMarkChoice(null);
          }}
          aria-label={t("warehouse.find.ariaFind")}
        />
        {query ? (
          <button
            className="locate-go"
            onClick={() => {
              setQuery("");
              setMarkChoice(null);
            }}
            aria-label={t("warehouse.find.clear")}
          >
            <X size={18} />
          </button>
        ) : (
          <button
            className="locate-go"
            onClick={() => setScanning((v) => !v)}
            aria-label={t("warehouse.find.scan")}
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

      {answer && (
        <Answer
          answer={answer}
          onPickMarkJob={setMarkChoice}
          jobsWithModels={jobsWithModels}
          t={t}
        />
      )}
    </div>
  );
}

function Rows({ hits, t }: { hits: PackageHit[]; t: TFn }) {
  if (hits.length === 0) return null;
  return (
    <ul className="unit-list" style={{ margin: "6px 0 0" }}>
      {hits.map(({ pkg, where }) => (
        <li key={pkg.id} className="find-row">
          <Link to={`/pkg/${pkg.serial}`} style={{ minWidth: 0 }}>
            <strong>{partLabel(pkg, t) ?? (pkg.short_code ?? pkg.serial)}</strong>{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              {pkg.short_code ?? pkg.serial} · {where}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Answer({
  answer,
  onPickMarkJob,
  jobsWithModels,
  t,
}: {
  answer: FindAnswer;
  onPickMarkJob: (pick: { projectId: string | null; pendingName: string | null }) => void;
  jobsWithModels?: Set<string>;
  t: TFn;
}) {
  if (answer.kind === "miss") {
    return (
      <div className="wh-answer">
        <strong>{t("warehouse.find.headline.miss", { query: answer.query })}</strong>
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
        <strong>{t("warehouse.find.unitTitle", { mark: answer.markCode, job: answer.jobCode })}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{answer.headline}</p>
        <Link
          className="button-like"
          style={{ marginTop: 8 }}
          to={unitHref({ projectId: answer.projectId, pendingName: answer.projectId ? null : answer.jobCode }, answer.markCode)}
        >
          {t("warehouse.find.openUnit")}
        </Link>
        <Rows hits={answer.hits} t={t} />
        {/* Job-building glow (#16's door): only when this job actually has
            a Studio model to show it on — a waiting job never does. */}
        {answer.projectId != null && jobsWithModels?.has(answer.projectId) && (
          <Link
            className="button-like"
            style={{ marginTop: 8 }}
            to={`/projects/${answer.projectId}/model?mark=${encodeURIComponent(answer.markCode)}`}
          >
            {t("warehouse.find.showOnBuilding")}
          </Link>
        )}
      </div>
    );
  }

  if (answer.kind === "mark-choices") {
    return (
      <div className="wh-answer tone-warn">
        <strong>{t("warehouse.find.markMulti.title", { mark: answer.markCode })}</strong>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          {t("warehouse.find.markMulti.hint")}
        </p>
        <ul className="unit-list" style={{ margin: "6px 0 0" }}>
          {answer.choices.map((c) => (
            <li key={c.projectId ?? `pending:${c.pendingName}`} className="find-row">
              <button
                type="button"
                className="link"
                style={{ font: "inherit", textAlign: "left", minWidth: 0 }}
                onClick={() =>
                  onPickMarkJob({ projectId: c.projectId, pendingName: c.pendingName })
                }
              >
                <strong>{c.jobCode}</strong>
                {c.pendingName ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {" "}
                    ({t("warehouse.find.jobNotBuilt")})
                  </span>
                ) : null}{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  {c.headline}
                  {c.where ? ` · ${c.where}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (answer.kind === "supply") {
    return (
      <div className="wh-answer">
        <strong>{answer.name}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{answer.home}</p>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
          {answer.onHand != null
            ? t("warehouse.find.onHand", { n: answer.onHand, unit: answer.unit })
            : t("warehouse.find.neverCounted")}
        </p>
        <Link className="button-like" style={{ marginTop: 8 }} to="/supplies">
          {t("warehouse.find.takeSome")}
        </Link>
      </div>
    );
  }

  if (answer.kind === "slot") {
    // Packages only, since ticket 21 — the shelf names what actually sits on
    // it, and a bay with nothing on it says so instead of "not found".
    return (
      <div className="wh-answer">
        <strong>{answer.address}</strong>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          {answer.hits.length === 0
            ? t("warehouse.find.slotEmpty")
            : t(answer.hits.length === 1 ? "warehouse.find.slotCount.one" : "warehouse.find.slotCount.many", {
                n: answer.hits.length,
              })}
        </p>
        <Rows hits={answer.hits} t={t} />
      </div>
    );
  }

  if (answer.kind === "package") {
    const { pkg, where } = answer.hit;
    return (
      <div className="wh-answer">
        <strong>{pkg.short_code ?? pkg.serial}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>
          {partLabel(pkg, t) ?? t("warehouse.find.noPartNumber")} — {where}
        </p>
        <Link className="button-like" style={{ marginTop: 8 }} to={`/pkg/${pkg.serial}`}>
          {t("warehouse.find.openHistory")}
        </Link>
      </div>
    );
  }

  const title =
    answer.kind === "container"
      ? answer.container.name
      : answer.kind === "pending-job"
        ? `“${answer.name}”`
        : answer.jobCode;
  const sub =
    answer.kind === "container"
      ? // "— at BLACK22" is the address field, which ticket 13 made an honest
        // answer: changing it writes history now, so saying it out loud here
        // no longer repeats a silent edit as fact.
        t(answer.hits.length === 1 ? "warehouse.find.inside.one" : "warehouse.find.inside.many", { n: answer.hits.length }) +
        (answer.container.address ? ` — ${t("warehouse.find.atAddress", { address: answer.container.address })}` : "")
      : answer.kind === "pending-job"
        ? t(answer.hits.length === 1 ? "warehouse.find.pendingWaiting.one" : "warehouse.find.pendingWaiting.many", {
            n: answer.hits.length,
          })
        : t(answer.hits.length === 1 ? "warehouse.find.taggedForJob.one" : "warehouse.find.taggedForJob.many", {
            n: answer.hits.length,
          });
  return (
    <div className="wh-answer">
      <strong>{title}</strong>
      <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>{sub}</p>
      <Rows hits={answer.hits.slice(0, 12)} t={t} />
      {answer.kind === "container" && (
        <Link
          className="button-like"
          style={{ marginTop: 8 }}
          to={`/storage/c/${answer.container.id}`}
        >
          {t("warehouse.find.open", { name: answer.container.name })}
        </Link>
      )}
    </div>
  );
}
