// One container: the door poster's landing page. Manifest grouped by job
// with aging, the address + gate code at arm's reach, and CHECK IN — the
// no-camera multi-select the owner asked for: pick this container once,
// then tick packages as they're carried in.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects } from "../../lib/api";
import { Explain } from "../../components/ui/Explain";
import { containerTrailLine } from "../../lib/warehouse/containerTrail";
import { formatApiError } from "../../lib/errors";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { containerPostersPdf, downloadPdf } from "../../lib/labels";
import { ContainerForm } from "./StorageHub";
import {
  agingDays,
  CATEGORY_LABELS,
  groupByJob,
  listActivePackages,
  listContainers,
  listContainerMovements,
  saveContainer,
  type StoragePackage,
  containerKind,
} from "../../lib/storage";
import { canNest, ridesAlong } from "../../lib/warehouse/containment";
import {
  moveContainerOffline,
  storePackagesOffline,
  writeToast,
} from "../../lib/warehouse/offlineWrites";

/**
 * Why archiving is blocked, in words a foreman can act on — or null when the
 * container is genuinely empty and the button should work (ticket D5).
 *
 * Two rules, one message. Packages come first because they are the thing that
 * actually goes missing: the container list only reads active rows, so
 * archiving a full conex hides every package inside it from the grid, the
 * search and the posters at once. A container inside this one blocks too — an
 * empty crate is still something in the way, and archiving around it would
 * leave the crate naming a parent nobody can open.
 *
 * The container is named rather than called "this conex" on purpose: the same
 * page runs for conexes, crates and the warehouse itself.
 *
 * `packageCount` is null when the package list has not come back yet — still
 * loading, or the read failed. That is NOT the same as zero, and treating it
 * as zero is how a full conex gets archived: the page shows an empty manifest
 * either way, and archiving is the one action here the app cannot undo. An
 * unknown count blocks.
 */
export function archiveBlockMessage(
  containerName: string,
  packageCount: number | null,
  childNames: string[] = [],
): string | null {
  if (packageCount === null) {
    return `Still loading what is in ${containerName}. Wait for the list before you archive it.`;
  }
  if (packageCount > 0) {
    return packageCount === 1
      ? `1 package is still in ${containerName}. Move it out before you archive it.`
      : `${packageCount} packages are still in ${containerName}. Move them out before you archive it.`;
  }
  if (childNames.length > 0) {
    const list =
      childNames.length === 1
        ? childNames[0]
        : `${childNames.slice(0, -1).join(", ")} and ${childNames[childNames.length - 1]}`;
    return `${containerName} still holds ${list}. Move ${
      childNames.length === 1 ? "it" : "them"
    } out before you archive it.`;
  }
  return null;
}

/**
 * What the move button says afterwards.
 *
 * Named where it went rather than just "Moved", because a conex and three
 * crates all answer to that button and the person who tapped it is usually
 * looking at the packages, not the header. And it goes through `writeToast`
 * so a move made inside a conex with no bars says the one thing that is
 * different about it: the container is where they put it, and the record of
 * that is still on the phone.
 */
export function movedMessage(
  destName: string | null,
  riders: number,
  queued: boolean,
): string {
  const riding = `${riders} package${riders === 1 ? "" : "s"} rode along`;
  const where = destName ? `Moved into ${destName}` : "Out on its own";
  return writeToast({ count: riders, queued }, `${where}, ${riding}`);
}

export function ContainerDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Where this box has been (ticket 13). Its own key per container, so opening
  // Conex 7 never shows Conex 3's travels out of a shared cache entry.
  const trail = useQuery({
    queryKey: ["containerMovements", id],
    queryFn: () => listContainerMovements(id),
  });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const [checkin, setCheckin] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const container = (containers.data ?? []).find((c) => c.id === id) ?? null;
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  const stored = (packages.data ?? []).filter(
    (p) => p.status === "stored" && p.container_id === id,
  );
  /** Check-in candidates: tagged but nowhere yet, or stored in ANOTHER
   * container (ticking one of those is a transfer — it re-stores here). */
  const candidates = (packages.data ?? []).filter(
    (p) =>
      (p.status === "received" && !p.container_id) ||
      (p.status === "stored" && p.container_id !== id) ||
      (p.status === "checked_out"),
  );

  const store = useMutation({
    // The ROWS, not the ids. Each one carries what this screen believed about
    // the package when it was ticked, and that note rides with the write so a
    // check-in that waits out a dead conex cannot land on top of something
    // newer (warehouse audit F2). Picked ids with no row left are dropped
    // rather than sent noteless — the list they came from is the same query.
    mutationFn: () =>
      storePackagesOffline(
        candidates.filter((p) => picked.has(p.id)),
        id,
      ),
    onSuccess: (r) => {
      pushToast(
        writeToast(r, `${r.count} package${r.count === 1 ? "" : "s"} checked in`),
      );
      setPicked(new Set());
      setCheckin(false);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const poster = useMutation({
    mutationFn: async () => {
      if (!container) return;
      downloadPdf(await containerPostersPdf([container]), `${container.serial}-poster.pdf`);
    },
  });

  // Everything that would ride along if this container moved — the honest
  // count on the move buttons: one action, N packages.
  const riders = ridesAlong(id, packages.data ?? [], containers.data ?? []);
  const parent = (containers.data ?? []).find(
    (c) => c.id === container?.parent_container_id,
  );
  const children = (containers.data ?? []).filter((c) => c.parent_container_id === id);
  const nestTargets = (containers.data ?? []).filter(
    (c) => c.active && canNest(id, c.id, containers.data ?? []),
  );

  const move = useMutation({
    mutationFn: (parentContainerId: string | null) =>
      moveContainerOffline({ containerId: id, parentContainerId }),
    onSuccess: (r, dest) => {
      const destName =
        (containers.data ?? []).find((c) => c.id === dest)?.name ?? null;
      pushToast(movedMessage(destName, riders.length, r.queued));
      setMoving(false);
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // What stands between this container and the archive, if anything. Uses the
  // same `riders` count the Move button shows, so "what's inside" means one
  // thing on this page rather than two — and passes null, not 0, until that
  // list has actually arrived, so a slow or failed read cannot read as empty.
  const archiveBlock = container
    ? archiveBlockMessage(
        container.name,
        packages.data ? riders.length : null,
        children.map((c) => c.name),
      )
    : null;

  const archive = useMutation({
    mutationFn: async () => {
      if (!container) return;
      // The rule lives here, not only on the button: a hidden button is a
      // habit, a refused write is a rule.
      if (archiveBlock) throw new Error(archiveBlock);
      // save_storage_container overwrites the whole row, so the untouched
      // fields go back exactly as they came — sending only `active` would
      // wipe the address and the gate code.
      await saveContainer({
        id: container.id,
        name: container.name,
        address: container.address,
        accessCode: container.access_code,
        notes: container.notes,
        active: false,
      });
    },
    onSuccess: () => {
      pushToast(`${container?.name ?? "Container"} archived.`);
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      // The list only reads active containers, so this page has nothing left
      // to show — staying here would flash "Container not found."
      navigate("/storage");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  if (!container) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">
          {containers.isLoading ? "Loading…" : "Container not found."}
        </p>
      </div>
    );
  }

  const row = (p: StoragePackage, extra?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600 }}>
        {p.serial}
        {p.short_code ? ` · ${p.short_code}` : ""}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {jobCode.get(p.project_id ?? "") ?? "no job"}
        {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""}
        {(p.package_marks ?? []).length > 0 &&
          ` · marks ${(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}`}
        {extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{container.serial}</p>
          <h1>{container.name}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {container.address ?? "no address on file"}
            {container.access_code ? ` · code ${container.access_code}` : ""}
            {parent ? ` · inside ${parent.name}` : ""}
          </p>
          {children.length > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Holding: {children.map((c) => c.name).join(", ")}
            </p>
          )}
          {container.notes && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>{container.notes}</p>
          )}
        </div>
      </header>

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button
          className={checkin ? "button-like" : "button-like active-pill"}
          onClick={() => setCheckin((v) => !v)}
        >
          {checkin ? "Done checking in" : "Check in packages"}
        </button>
        <button className="button-like" onClick={() => poster.mutate()}>
          Print poster
        </button>
        {/* The building never moves — no button, matching the server's refusal. */}
        {containerKind(container) !== "building" && (
          <button className="button-like" onClick={() => setMoving((v) => !v)}>
            {moving ? "Cancel move" : "Move"}
          </button>
        )}
        {lead && (
          <button className="button-like" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {lead && (
          <button className="button-like" onClick={() => setArchiving((v) => !v)}>
            {archiving ? "Cancel archive" : "Archive container"}
          </button>
        )}
      </div>

      {archiving && (
        <>
          <h2>Archive {container.name}</h2>
          {archiveBlock ? (
            <p className="error" style={{ margin: "0 0 8px" }}>
              {archiveBlock}
            </p>
          ) : (
            <>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
                It comes off the container grid and out of the poster and
                sticker lists. Nothing that happened here is deleted — every
                package keeps its history. Bringing it back is not something
                this screen can do, so archive it when it is done for good.
              </p>
              <button
                className="button-like active-pill"
                disabled={archive.isPending}
                onClick={() => archive.mutate()}
              >
                {archive.isPending ? "Archiving…" : `Archive ${container.name}`}
              </button>
            </>
          )}
        </>
      )}

      {moving && (
        <>
          <h2>Move {container.name}</h2>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Everything inside moves with it — {riders.length} package
            {riders.length === 1 ? "" : "s"}
            {children.length > 0
              ? ` (including what's in ${children.map((c) => c.name).join(", ")})`
              : ""}{" "}
            in one action. One level only, and the box's kind sets the rules: a
            crate rides in a conex or on a truck, a conex only rides on a truck,
            and nothing goes inside a crate.
          </p>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {nestTargets.map((c) => (
              <button
                key={c.id}
                className="button-like"
                disabled={move.isPending}
                onClick={() => move.mutate(c.id)}
              >
                Into {c.name}
              </button>
            ))}
            {parent && (
              <button
                className="button-like"
                disabled={move.isPending}
                onClick={() => move.mutate(null)}
              >
                Out of {parent.name} — on its own
              </button>
            )}
            {nestTargets.length === 0 && !parent && (
              <p className="muted" style={{ fontSize: 12 }}>
                Nowhere to move it — every other container is nested or holds
                containers of its own.
              </p>
            )}
          </div>
        </>
      )}

      {checkin && (
        <>
          <h2>Tick packages as they go in</h2>
          {candidates.length === 0 && (
            <p className="muted">Nothing waiting — tag packages at the truck first.</p>
          )}
          <div className="home-projects">
            {candidates.map((p) => {
              const on = picked.has(p.id);
              const from =
                p.status === "stored"
                  ? `moving from ${
                      (containers.data ?? []).find((c) => c.id === p.container_id)?.name ?? "?"
                    }`
                  : p.status === "checked_out"
                    ? "coming back in"
                    : undefined;
              return (
                <button
                  key={p.id}
                  className="project-card home-project"
                  style={{ textAlign: "left" }}
                  onClick={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                >
                  <div className="home-project-head">
                    {row(p, from)}
                    <span style={{ fontSize: 20 }}>{on ? "☑" : "☐"}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <button
            className="button-like active-pill"
            disabled={picked.size === 0 || store.isPending}
            onClick={() => store.mutate()}
          >
            {store.isPending ? "Storing…" : `Store ${picked.size} here`}
          </button>
        </>
      )}

      <h2>Inside now ({stored.length})</h2>
      {groupByJob(stored).map((g) => (
        <div key={g.projectId ?? "none"} style={{ marginBottom: 10 }}>
          <p className="tcx-label" style={{ margin: "6px 0 4px" }}>
            {jobCode.get(g.projectId ?? "") ?? "No job"} · {g.packages.length}
          </p>
          <div className="home-projects">
            {g.packages.map((p) => {
              const days = agingDays(p.bound_at, new Date());
              return (
                <Link key={p.id} to={`/pkg/${p.serial}`} className="project-card home-project">
                  <div className="home-project-head">
                    {row(p, days != null ? `${days}d in storage` : undefined)}
                    <span className="muted">›</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      {stored.length === 0 && <p className="muted">Empty.</p>}

      {trail.isSuccess && trail.data.length > 0 && (
        <>
          <h2 style={{ marginTop: 18 }}>Where it&rsquo;s been</h2>
          <Explain id="wh-container-trail">
            Every move and every address change, newest first. Nothing here is
            typed — each line was written the moment somebody moved the box or
            changed where it sits.
          </Explain>
          <div className="detail-card" style={{ padding: "6px 14px" }}>
            {trail.data.slice(0, 10).map((m) => {
              const line = containerTrailLine(
                m,
                new Map((containers.data ?? []).map((c) => [c.id, c])),
                new Map((locations.data ?? []).map((l) => [l.id, l])),
              );
              return (
                <p key={line.id} style={{ margin: "8px 0", fontSize: 13.5 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {new Date(line.when).toLocaleDateString()} ·{" "}
                  </span>
                  {line.text}
                </p>
              );
            })}
          </div>
        </>
      )}

      {editing && (
        <ContainerForm
          initial={container}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: ["storageContainers"] });
          }}
        />
      )}
    </div>
  );
}
