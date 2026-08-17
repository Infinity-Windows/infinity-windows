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

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listInventory, listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { Explain } from "../components/ui/Explain";
import { PackageMap } from "../components/warehouse/PackageMap";
import { FindBar } from "../components/warehouse/FindBar";
import { listIssues } from "../lib/issues";
import {
  agingDays,
  groupByJob,
  listActivePackages,
  listContainers,
} from "../lib/storage";
import { listSupplies, onHandLabel } from "../lib/ops";
import {
  cardLink,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  warehouseCounts,
} from "../lib/warehouse/warehouseCards";
import { placeChain } from "../lib/warehouse/containment";
import { prefetchWarehousePack } from "../lib/queryClient";
import { useOutbox } from "../lib/offline/useOutbox";

/** Sections run in the order the physical day runs. */
interface Section {
  id: string;
  title: string;
  /** Installers see only these three: find it, take it, grab supplies. */
  everyone?: boolean;
}

const SECTIONS: Section[] = [
  { id: "coming-in", title: "Coming in" },
  { id: "in-storage", title: "In storage" },
  { id: "going-out", title: "Going out", everyone: true },
  { id: "supplies", title: "Supplies", everyone: true },
  { id: "problems", title: "Problems" },
];

export function Warehouse() {
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const { counts: outbox } = useOutbox();

  // Fill the cache WHILE there is still signal, so the answers are already on
  // the phone before somebody walks into a conex (ticket 10). Writing offline
  // was the easy half; being able to find things in there is the half that
  // decides whether the trip is useful.
  useEffect(() => {
    void prefetchWarehousePack();
  }, []);

  const waiting = outbox.warehouse;

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const issues = useQuery({ queryKey: ["issues"], queryFn: listIssues });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  // Two systems still describe this warehouse (ADR-0004, ticket 08b). Until
  // the units retire, ONE search box has to answer for both — otherwise the
  // page cannot find the 11 units and 46 shelves that exist today.
  const inventory = useQuery({ queryKey: ["inventory"], queryFn: listInventory });

  const activeIds = useMemo(() => (projects.data ?? []).map((p) => p.id), [projects.data]);
  const marks = useQuery({
    queryKey: ["scheduledMarks", activeIds],
    queryFn: () => listScheduledMarks(activeIds),
    enabled: activeIds.length > 0,
  });

  const rows = packages.data ?? [];
  const boxes = containers.data ?? [];
  const byId = useMemo(() => new Map(boxes.map((c) => [c.id, c])), [boxes]);
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  const openDamage = (issues.data ?? []).filter(
    (i) => i.kind === "damage" && i.status === "open",
  );
  const counts = warehouseCounts(rows, boxes, marks.data ?? [], openDamage.length);
  const ready = packages.isSuccess && containers.isSuccess;

  // Coming in: tagged today but not put away anywhere yet.
  const needsPutaway = rows.filter(
    (p) => p.status === "received" && placeChain(p, byId).loose,
  );
  const untagged = untaggedMarks(rows, marks.data ?? []);
  const goingOut = rows.filter((p) => p.status === "checked_out");

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
        units={inventory.data?.units ?? []}
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
          <Explain id="warehouse-cards" summary="What do these numbers mean?">
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
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
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                <Link className="button-like active-pill" to="/storage/tag">
                  Tag packages (truck)
                </Link>
                <Link className="button-like" to="/receive">
                  Receive units
                </Link>
                <Link className="button-like" to="/storage">
                  Check in
                </Link>
              </div>
              {needsPutaway.length > 0 && (
                <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                  <strong>{needsPutaway.length}</strong> tagged package
                  {needsPutaway.length === 1 ? "" : "s"} with nowhere to be —{" "}
                  <Link to={cardLink("loose")}>put them away</Link>.
                </p>
              )}
              {untagged.length > 0 && (
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
              <div className="warehouse-grid">
                {boxes
                  .filter((c) => !c.parent_container_id)
                  .map((c) => {
                    const inside = rows.filter(
                      (p) => p.status === "stored" && p.container_id === c.id,
                    );
                    const nested = boxes.filter((n) => n.parent_container_id === c.id);
                    const oldest = inside.reduce(
                      (worst, p) => Math.max(worst, agingDays(p.bound_at, new Date()) ?? 0),
                      0,
                    );
                    return (
                      <Link key={c.id} to={`/storage/c/${c.id}`} className="warehouse-tile">
                        <strong>{c.name}</strong>
                        <span className="muted">
                          {inside.length} package{inside.length === 1 ? "" : "s"}
                          {nested.length > 0 && ` · holding ${nested.length} crate${nested.length === 1 ? "" : "s"}`}
                          {oldest > 0 ? ` · oldest ${oldest}d` : ""}
                        </span>
                      </Link>
                    );
                  })}
                {boxes.length === 0 && (
                  <p className="muted">No containers yet — add one from Storage.</p>
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
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                <Link className="button-like active-pill" to="/storage/out">
                  Set aside / check out
                </Link>
                <Link className="button-like" to="/storage/arrive">
                  Arrival check
                </Link>
              </div>
              {goingOut.length > 0 && (
                <div className="home-projects" style={{ marginTop: 8 }}>
                  {groupByJob(goingOut.slice(0, 40)).map((g) => (
                    <div key={g.projectId ?? "none"} className="project-card home-project">
                      <div className="home-project-head">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>
                            {jobCode.get(g.projectId ?? "") ?? "No job"}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
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
              <ul className="unit-list" style={{ margin: 0 }}>
                {(supplies.data ?? []).slice(0, 6).map((s2) => (
                  <li key={s2.id} className="find-row">
                    <div style={{ minWidth: 0 }}>
                      <strong>{s2.name}</strong>{" "}
                      <span className="muted" style={{ fontSize: 12 }}>
                        {onHandLabel(s2)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <Link className="button-like" style={{ marginTop: 8 }} to="/supplies">
                Take supplies
              </Link>
            </>
          )}

          {s.id === "problems" && (
            <>
              <Explain id="wh-problems">
                Things that need somebody to act: damage waiting on a
                replacement, and packages that are tagged but have no place, so
                the app cannot tell anyone where they are.
              </Explain>
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                <Link className="button-like" to="/issues">
                  Damage reports ({openDamage.length})
                </Link>
                <Link className="button-like" to={cardLink("loose")}>
                  Loose packages ({counts.loose})
                </Link>
                <Link className="button-like" to="/count">
                  Cycle count
                </Link>
              </div>
            </>
          )}
        </section>
      ))}

      {lead && <Operations />}
    </div>
  );
}

/**
 * The screens that still belong to the unit system, kept reachable while
 * ticket 08b makes their flows package-first. Folded away rather than given
 * menu rows — they are occasional admin, not the daily loop.
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
            <span className="muted">QR a window or a slot</span>
          </Link>
          <Link to="/count" className="warehouse-tile">
            <strong>Cycle count</strong>
            <span className="muted">Count a slot, flag gaps</span>
          </Link>
          <Link to="/labels" className="warehouse-tile">
            <strong>Slot labels</strong>
            <span className="muted">Print rack/slot QR labels</span>
          </Link>
          <Link to="/storage" className="warehouse-tile">
            <strong>Storage hub</strong>
            <span className="muted">Containers, stickers, posters</span>
          </Link>
        </div>
      )}
    </section>
  );
}
