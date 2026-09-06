// The warehouse home is the yard (warehouse redesign wave 3, owner call
// 2026-09-06): a picture of the boxes, one Find bar, the next truck, and the
// problems that need a person — not a directory of buttons.
//
// The audit that led here counted nineteen tappable destinations on this page
// before any fold opened: a five-station strip, four count cards, a recap, job
// tallies, five sections and an "Other tools" fold. Eight menu rows had become
// nineteen buttons. The intended way to find a unit was to type its number and
// read a sentence. Now: Find lights up the box, the box is a box, and every
// door this page ever had is still here — as a chip under the yard, or inside
// the one "More" fold — so nothing lost its address while waves 4 and 5
// retire the screens behind them.
//
// What stayed the same on purpose: every role condition on every door
// (ADR-0007: the warehouse is crew work), the Find bar's logic, the count
// definitions (lib/warehouse/warehouseCards.ts) now read as chips, and the
// "N package · JOB ×n" tile wording.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listLocations, listProjects, listProjectsAnyStatus } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { Explain } from "../components/ui/Explain";
import { FindBar } from "../components/warehouse/FindBar";
import { CardList } from "../components/warehouse/CardList";
import { ContainerForm } from "../components/warehouse/ContainerForm";
import { MintForm } from "../components/warehouse/MintForm";
import { Yard } from "../components/warehouse/Yard";
import { containerPostersPdf, downloadPdf } from "../lib/labels";
import { listJobModelRows } from "../lib/modelstudio/projects";
import { listIssues } from "../lib/issues";
import {
  groupByJob,
  listActivePackages,
  listContainers,
  listDeliveries,
  listMovementsSince,
  type StorageContainer,
} from "../lib/storage";
import { DayRecapCard } from "../components/warehouse/DayRecapCard";
import { dayRecap, localMidnightIso } from "../lib/warehouse/dayRecap";
import { jobTallies, tallyLine } from "../lib/warehouse/jobTally";
import { scopeHref } from "../lib/warehouse/materialsScope";
import { partitionTestPackages, testProjectIds } from "../lib/warehouse/testPartition";
import { filterSuppliesByName, listSupplies, lowStockFirst, onHandLabel } from "../lib/ops";
import { listTakeoffs } from "../lib/takeoffs";
import {
  cardLink,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  warehouseCounts,
  type CardId,
} from "../lib/warehouse/warehouseCards";
import { toLocationsById } from "../lib/warehouse/containment";
import { splitUnits } from "../lib/warehouse/splitUnits";
import { useOutbox } from "../lib/offline/useOutbox";
import { useScanWedge } from "../lib/warehouse/scanWedge";
import type { FindAnswer } from "../lib/warehouse/find";
import { glowFromHits, yardSummary, yardTiles } from "../lib/warehouse/yard";
import { prefetchWarehousePack } from "../lib/queryClient";

/** Stable empties, so a loading cache is not a new array every render. */
const NO_BOXES: StorageContainer[] = [];

export function Warehouse() {
  // Pick 30: a desk-mounted hardware scanner routes straight to the package
  // or container it reads, same as the camera flow.
  useScanWedge();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const supervisor = isSupervisorPlus(effectiveRole);
  const { counts: outbox } = useOutbox();
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? undefined;
  const cardParam = searchParams.get("card");
  const card = WAREHOUSE_CARDS.some((c) => c.id === cardParam) ? (cardParam as CardId) : null;
  const [newContainer, setNewContainer] = useState(false);
  const [minting, setMinting] = useState(false);
  const [answer, setAnswer] = useState<FindAnswer | null>(null);

  useEffect(() => {
    void prefetchWarehousePack();
  }, []);

  const studioJobModels = useQuery({ queryKey: ["studioJobModels"], queryFn: listJobModelRows });
  const jobsWithModels = useMemo(
    () => new Set((studioJobModels.data ?? []).map((r) => r.project_id)),
    [studioJobModels.data],
  );
  const waiting = outbox.warehouse;

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const issues = useQuery({ queryKey: ["issues"], queryFn: listIssues });
  const todayIso = localMidnightIso(new Date());
  const movementsToday = useQuery({
    queryKey: ["movementsSince", todayIso],
    queryFn: () => listMovementsSince(todayIso),
  });
  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const takeoffs = useQuery({ queryKey: ["takeoffs"], queryFn: listTakeoffs });
  const openTakeoffs = (takeoffs.data ?? []).filter(
    (t) => t.status === "requested" || t.status === "acknowledged" || t.status === "ready",
  ).length;

  const [supplyQ, setSupplyQ] = useState("");
  const supplyMatches = useMemo(
    () => lowStockFirst(filterSuppliesByName(supplies.data ?? [], supplyQ)),
    [supplies.data, supplyQ],
  );
  const SUPPLY_ROWS_SHOWN = 12;
  const supplyPreview = supplyMatches.slice(0, SUPPLY_ROWS_SHOWN);

  const testIds = testProjectIds(projects.data ?? []);
  const activeIds = useMemo(
    () => (projects.data ?? []).map((p) => p.id).filter((id) => !testIds.has(id)),
    [projects.data, testIds],
  );
  const marks = useQuery({
    queryKey: ["scheduledMarks", activeIds],
    queryFn: () => listScheduledMarks(activeIds),
    enabled: activeIds.length > 0,
  });

  const rows = packages.data ?? [];
  const boxes = containers.data ?? NO_BOXES;
  const byId = useMemo(() => new Map(boxes.map((c) => [c.id, c])), [boxes]);
  const locsById = useMemo(() => toLocationsById(locations.data ?? []), [locations.data]);
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);
  const openDamage = (issues.data ?? []).filter(
    (i) => i.kind === "damage" && i.status === "open",
  );

  const { real, testing } = partitionTestPackages(rows, testIds);
  const counts = warehouseCounts(real, boxes, marks.data ?? [], openDamage.length);
  const ready = packages.isSuccess && containers.isSuccess;
  const recap = dayRecap(
    movementsToday.data ?? [],
    real,
    (deliveries.data ?? []).map((d) => ({ id: d.id, label: d.label ?? "a delivery" })),
  );
  const untagged = untaggedMarks(real, marks.data ?? []);
  const split = splitUnits(real, byId, locsById);
  const goingOut = real.filter((p) => p.status === "checked_out");
  const testingByJob = groupByJob(testing);

  // What Find points at lights up on the yard.
  const glow = useMemo(() => {
    if (!answer) return new Set<string>();
    if (answer.kind === "container") return glowFromHits(answer.hits, answer.container.id);
    if ("hits" in answer) return glowFromHits(answer.hits);
    if (answer.kind === "package") return glowFromHits([answer.hit]);
    return new Set<string>();
  }, [answer]);
  const tiles = useMemo(
    () => yardTiles(boxes, real, jobCode, new Date(), glow),
    [boxes, real, jobCode, glow],
  );

  // The next truck: the soonest expected delivery that has not arrived.
  const nextTruck = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return (deliveries.data ?? [])
      .filter((d) => !d.arrived_on && d.expected_at && d.expected_at.slice(0, 10) >= today)
      .sort((a, b) => (a.expected_at ?? "").localeCompare(b.expected_at ?? ""))[0] ?? null;
  }, [deliveries.data]);

  const posters = useMutation({
    mutationFn: async (list: StorageContainer[]) => {
      const pdf = await containerPostersPdf(list);
      downloadPdf(pdf, "container-posters.pdf");
    },
    onError: (e) => alert(formatApiError(e)),
  });

  return (
    <div className="page wh-page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Where is it</h1>
        </div>
      </header>

      {/* Pinned: the one question, always on screen. */}
      <FindBar
        packages={rows}
        containers={boxes}
        projects={projects.data ?? []}
        scheduledMarks={marks.data ?? []}
        supplies={supplies.data ?? []}
        locationsById={locsById}
        initialQuery={initialQuery}
        jobsWithModels={jobsWithModels}
        onAnswer={setAnswer}
      />

      {waiting > 0 && (
        <p className="wh-pending">
          {waiting} warehouse {waiting === 1 ? "change is" : "changes are"} saved on
          this phone and not sent yet — they go up on their own when you have
          signal.
        </p>
      )}

      {/* The yard. */}
      <section className="yard-section" aria-label="The yard">
        <div className="wh-row" style={{ marginBottom: 6 }}>
          <span className="muted yard-summary">{ready ? yardSummary(tiles) : "Loading the yard…"}</span>
          <div className="wh-actions">
            <button
              className="button-like"
              disabled={posters.isPending || boxes.length === 0}
              onClick={() => posters.mutate(boxes)}
            >
              All posters
            </button>
          </div>
        </div>
        <Yard tiles={tiles} onAdd={() => setNewContainer(true)} />
        {packages.isError && <p className="error">{formatApiError(packages.error)}</p>}
      </section>

      {/* The next truck — checking one in and logging one both belong to
          whoever is at the tailgate (S3), open to everyone. */}
      <section className="detail-card wh-card yard-truck" aria-label="Next truck">
        <div className="wh-row">
          <div className="wh-row-main">
            <span className="wh-row-title">
              {nextTruck
                ? `Truck ${nextTruck.expected_at!.slice(0, 10)} · ${nextTruck.label ?? "delivery"}`
                : "No truck on the calendar"}
            </span>
            <span className="wh-row-sub">
              {nextTruck ? "Check it against its list when it lands." : "Log one when it lands, or ahead of time."}
            </span>
          </div>
          <div className="wh-actions">
            {nextTruck ? (
              <Link className="button-like active-pill" to={`/storage/d/${nextTruck.id}`}>
                Open its list
              </Link>
            ) : null}
          </div>
        </div>
        <div className="row-gap" style={{ marginTop: 8 }}>
          <Link className="button-like" to="/storage/deliveries">
            Deliveries — check trucks in
          </Link>
          <Link className="button-like" to="/storage/log-delivery">
            Log a delivery (truck)
          </Link>
        </div>
      </section>

      {/* Problems that need a person. The counts ARE the warehouse's health
          (lib/warehouse/warehouseCards.ts), for everyone (ADR-0007). */}
      <div className="yard-chips" role="group" aria-label="Needs attention">
        {WAREHOUSE_CARDS.map((c) => (
          <Link
            key={c.id}
            to={cardLink(c.id)}
            className={`yard-chip${c.tone && ready && counts[c.id] > 0 ? ` yard-chip--${c.tone}` : ""}${card === c.id ? " yard-chip--on" : ""}`}
          >
            <b>{ready ? counts[c.id] : "–"}</b> {c.label}
          </Link>
        ))}
        {split.length > 0 ? (
          <span className="yard-chip yard-chip--warn" title={split.slice(0, 5).map((s) => `W${s.markCode}`).join(", ")}>
            <b>{split.length}</b> split across places
          </span>
        ) : null}
        {openDamage.length > 0 ? (
          <Link to="/issues" className="yard-chip yard-chip--danger">
            <b>{openDamage.length}</b> damage report{openDamage.length === 1 ? "" : "s"}
          </Link>
        ) : null}
      </div>
      {untagged.length > 0 ? (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          <strong>{untagged.length}</strong> window{untagged.length === 1 ? "" : "s"} on the plans
          with nothing tagged — <Link to={cardLink("not-tagged")}>see which</Link>.
        </p>
      ) : null}
      {card && <CardList card={card} packages={real} containers={boxes} jobCode={jobCode} />}

      {/* Every other door, one row. Same role conditions as before: all crew. */}
      <div className="row-gap yard-actions" role="group" aria-label="Warehouse actions">
        <Link className="button-like" to="/storage/tag">
          Tag packages
        </Link>
        <Link className="button-like" to="/storage/arrive">
          Arrival check
        </Link>
        <Link className="button-like" to="/storage/out">
          Set aside / check out
        </Link>
        <Link className="button-like" to="/warehouse/materials">
          Job materials
        </Link>
        <Link className="button-like" to="/takeoffs">
          Takeoffs{openTakeoffs > 0 ? ` · ${openTakeoffs} open` : ""}
        </Link>
        <Link className="button-like" to="/supplies">
          Take supplies
        </Link>
        <button className="button-like" onClick={() => setMinting(true)}>
          Print blank stickers
        </button>
      </div>

      {/* Per-job unit tallies (owner ask, 2026-08-26): "Mad Moose 20/22 ·
          2 remaining" — units are windows/doors, not boxes. Tapping a job
          opens its materials ledger; waiting jobs included (wave M). */}
      {packages.isSuccess &&
        (() => {
          const tallies = jobTallies(real, jobCode);
          if (tallies.length === 0) return null;
          return (
            <div className="detail-card wh-card">
              <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Jobs with material</h2>
              <ul className="unit-list" style={{ margin: 0 }}>
                {tallies.map((t) => (
                  <li key={t.projectId ?? `pending:${t.label}`} className="wh-row">
                    {t.projectId ? (
                      <Link to={scopeHref({ projectId: t.projectId, pendingName: null })} className="link wh-row-title">
                        {t.label}
                      </Link>
                    ) : (
                      <Link to={scopeHref({ projectId: null, pendingName: t.label })} className="link wh-row-title">
                        “{t.label}”
                      </Link>
                    )}
                    <span className={t.remainingUnits === 0 ? "ok" : "warn-text"} style={{ fontVariantNumeric: "tabular-nums" }}>
                      {tallyLine(t)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

      <Explain id="wh-more" summary="More — today, out on jobs, supplies on the shelf" raw>
        {packages.isSuccess && movementsToday.isSuccess && deliveries.isSuccess && (
          <DayRecapCard recap={recap} />
        )}
        {goingOut.length > 0 && (
          <div className="home-projects" style={{ marginTop: 8 }}>
            {groupByJob(goingOut).slice(0, 40).map((g) => (
              <div key={g.projectId ?? "none"} className="project-card home-project">
                <div className="home-project-head">
                  <div className="wh-row-main">
                    <div className="wh-row-title">{jobCode.get(g.projectId ?? "") ?? "No job"}</div>
                    <div className="wh-row-sub">
                      {g.packages.length} package{g.packages.length === 1 ? "" : "s"} out
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <input
            type="search"
            placeholder="Search supplies — caulk, screws…"
            value={supplyQ}
            onChange={(e) => setSupplyQ(e.target.value)}
            style={{ width: "100%", margin: "6px 0" }}
            aria-label="Search supplies"
          />
          <ul className="unit-list" style={{ margin: 0 }}>
            {supplyPreview.map((s2) => (
              <li key={s2.id} className="find-row">
                <div style={{ minWidth: 0 }}>
                  <strong>{s2.name}</strong> <span className="wh-row-sub">{onHandLabel(s2)}</span>
                </div>
              </li>
            ))}
          </ul>
          {supplyMatches.length === 0 && (
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {supplyQ.trim()
                ? `Nothing named like “${supplyQ.trim()}”.`
                : "Nothing in the catalog yet — add supplies from Take supplies."}
            </p>
          )}
          {supplyMatches.length > SUPPLY_ROWS_SHOWN && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              Showing {SUPPLY_ROWS_SHOWN} of {supplyMatches.length} — type to narrow.
            </p>
          )}
        </div>
      </Explain>

      {/* Supervisor+ only — an installer or foreman's `projects` list never
          has a testing project in it (RLS), so this section would always be
          empty for them; showing it anyway would just be confusing clutter. */}
      {supervisor && (
        <section id="testing">
          <h2>Testing</h2>
          <Explain id="wh-testing">
            Fake data for practice or QA. Flag a job as testing from its Job
            details panel — its material shows up here instead of in the
            counts above, and never counts as real inventory.
          </Explain>
          {testingByJob.length > 0 ? (
            <div className="home-projects">
              {testingByJob.map((g) => (
                <div key={g.projectId ?? "none"} className="project-card home-project">
                  <div className="home-project-head">
                    <div className="wh-row-main">
                      <div className="wh-row-title">{jobCode.get(g.projectId ?? "") ?? "Testing"}</div>
                      <div className="wh-row-sub">
                        {`${g.packages.length} package${g.packages.length === 1 ? "" : "s"} — practice material, never counted as inventory`}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No testing packages right now.</p>
          )}
        </section>
      )}

      {/* Absorbed from the Storage hub (ticket 18). */}
      {newContainer && (
        <ContainerForm
          onClose={() => setNewContainer(false)}
          onSaved={(c) => {
            setNewContainer(false);
            void qc.invalidateQueries({ queryKey: ["storageContainers"] });
            navigate(`/storage/c/${c.id}`);
          }}
        />
      )}
      {minting && (
        <MintForm
          onClose={() => setMinting(false)}
          onMinted={() => {
            setMinting(false);
            void qc.invalidateQueries({ queryKey: ["storagePackages"] });
            void qc.invalidateQueries({ queryKey: ["storageBlanks"] });
          }}
        />
      )}
    </div>
  );
}
