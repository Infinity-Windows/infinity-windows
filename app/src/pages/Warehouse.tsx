// The one-page warehouse (ticket 08 — grill Q2/Q3/Q5, owner-confirmed).
//
// Eight menu rows collapse to one page. The warehouse answers a single
// question, so that question is PINNED at the top and never scrolls away;
// everything below runs in the order the day runs — coming in, in storage,
// going out, supplies, problems. Actions open over the page instead of
// navigating, because the tab-switching was never the disease: two location
// models were, and with one model a single screen can hold the whole job.
//
// One screen for every role, sections filtered (Q5): an installer sees Find,
// Going out and Supplies — find my crate, take my crate. Foreman+ get the
// rest. Two pages would mean two sets of bugs and every explanation written
// twice.
//
// NOT in this ticket, deliberately: retiring the unit system's staged/loaded
// statuses and per-window shelf spots. Those die with the screens that write
// them (Receive / Scan / Cycle count), which is its own body of work — see
// docs/warehouse-tickets.md ticket 08b. Until then those screens stay
// reachable and working from the Operations section.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listLocations, listProjects, listProjectsAnyStatus } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { Explain } from "../components/ui/Explain";
import { EmptyState } from "../components/ui/States";
import { PackageMap } from "../components/warehouse/PackageMap";
import { FindBar } from "../components/warehouse/FindBar";
import { CardList } from "../components/warehouse/CardList";
import { ContainerBadge } from "../components/warehouse/ContainerBadge";
import { ContainerForm } from "../components/warehouse/ContainerForm";
import { MintForm } from "../components/warehouse/MintForm";
import { containerPostersPdf, downloadPdf } from "../lib/labels";
import { listJobModelRows } from "../lib/modelstudio/projects";
import { listIssues } from "../lib/issues";
import {
  agingDays,
  groupByJob,
  listActivePackages,
  listContainers,
  listDeliveries,
  listMovementsSince,
  containerKind,
  type StorageContainer,
} from "../lib/storage";
import { DayRecapCard } from "../components/warehouse/DayRecapCard";
import { dayRecap, localMidnightIso } from "../lib/warehouse/dayRecap";
import { jobTallies, tallyLine } from "../lib/warehouse/jobTally";
import { scopeHref } from "../lib/warehouse/materialsScope";
import { partitionTestPackages, testProjectIds } from "../lib/warehouse/testPartition";
import {
  filterSuppliesByName,
  listSupplies,
  lowStockFirst,
  onHandLabel,
} from "../lib/ops";
import { listTakeoffs } from "../lib/takeoffs";
import {
  cardLink,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  warehouseCounts,
  type CardId,
} from "../lib/warehouse/warehouseCards";
import { placeChain, toLocationsById } from "../lib/warehouse/containment";
import { splitUnits } from "../lib/warehouse/splitUnits";
import { useOutbox } from "../lib/offline/useOutbox";
import { useScanWedge } from "../lib/warehouse/scanWedge";
import {
  STATION_COMING_IN,
  STATION_FIX_MISTAKE,
  STATION_OFF_TRUCK,
  STATION_OUT_DOOR,
  STATION_PUT_AWAY,
} from "../lib/warehouse/stations";

/** Sections run in the order the physical day runs. */
interface Section {
  id: string;
  title: string;
  /** Installers see only these three: find it, take it, grab supplies. */
  everyone?: boolean;
}

const SECTIONS: Section[] = [
  // Everyone sees "Coming in" because tagging lives in it, and tagging is the
  // installer's first job of the day — whoever is at the truck does it (S3).
  // Locking the whole section to leads (D6) left an installer with no way to
  // reach /storage/tag at all: the other door, the Storage hub, went foreman+
  // in the same change (and later merged into this page entirely — ticket
  // 18). The foreman-only tools INSIDE the section are gated one at a time
  // below, which is the pattern the rest of the page uses.
  { id: "coming-in", title: "Coming in", everyone: true },
  { id: "in-storage", title: "In storage" },
  { id: "going-out", title: "Going out", everyone: true },
  { id: "supplies", title: "Supplies", everyone: true },
  { id: "problems", title: "Problems" },
];

export function Warehouse() {
  // Pick 30: a desk-mounted hardware scanner routes straight to the package
  // or container it reads, same as the camera flow.
  useScanWedge();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  // Testing projects (owner-confirmed 2026-08-25) are invisible below
  // supervisor by RLS, so an installer/foreman's `projects` list never has
  // one in it — this is supervisor+ in its own right, not shorthand for lead.
  const supervisor = isSupervisorPlus(effectiveRole);
  const { counts: outbox } = useOutbox();
  // ?q= prefills Find (Studio 100x #15's door in) — read once; FindBar owns
  // the input from here, the same way it already owns everything typed by
  // hand or scanned.
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? undefined;
  // ?card= arrives from a tapped stat card (ticket 06) — absorbed from the
  // Storage hub along with the containers below (ticket 18).
  const cardParam = searchParams.get("card");
  const card = WAREHOUSE_CARDS.some((c) => c.id === cardParam)
    ? (cardParam as CardId)
    : null;
  const [newContainer, setNewContainer] = useState(false);
  const [minting, setMinting] = useState(false);
  // Job-building glow's door (#16): which jobs have a Studio model at all,
  // so Find only offers "Show on the building" where there is one.
  const studioJobModels = useQuery({ queryKey: ["studioJobModels"], queryFn: listJobModelRows });
  const jobsWithModels = useMemo(
    () => new Set((studioJobModels.data ?? []).map((m) => m.project_id)),
    [studioJobModels.data],
  );

  const waiting = outbox.warehouse;

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Finished jobs keep naming their material (owner ask, 2026-08-26): name
  // maps and Find read every job; anything that TAGS stays active-only.
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  // Racks and staging bays. Find needs these to say "staged for BLACK22"
  // instead of "on a shelf" — without them a staged package is a slot address
  // somebody has to decode. Same query key the other screens use, so it is a
  // cache hit more often than a fetch.
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const issues = useQuery({ queryKey: ["issues"], queryFn: listIssues });
  // Day recap (pick 26): "today" is local midnight, recomputed every render
  // but only actually changing value once a day — so the query key is
  // naturally stable within a day and just as naturally refetches the one
  // time it rolls over while the tab stays open.
  const todayIso = localMidnightIso(new Date());
  const movementsToday = useQuery({
    queryKey: ["movementsSince", todayIso],
    queryFn: () => listMovementsSince(todayIso),
  });
  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const takeoffs = useQuery({ queryKey: ["takeoffs"], queryFn: listTakeoffs });
  const openTakeoffs = (takeoffs.data ?? []).filter(
    (t) => t.status !== "picked_up",
  ).length;
  // The supply drawer (owner ask, 2026-08-18): folded away with a search bar
  // inside, instead of six rows always spread on the page. No search = the
  // lowest-stock supplies first (lowStockFirst ranks "not counted yet" as the
  // average of what we do know); typing narrows the WHOLE catalog by name,
  // not just what's showing.
  const [supplyQ, setSupplyQ] = useState("");
  const supplyMatches = useMemo(
    () => filterSuppliesByName(lowStockFirst(supplies.data ?? []), supplyQ),
    [supplies.data, supplyQ],
  );
  const SUPPLY_ROWS_SHOWN = 12;
  const supplyPreview = supplyMatches.slice(0, SUPPLY_ROWS_SHOWN);

  // Testing projects' marks are excluded here too, not just their packages:
  // without this, a testing job's scheduled marks would never find a match
  // in `real` (its packages all sort into `testing`) and would sit on the
  // foreman-visible "not tagged" card forever, for a job a foreman can't
  // even see to understand why.
  const testIds = testProjectIds(projects.data ?? []);
  const activeIds = useMemo(
    () => (projects.data ?? []).filter((p) => !testIds.has(p.id)).map((p) => p.id),
    [projects.data, testIds],
  );
  const marks = useQuery({
    queryKey: ["scheduledMarks", activeIds],
    queryFn: () => listScheduledMarks(activeIds),
    enabled: activeIds.length > 0,
  });

  const rows = packages.data ?? [];
  const boxes = containers.data ?? [];
  const byId = useMemo(() => new Map(boxes.map((c) => [c.id, c])), [boxes]);
  const locsById = useMemo(
    () => toLocationsById(locations.data ?? []),
    [locations.data],
  );
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);

  const openDamage = (issues.data ?? []).filter(
    (i) => i.kind === "damage" && i.status === "open",
  );
  // Testing projects' packages never count as real inventory (owner call,
  // 2026-08-25) — every card, count and warning below reads `real`, never
  // `rows`. FindBar is the one deliberate exception: it answers "where is
  // it" for a SPECIFIC scanned or typed thing, and a testing package is a
  // real physical object somebody may need to find, so it keeps `rows`.
  const { real, testing } = partitionTestPackages(rows, testIds);
  const counts = warehouseCounts(real, boxes, marks.data ?? [], openDamage.length);
  const ready = packages.isSuccess && containers.isSuccess;
  // `real`, not `rows`, for the same reason every other count on this page
  // does: a testing job's material is practice, never inventory.
  const recap = dayRecap(
    movementsToday.data ?? [],
    real,
    (deliveries.data ?? []).map((d) => ({ id: d.id, label: d.label ?? "a delivery" })),
  );

  // Coming in: tagged today but not put away anywhere yet.
  const needsPutaway = real.filter(
    (p) => p.status === "received" && placeChain(p, byId).loose,
  );
  const untagged = untaggedMarks(real, marks.data ?? []);
  // Windows the warehouse holds in more than one place right now (ticket 19).
  const split = splitUnits(real, byId, locsById);
  const goingOut = real.filter((p) => p.status === "checked_out");
  const testingByJob = groupByJob(testing);

  // Absorbed from the Storage hub (ticket 18): print every container's door
  // poster in one PDF.
  const posters = useMutation({
    mutationFn: async (rows: StorageContainer[]) => {
      const pdf = await containerPostersPdf(rows);
      downloadPdf(pdf, "container-posters.pdf");
    },
  });

  const visible = SECTIONS.filter((s) => lead || s.everyone);

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
      />

      {waiting > 0 && (
        <p className="wh-pending">
          {waiting} warehouse {waiting === 1 ? "change is" : "changes are"} saved on
          this phone and not sent yet — they go up on their own when you have
          signal.
        </p>
      )}

      <Explain id="warehouse-how" summary="How does tracking work?" raw>
        <PackageMap />
      </Explain>

      {/* The warehouse funnel (wave F, grill Q5/Q6): five numbered stations,
          in the order material actually moves — coming in, off the truck,
          put away, out the door, fix a mistake. Replaces the old quick-link
          row above AND the "Coming in" section's own nav links below (both
          retire here), which is also where the "Deliveries — check trucks
          in" link that used to sit in both places at once loses its
          duplicate. Every button keeps the exact role condition it had
          before the redesign — the strip only changes the geometry, never
          who can tap what (see each card). Numbers and names come from
          lib/warehouse/stations.ts, the same module every chipped
          destination page reads, so the hub and the chips can't disagree.
          Mobile-first per the spec: stacks vertically by default (the phone
          in an installer's hand); .station-strip in index.css only lays
          cards out horizontally at desktop widths. */}
      <div className="station-strip">
        <div className="station-card">
          <div className="station-card-head">
            <span className="station-num">{STATION_COMING_IN.number}</span>
            <strong className="station-name">{STATION_COMING_IN.name}</strong>
          </div>
          <p className="muted station-when">{STATION_COMING_IN.when}</p>
          {/* Checking trucks in and logging one both belong to whoever's at
              the tailgate (S3) — open to everyone, same as before. */}
          <div className="row-gap station-actions">
            <Link className="button-like active-pill" to="/storage/deliveries">
              Deliveries — check trucks in
            </Link>
            <Link className="button-like" to="/storage/log-delivery">
              Log a delivery (truck)
            </Link>
          </div>
        </div>
        <span className="station-connector" aria-hidden="true">→</span>

        <div className="station-card">
          <div className="station-card-head">
            <span className="station-num">{STATION_OFF_TRUCK.number}</span>
            <strong className="station-name">{STATION_OFF_TRUCK.name}</strong>
          </div>
          <p className="muted station-when">{STATION_OFF_TRUCK.when}</p>
          {/* Tag packages had no direct door on this hub before — Log a
              delivery's "with QR stickers" choice was the only way in. A
              direct link matches /storage/tag's own registry floor
              (installer, nav.ts) and the S3 rule this page has followed
              since ticket 08: whoever's at the tailgate tags, so it's open
              to everyone, same as Arrival check already was. */}
          <div className="row-gap station-actions">
            <Link className="button-like active-pill" to="/storage/tag">
              Tag packages
            </Link>
            <Link className="button-like" to="/storage/arrive">
              Arrival check
            </Link>
          </div>
        </div>
        <span className="station-connector" aria-hidden="true">→</span>

        <div className="station-card">
          <div className="station-card-head">
            <span className="station-num">{STATION_PUT_AWAY.number}</span>
            <strong className="station-name">{STATION_PUT_AWAY.name}</strong>
          </div>
          <p className="muted station-when">{STATION_PUT_AWAY.when}</p>
          {/* No new destination — "In storage" is already a section on this
              page, below the strip. It's lead-only there (D6, carried over
              in ticket 18), so the button here matches: only a lead has
              anywhere to land. */}
          {lead && (
            <div className="row-gap station-actions">
              <a className="button-like" href="#in-storage">
                See containers
              </a>
            </div>
          )}
        </div>
        <span className="station-connector" aria-hidden="true">→</span>

        <div className="station-card">
          <div className="station-card-head">
            <span className="station-num">{STATION_OUT_DOOR.number}</span>
            <strong className="station-name">{STATION_OUT_DOOR.name}</strong>
          </div>
          <p className="muted station-when">{STATION_OUT_DOOR.when}</p>
          <div className="row-gap station-actions">
            <Link className="button-like active-pill" to="/storage/out">
              Set aside / check out
            </Link>
          </div>
        </div>
        <span className="station-connector" aria-hidden="true">→</span>

        <div className="station-card">
          <div className="station-card-head">
            <span className="station-num">{STATION_FIX_MISTAKE.number}</span>
            <strong className="station-name">{STATION_FIX_MISTAKE.name}</strong>
          </div>
          <p className="muted station-when">{STATION_FIX_MISTAKE.when}</p>
          <div className="row-gap station-actions">
            <Link className="button-like" to="/warehouse/materials">
              Job materials
            </Link>
            {/* Rewrite this set (wave R) is deliberately NOT a button here:
                its view needs a specific set (?job/&pending + &mark), and the
                way to one is already this card — Job materials, pick the set,
                Edit set…. A second hub door to the same place is exactly the
                duplicate the wave-F audit killed. */}
          </div>
        </div>
      </div>

      {lead && (
        <>
          <div className="stat-grid">
            {WAREHOUSE_CARDS.map((c) => (
              <Link
                key={c.id}
                to={cardLink(c.id)}
                className={c.tone ? `stat-card ${c.tone}` : "stat-card"}
              >
                <span className="stat-num">{ready ? counts[c.id] : "-"}</span>
                <span>{c.label}</span>
              </Link>
            ))}
          </div>
          {/* raw because a <ul> may not sit inside Explain's quoted <p> —
              React 19 logs a DOM-nesting error on every load without it.
              The list carries the quoted-note styling itself instead. */}
          <Explain id="warehouse-cards" summary="What do these numbers mean?" raw>
            <ul
              style={{
                margin: "6px 0 0",
                paddingLeft: 18,
                color: "var(--muted)",
                lineHeight: 1.5,
                borderLeft: "2px solid var(--border)",
              }}
            >
              {WAREHOUSE_CARDS.map((c) => (
                <li key={c.id} style={{ marginBottom: 6 }}>
                  <strong>{c.label}</strong> — {c.blurb}
                </li>
              ))}
              <li>
                One thing to know about <strong>not tagged</strong>: a window mark
                that shows up eight times on the plans counts once, because the
                manufacturer&rsquo;s labels don&rsquo;t number the eight apart.
              </li>
            </ul>
          </Explain>
        </>
      )}
      {/* A tapped stat card drills in right here (ticket 06/18) — same rule
          as the cards above: lead-only, since a non-lead never sees a card
          to tap in the first place. */}
      {lead && card && (
        <CardList card={card} packages={real} containers={boxes} jobCode={jobCode} />
      )}

      {/* Pick 26: visible to every role — movements, packages and
          deliveries are all open reads to any signed-in crew member, same
          as the hub counts above are to a lead. Waits on all three reads so
          a still-loading page never flashes "Quiet so far" a moment before
          the real counts land. */}
      {packages.isSuccess && movementsToday.isSuccess && deliveries.isSuccess && (
        <DayRecapCard recap={recap} />
      )}

      {/* Per-job unit tallies (owner ask, 2026-08-26): "Mad Moose 20/22 ·
          2 remaining" — units are windows/doors, not boxes. Tapping a job
          opens its materials ledger. */}
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
                    {/* Wave M: EVERY row links now, waiting jobs included —
                        the owner's whole live inventory is waiting-job
                        material, and it used to render as a dead end here. */}
                    {t.projectId ? (
                      <Link
                        to={scopeHref({ projectId: t.projectId, pendingName: null })}
                        className="link wh-row-title"
                      >
                        {t.label}
                      </Link>
                    ) : (
                      <Link
                        to={scopeHref({ projectId: null, pendingName: t.label })}
                        className="link wh-row-title"
                      >
                        “{t.label}”
                      </Link>
                    )}
                    <span
                      className={t.remainingUnits === 0 ? "ok" : "warn-text"}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {tallyLine(t)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

      {packages.isError && <p className="error">{formatApiError(packages.error)}</p>}

      {visible.map((s) => (
        <section key={s.id} id={s.id}>
          <h2>{s.title}</h2>

          {s.id === "coming-in" && (
            <>
              <Explain id="wh-coming-in">
                Material off the truck. Stick a sticker on each package and say
                which window it belongs to — until you do, nobody can be told
                where it is. Then check it into a conex.
              </Explain>
              {/* Ticket 20: one front door for trucks. Log a delivery's
                  "with QR stickers" choice IS the tag flow — the standalone
                  Tag button retired, and "Check in" (-> the old Storage hub)
                  retired with it, since New container / posters / minting
                  all live right below now, in "In storage". Both nav links
                  that used to live in this row moved into station 1 of the
                  strip above (wave F) — minting stays here, untouched. */}
              {lead && (
                <div className="row-gap">
                  <button className="button-like" onClick={() => setMinting(true)}>
                    Print blank stickers
                  </button>
                </div>
              )}
              {lead && needsPutaway.length > 0 && (
                <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                  <strong>{needsPutaway.length}</strong> tagged package
                  {needsPutaway.length === 1 ? "" : "s"} with nowhere to be —{" "}
                  <Link to={cardLink("loose")}>put them away</Link>.
                </p>
              )}
              {lead && split.length > 0 && (
                <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                  <strong>{split.length}</strong> window
                  {split.length === 1 ? "" : "s"} split across places —{" "}
                  {split
                    .slice(0, 3)
                    .map((s) => `W${s.markCode}`)
                    .join(", ")}
                  {split.length > 3 ? ` and ${split.length - 3} more` : ""}.
                  Ask Find for one to see where its parts sit.
                </p>
              )}
              {lead && untagged.length > 0 && (
                <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                  <strong>{untagged.length}</strong> window
                  {untagged.length === 1 ? "" : "s"} on the plans with nothing
                  tagged — <Link to={cardLink("not-tagged")}>see which</Link>.
                </p>
              )}
            </>
          )}

          {s.id === "in-storage" && (
            <>
              <Explain id="wh-in-storage">
                Every conex and crate, and what is sitting in it. Moving a
                container moves everything inside it in one action — you never
                re-scan the contents.
              </Explain>
              {/* Absorbed from the Storage hub (ticket 18). */}
              {lead && (
                <div className="row-gap" style={{ marginBottom: 8 }}>
                  <button className="button-like" onClick={() => setNewContainer(true)}>
                    New container
                  </button>
                  <button
                    className="button-like"
                    disabled={posters.isPending || boxes.length === 0}
                    onClick={() => posters.mutate(boxes)}
                  >
                    All posters
                  </button>
                </div>
              )}
              <div className="warehouse-grid">
                {boxes
                  .filter((c) => !c.parent_container_id)
                  .map((c) => {
                    // `real`, not `rows`: testing packages never count as
                    // inventory anywhere on this page, and a tile that
                    // counted them while its job breakdown (below) didn't
                    // would just disagree with itself.
                    const inside = real.filter(
                      (p) => p.status === "stored" && p.container_id === c.id,
                    );
                    const nested = boxes.filter((n) => n.parent_container_id === c.id);
                    const jobs = groupByJob(inside);
                    const oldest = inside.reduce(
                      (worst, p) => Math.max(worst, agingDays(p.bound_at, new Date()) ?? 0),
                      0,
                    );
                    return (
                      <Link key={c.id} to={`/storage/c/${c.id}`} className="warehouse-tile">
                        <span className="row-gap" style={{ alignItems: "center" }}>
                          <ContainerBadge name={c.name} serial={c.serial} />
                          <strong>
                            {c.name}
                            {containerKind(c) !== "conex" && (
                              <span className="muted" style={{ fontWeight: 400 }}>
                                {" "}· {containerKind(c)}
                              </span>
                            )}
                          </strong>
                        </span>
                        <span className="muted">
                          <span className="wh-count">{inside.length}</span>{" "}
                          <span className="wh-count-label">
                            package{inside.length === 1 ? "" : "s"}
                          </span>
                          {inside.length > 0 &&
                            ` · ${jobs
                              .map(
                                (g) =>
                                  `${jobCode.get(g.projectId ?? "") ?? "?"} ×${g.packages.length}`,
                              )
                              .slice(0, 3)
                              .join(", ")}`}
                          {nested.length > 0 && ` · holding ${nested.length} crate${nested.length === 1 ? "" : "s"}`}
                          {oldest > 0 ? ` · oldest ${oldest}d` : ""}
                        </span>
                      </Link>
                    );
                  })}
                {boxes.length === 0 && (
                  <EmptyState
                    title={lead ? "No containers yet — add one above." : "No containers yet."}
                  />
                )}
              </div>
            </>
          )}

          {s.id === "going-out" && (
            <>
              <Explain id="wh-going-out">
                Two steps, and the first is optional. <strong>Set aside</strong> puts a
                job&rsquo;s packages on its own shelf so they go out together.{" "}
                <strong>Check out</strong> takes them to the job — pick a reason;
                taking a package tagged for another job is fine, it just warns you
                and asks why so the borrow is on the record. When something arrives
                broken, the <strong>arrival check</strong> raises an issue that names
                the package.
              </Explain>
              <div className="row-gap">
                <Link className="button-like active-pill" to="/storage/out">
                  Set aside / check out
                </Link>
                <Link className="button-like" to="/storage/arrive">
                  Arrival check
                </Link>
              </div>
              {goingOut.length > 0 && (
                <div className="home-projects" style={{ marginTop: 8 }}>
                  {/* Group FIRST, then cap the cards. Slicing the packages
                      before grouping made a job's "N out" count wrong (or hid
                      the job entirely) once more than 40 were out, because the
                      cut is ordered by when packages were TAGGED, not when
                      they left. */}
                  {groupByJob(goingOut).slice(0, 40).map((g) => (
                    <div key={g.projectId ?? "none"} className="project-card home-project">
                      <div className="home-project-head">
                        <div className="wh-row-main">
                          <div className="wh-row-title">
                            {jobCode.get(g.projectId ?? "") ?? "No job"}
                          </div>
                          <div className="wh-row-sub">
                            {g.packages.length} package
                            {g.packages.length === 1 ? "" : "s"} out
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {s.id === "supplies" && (
            <>
              <Explain id="wh-supplies">
                Caulk, screws, flashing. Each one has a home spot so you know
                where to go, and the count is an estimate that only means
                something with its last count date beside it.
              </Explain>
              <div className="row-gap" style={{ marginBottom: 6 }}>
                <Link className="button-like active-pill" to="/takeoffs">
                  Takeoffs{openTakeoffs > 0 ? ` · ${openTakeoffs} open` : ""}
                </Link>
                <Link className="button-like" to="/supplies">
                  Take supplies
                </Link>
              </div>
              <Explain id="wh-supply-drawer" summary="Supplies on the shelf" raw>
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
                        <strong>{s2.name}</strong>{" "}
                        <span className="wh-row-sub">
                          {onHandLabel(s2)}
                        </span>
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
                    Showing {SUPPLY_ROWS_SHOWN} of {supplyMatches.length} — type to
                    narrow.
                  </p>
                )}
              </Explain>
            </>
          )}

          {s.id === "problems" && (
            <>
              <Explain id="wh-problems">
                Things that need somebody to act: damage waiting on a
                replacement, and packages that are tagged but have no place, so
                the app cannot tell anyone where they are.
              </Explain>
              <div className="row-gap">
                <Link className="button-like" to="/issues">
                  Damage reports ({openDamage.length})
                </Link>
                <Link className="button-like" to={cardLink("loose")}>
                  Loose packages ({counts.loose})
                </Link>
              </div>
            </>
          )}
        </section>
      ))}

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
                      <div className="wh-row-title">
                        {jobCode.get(g.projectId ?? "") ?? "Testing"}
                      </div>
                      <div className="wh-row-sub">
                        {`${g.packages.length} package${
                          g.packages.length === 1 ? "" : "s"
                        } — practice material, never counted as inventory`}
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

      {lead && <Operations />}

      {/* Absorbed from the Storage hub (ticket 18). Both open only from
          lead-gated buttons above, but the check is repeated here too. */}
      {lead && newContainer && (
        <ContainerForm
          onClose={() => setNewContainer(false)}
          onSaved={(c) => {
            setNewContainer(false);
            void qc.invalidateQueries({ queryKey: ["storageContainers"] });
            navigate(`/storage/c/${c.id}`);
          }}
        />
      )}
      {lead && minting && (
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

/**
 * Occasional admin, folded away rather than given menu rows. The unit-system
 * screens that used to shelter here (Receive, Cycle count, the inventory
 * list) retired with the chain (ticket 21, ADR-0005).
 */
function Operations() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>
        <button
          className="link"
          onClick={() => setOpen((v) => !v)}
          style={{ font: "inherit", color: "inherit" }}
        >
          Other tools {open ? "▾" : "▸"}
        </button>
      </h2>
      {open && (
        <div className="warehouse-grid">
          <Link to="/scan" className="warehouse-tile">
            <strong>Scan</strong>
            <span className="muted">Any sticker, poster or slot label</span>
          </Link>
          <Link to="/labels" className="warehouse-tile">
            <strong>Slot labels</strong>
            <span className="muted">Print rack/slot QR labels</span>
          </Link>
        </div>
      )}
    </section>
  );
}
