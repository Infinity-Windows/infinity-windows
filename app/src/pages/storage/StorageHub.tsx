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
} from "../../lib/storage";
import {
  cardPackages,
  listScheduledMarks,
  untaggedMarks,
  WAREHOUSE_CARDS,
  type CardId,
} from "../../lib/warehouse/warehouseCards";

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

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <Link className="button-like active-pill" to="/storage/tag">
          Tag packages (truck)
        </Link>
        <Link className="button-like" to="/storage/out">
          Check out
        </Link>
        {lead && (
          <>
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
                    {jobCode.get(p.project_id ?? "") ?? "no job"} · {p.status}
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
              <strong>{c.name}</strong>
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

  return (
    <>
      <h2 style={{ textTransform: "capitalize" }}>{def.label}</h2>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
        {def.blurb}
      </p>

      {card === "not-tagged" ? (
        <div className="home-projects">
          {missing.map((m) => (
            <div key={`${m.project_id}-${m.mark_code}`} className="project-card home-project">
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>Window {m.mark_code}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {jobCode.get(m.project_id) ?? "?"} · nothing tagged yet
                  </div>
                </div>
              </div>
            </div>
          ))}
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
                    {jobCode.get(p.project_id ?? "") ?? "no job"}
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
  const save = useMutation({
    mutationFn: () =>
      saveContainer({
        id: initial?.id ?? null,
        name,
        address: address || null,
        accessCode: accessCode || null,
        notes: notes || null,
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
          placeholder="Conex 7 / Main warehouse"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
