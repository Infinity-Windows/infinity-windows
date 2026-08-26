// One hub card's rows (warehouse ticket 06). Every number on the Warehouse
// page opens here, so a count always has something behind it.
//
// "Not tagged" is the odd one and deliberately so: it counts scheduled marks
// with NO package, so there are no package rows to show — it lists the marks
// themselves, which is the actual to-do list ("go find window 17, or admit it
// hasn't arrived").
//
// Moved here from the Storage hub when it merged into /warehouse (ticket 18);
// `cardLink()` points every stat-card number at `/warehouse?card=…` now.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { normalizeMarkCode } from "../../lib/fitview/adapter";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import {
  cardPackages,
  listMarkSpecTypes,
  listOpeningRefs,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  type CardId,
} from "../../lib/warehouse/warehouseCards";
import { PackageRowText } from "./PackageRowText";

export function CardList({
  card,
  packages,
  containers,
  jobCode,
}: {
  card: CardId;
  packages: StoragePackage[];
  containers: StorageContainer[];
  jobCode: Map<string, string>;
}) {
  const def = WAREHOUSE_CARDS.find((c) => c.id === card)!;
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Excludes testing projects, same reason as the Warehouse page: otherwise
  // a testing job's scheduled marks never find a match among `packages`
  // (already real-only, passed in from the parent) and pile up here forever.
  const activeIds = useMemo(
    () => (projects.data ?? []).filter((p) => !p.is_test).map((p) => p.id),
    [projects.data],
  );
  const marks = useQuery({
    queryKey: ["scheduledMarks", activeIds],
    queryFn: () => listScheduledMarks(activeIds),
    enabled: card === "not-tagged" && activeIds.length > 0,
  });

  const rows = cardPackages(card, packages, containers);
  const missing = card === "not-tagged" ? untaggedMarks(packages, marks.data ?? []) : [];
  // The doors and the types for the Not-Tagged rows (ticket 20). A dead row
  // teaches people the list is a dead end; each one now opens its window.
  const missingProjects = useMemo(
    () => [...new Set(missing.map((m) => m.project_id))],
    [missing],
  );
  const openings = useQuery({
    queryKey: ["openingRefs", missingProjects],
    queryFn: () => listOpeningRefs(missingProjects),
    enabled: card === "not-tagged" && missingProjects.length > 0,
  });
  const specTypes = useQuery({
    queryKey: ["markSpecTypes", missingProjects],
    queryFn: () => listMarkSpecTypes(missingProjects),
    enabled: card === "not-tagged" && missingProjects.length > 0,
  });
  const openingFor = (projectId: string, mark: string) =>
    (openings.data ?? []).find(
      (o) =>
        o.project_id === projectId &&
        normalizeMarkCode(o.opening_code) === normalizeMarkCode(mark),
    );
  const typeFor = (projectId: string, mark: string) => {
    const s = (specTypes.data ?? []).find(
      (t) => t.project_id === projectId && t.mark_code === mark,
    );
    return s?.operation ?? s?.style ?? null;
  };

  return (
    <>
      <h2 style={{ textTransform: "capitalize" }}>{def.label}</h2>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
        {def.blurb}
      </p>

      {card === "not-tagged" ? (
        <div className="home-projects">
          {missing.map((m) => {
            const opening = openingFor(m.project_id, m.mark_code);
            const type = typeFor(m.project_id, m.mark_code);
            const body = (
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    Window {m.mark_code}
                    {type && (
                      <span className="muted" style={{ fontWeight: 400 }}>
                        {" "}· {type}
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {jobCode.get(m.project_id) ?? "?"} · nothing tagged yet
                    {!opening && openings.isSuccess
                      ? " · no spec page yet — spec review adds it"
                      : ""}
                  </div>
                </div>
                {opening && <span className="muted">›</span>}
              </div>
            );
            return opening ? (
              <Link
                key={`${m.project_id}-${m.mark_code}`}
                to={`/projects/${m.project_id}/opening/${opening.id}`}
                className="project-card home-project"
              >
                {body}
              </Link>
            ) : (
              <div
                key={`${m.project_id}-${m.mark_code}`}
                className="project-card home-project"
              >
                {body}
              </div>
            );
          })}
          {missing.length === 0 && (
            <p className="muted">
              Every window on every active job has at least one package tagged.
            </p>
          )}
        </div>
      ) : (
        <div className="home-projects">
          {rows.map((p) => (
            <Link key={p.id} to={`/pkg/${p.serial}`} className="project-card home-project">
              <div className="home-project-head">
                <PackageRowText p={p} jobCode={jobCode} />
                <span className="muted">›</span>
              </div>
            </Link>
          ))}
          {rows.length === 0 && <p className="muted">Nothing here — good.</p>}
        </div>
      )}
      <Link className="button-like" to="/warehouse">
        Clear filter
      </Link>
    </>
  );
}
