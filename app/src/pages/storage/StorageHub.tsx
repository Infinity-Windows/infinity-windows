// Storage hub: every conex + the warehouse at a glance — what's inside,
// whose job it is, how long it's been sitting — plus the doors into the
// three flows (tag at the truck, check in, check out).

import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import {
  containerPostersPdf,
  downloadPdf,
  packageLabelsPdf,
} from "../../lib/labels";
import {
  agingDays,
  groupByJob,
  listActivePackages,
  listContainers,
  mintPackages,
  saveContainer,
  type StoragePackage,
  type StorageContainer,
  containerKind,
  jobLabel,
} from "../../lib/storage";
import {
  cardPackages,
  listMarkSpecTypes,
  listOpeningRefs,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  type CardId,
} from "../../lib/warehouse/warehouseCards";
import { normalizeMarkCode } from "../../lib/fitview/adapter";

export function StorageHub() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [search, setSearch] = useState("");
  const [newContainer, setNewContainer] = useState(false);
  const [minting, setMinting] = useState(false);
  // Arriving from a hub card: show just that card's rows above everything
  // else, so a number is always openable (ticket 06).
  const [params] = useSearchParams();
  const cardParam = params.get("card");
  const card = WAREHOUSE_CARDS.some((c) => c.id === cardParam)
    ? (cardParam as CardId)
    : null;

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  const byContainer = useMemo(() => {
    const m = new Map<string, typeof packages.data & object>();
    for (const p of packages.data ?? []) {
      if (p.status !== "stored" || !p.container_id) continue;
      const list = m.get(p.container_id) ?? [];
      list.push(p);
      m.set(p.container_id, list);
    }
    return m;
  }, [packages.data]);

  const query = search.trim().toUpperCase();
  const hits = useMemo(() => {
    if (!query) return [];
    return (packages.data ?? [])
      .filter(
        (p) =>
          p.serial.includes(query) ||
          (p.short_code ?? "").includes(query) ||
          (jobCode.get(p.project_id ?? "") ?? "").toUpperCase().includes(query) ||
          (p.package_marks ?? []).some((m) => m.mark_code === query) ||
          // The manufacturer's own number, when it differs from the plan mark
          // — the label in hand is sometimes the only number someone has.
          (p.mfr_mark ?? "").includes(query),
      )
      .slice(0, 12);
  }, [packages.data, query, jobCode]);

  // The mint form replaced a browser prompt() here (warehouse ticket 09):
  // sticker serials are permanent, and a phone-hostile popup guarding a
  // permanent number was the one piece of this page that looked broken.

  const posters = useMutation({
    mutationFn: async (rows: StorageContainer[]) => {
      const pdf = await containerPostersPdf(rows);
      downloadPdf(pdf, "container-posters.pdf");
    },
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Warehouse</p>
          <h1>Storage</h1>
        </div>
      </header>

      {/* One rule for the whole page (D6): the route is foreman+, so every
          button on it is too. Tag and Check out still belong to installers —
          they reach both from the warehouse page: Tag from "Coming in", Check
          out from "Going out". Both of those sections are open to everyone,
          which is what keeps this page's lock from taking tagging away from
          the person standing at the truck. */}
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {lead && (
          <>
            <Link className="button-like active-pill" to="/storage/tag">
              Tag packages (truck)
            </Link>
            <Link className="button-like" to="/storage/out">
              Check out
            </Link>
            <button className="button-like" onClick={() => setMinting(true)}>
              Print blank stickers
            </button>
            <button className="button-like" onClick={() => setNewContainer(true)}>
              New container
            </button>
            <button
              className="button-like"
              disabled={posters.isPending || (containers.data ?? []).length === 0}
              onClick={() => posters.mutate(containers.data ?? [])}
            >
              All posters
            </button>
          </>
        )}
      </div>

      {card && (
        <CardList
          card={card}
          packages={packages.data ?? []}
          containers={containers.data ?? []}
          jobCode={jobCode}
        />
      )}

      <h2>Find a package</h2>
      <input
        placeholder="PKG-000123, short code, job, or mark (16)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {query && (
        <div className="home-projects">
          {hits.map((p) => (
            <Link key={p.id} to={`/pkg/${p.serial}`} className="project-card home-project">
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {p.serial}
                    {p.short_code ? ` · ${p.short_code}` : ""}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {jobLabel(p, jobCode)} · {p.status}
                  </div>
                </div>
                <span className="muted">›</span>
              </div>
            </Link>
          ))}
          {hits.length === 0 && <p className="muted">Nothing matches.</p>}
        </div>
      )}

      <h2>Containers</h2>
      {containers.isError && <p className="error">{formatApiError(containers.error)}</p>}
      <div className="warehouse-grid">
        {(containers.data ?? []).map((c) => {
          const stored = byContainer.get(c.id) ?? [];
          const jobs = groupByJob(stored);
          const oldest = stored.reduce<number>((worst, p) => {
            const d = agingDays(p.bound_at, new Date()) ?? 0;
            return Math.max(worst, d);
          }, 0);
          return (
            <Link key={c.id} to={`/storage/c/${c.id}`} className="warehouse-tile">
              <strong>
                {c.name}
                {containerKind(c) !== "conex" && (
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {" "}· {containerKind(c)}
                  </span>
                )}
              </strong>
              <span className="muted">
                {stored.length} package{stored.length === 1 ? "" : "s"}
                {stored.length > 0 &&
                  ` · ${jobs
                    .map(
                      (g) =>
                        `${jobCode.get(g.projectId ?? "") ?? "?"} ×${g.packages.length}`,
                    )
                    .slice(0, 3)
                    .join(", ")}`}
                {oldest > 0 ? ` · oldest ${oldest}d` : ""}
              </span>
            </Link>
          );
        })}
        {(containers.data ?? []).length === 0 && (
          <p className="muted">
            No containers yet{lead ? " — add the warehouse and each conex." : "."}
          </p>
        )}
      </div>

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

/**
 * One hub card's rows (warehouse ticket 06). Every number on the Warehouse
 * page opens here, so a count always has something behind it.
 *
 * "Not tagged" is the odd one and deliberately so: it counts scheduled marks
 * with NO package, so there are no package rows to show — it lists the marks
 * themselves, which is the actual to-do list ("go find window 17, or admit it
 * hasn't arrived").
 */
function CardList({
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
  const activeIds = useMemo(
    () => (projects.data ?? []).map((p) => p.id),
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
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {p.serial}
                    {p.short_code ? ` · ${p.short_code}` : ""}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {jobLabel(p, jobCode)}
                    {(p.package_marks ?? []).length > 0 &&
                      ` · marks ${(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}`}
                  </div>
                </div>
                <span className="muted">›</span>
              </div>
            </Link>
          ))}
          {rows.length === 0 && <p className="muted">Nothing here — good.</p>}
        </div>
      )}
      <Link className="button-like" to="/storage">
        Clear filter
      </Link>
    </>
  );
}

/**
 * Sticker batches get a real form (warehouse ticket 09). Serials are
 * permanent — a fat-fingered 500 pollutes the numbering forever — so the
 * count deserves an actual input with the rule stated, not a browser prompt
 * that phones render badly and demos make look broken.
 */
function MintForm({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (n: number) => void;
}) {
  const [count, setCount] = useState("50");
  const n = parseInt(count, 10);
  const invalid = !Number.isFinite(n) || n < 1 || n > 500;

  const mint = useMutation({
    mutationFn: async () => {
      const rows = await mintPackages(n);
      const pdf = await packageLabelsPdf(rows);
      downloadPdf(
        pdf,
        `package-stickers-${rows[0]?.serial}-${rows[rows.length - 1]?.serial}.pdf`,
      );
      return rows.length;
    },
    onSuccess: (made) => {
      pushToast(`${made} blank stickers ready to print.`);
      onMinted(made);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>Print blank stickers</p>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          Each sticker gets a permanent serial the moment it prints — batches
          are 1&ndash;500 at a time.
        </p>
        <label className="field-label">How many</label>
        <input
          type="number"
          min={1}
          max={500}
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          autoFocus
        />
        {invalid && count.trim() !== "" && (
          <p className="error" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Pick a number from 1 to 500.
          </p>
        )}
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={invalid || mint.isPending}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? "Printing…" : `Print ${invalid ? "" : n} stickers`}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContainerForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: StorageContainer | null;
  onClose: () => void;
  onSaved: (c: StorageContainer) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [accessCode, setAccessCode] = useState(initial?.access_code ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  // Kind is picked once, at creation. Editing keeps whatever the box is —
  // a crate that "becomes" a conex is really a new box (ticket 12).
  const [kind, setKind] = useState(containerKind(initial));
  const [dims, setDims] = useState({
    length: initial?.length_cm != null ? String(initial.length_cm) : "",
    width: initial?.width_cm != null ? String(initial.width_cm) : "",
    height: initial?.height_cm != null ? String(initial.height_cm) : "",
    weight: initial?.weight_kg != null ? String(initial.weight_kg) : "",
  });
  // "120" -> 120, "" -> null, junk -> null. A dimension is a measurement:
  // null is "not measured yet", and the server refuses zero and below.
  const dim = (raw: string): number | null => {
    const n = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const save = useMutation({
    mutationFn: () =>
      saveContainer({
        id: initial?.id ?? null,
        name,
        address: address || null,
        accessCode: accessCode || null,
        notes: notes || null,
        kind,
        lengthCm: dim(dims.length),
        widthCm: dim(dims.width),
        heightCm: dim(dims.height),
        weightKg: dim(dims.weight),
      }),
    onSuccess: (c) => {
      pushToast(initial ? "Container updated." : `${c.name} added.`);
      onSaved(c);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {initial ? `Edit ${initial.name}` : "New container"}
        </p>
        <label className="field-label">Name</label>
        <input
          placeholder="Conex 7 / Glass crate 12"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="field-label">What kind of box</label>
        {/* Locked after creation — the kind rules every move it has ever made. */}
        <select value={kind} disabled={!!initial} onChange={(e) => setKind(e.target.value)}>
          <option value="conex">Conex</option>
          <option value="crate">Crate</option>
          <option value="truck">Truck</option>
        </select>
        {kind === "crate" && (
          <>
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
              Size and weight, so anyone can tell whether it fits in a conex and
              what the forklift is picking up. Centimeters and kilograms; leave
              blank until it's measured.
            </p>
            <div className="row-gap">
              <div style={{ flex: 1 }}>
                <label className="field-label">Length (cm)</label>
                <input inputMode="decimal" value={dims.length}
                  onChange={(e) => setDims({ ...dims, length: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Width (cm)</label>
                <input inputMode="decimal" value={dims.width}
                  onChange={(e) => setDims({ ...dims, width: e.target.value })} />
              </div>
            </div>
            <div className="row-gap">
              <div style={{ flex: 1 }}>
                <label className="field-label">Height (cm)</label>
                <input inputMode="decimal" value={dims.height}
                  onChange={(e) => setDims({ ...dims, height: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Weight (kg)</label>
                <input inputMode="decimal" value={dims.weight}
                  onChange={(e) => setDims({ ...dims, weight: e.target.value })} />
              </div>
            </div>
          </>
        )}
        <label className="field-label">Address</label>
        <input
          placeholder="Where it sits"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <label className="field-label">Gate / lock code</label>
        <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} />
        <label className="field-label">Notes</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
