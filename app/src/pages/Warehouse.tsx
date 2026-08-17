import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { UnitSearch } from "../components/UnitSearch";
import { Explain } from "../components/ui/Explain";
import { PackageMap } from "../components/warehouse/PackageMap";
import { listActivePackages, listContainers } from "../lib/storage";
import { listIssues } from "../lib/issues";
import {
  cardLink,
  listScheduledMarks,
  WAREHOUSE_CARDS,
  warehouseCounts,
} from "../lib/warehouse/warehouseCards";

interface WarehouseLink {
  to: string;
  label: string;
  desc: string;
  lead?: boolean;
}

const LINKS: WarehouseLink[] = [
  { to: "/storage", label: "Storage", desc: "Conex & package tracking" },
  { to: "/scan", label: "Scan", desc: "QR a window or a slot" },
  { to: "/count", label: "Cycle count", desc: "Count a slot, flag gaps" },
  { to: "/receive", label: "Receive", desc: "Log arriving units", lead: true },
  { to: "/labels", label: "Slot labels", desc: "Print rack/slot QR labels", lead: true },
  { to: "/catalog", label: "Catalog", desc: "Import window types", lead: true },
  { to: "/supplies", label: "Supplies", desc: "Track consumables & reorder", lead: true },
];

export function Warehouse() {
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Same query keys as the storage screens, so the hub rides their cache.
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const issues = useQuery({ queryKey: ["issues"], queryFn: listIssues });

  const activeIds = useMemo(
    () => (projects.data ?? []).map((p) => p.id),
    [projects.data],
  );
  const marks = useQuery({
    queryKey: ["scheduledMarks", activeIds],
    queryFn: () => listScheduledMarks(activeIds),
    enabled: activeIds.length > 0,
  });

  const openDamage = (issues.data ?? []).filter(
    (i) => i.kind === "damage" && i.status === "open",
  ).length;

  const counts = warehouseCounts(
    packages.data ?? [],
    containers.data ?? [],
    marks.data ?? [],
    openDamage,
  );
  const ready = packages.isSuccess && containers.isSuccess;

  const links = LINKS.filter((l) => !l.lead || lead);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Inventory hub</h1>
        </div>
      </header>

      {/* Folded by default and remembered per person: new crew open it once,
          a foreman who knows the system never sees it again. */}
      <Explain id="warehouse-how" summary="How does tracking work?" raw>
        <PackageMap />
      </Explain>

      <h2>Locate</h2>
      <UnitSearch limit={8} />

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
      {packages.isError && (
        <p className="error">{formatApiError(packages.error)}</p>
      )}

      <h2>Operations</h2>
      <div className="warehouse-grid">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="warehouse-tile">
            <strong>{l.label}</strong>
            <span className="muted">{l.desc}</span>
          </Link>
        ))}
      </div>

      <h2>By job</h2>
      <div className="home-projects">
        {(projects.data ?? []).slice(0, 8).map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}?tab=warehouse`}
            className="project-card home-project"
          >
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name || p.job_code}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {p.job_code}
                  {p.address ? ` · ${p.address}` : ""}
                </div>
              </div>
              <span className="muted">›</span>
            </div>
          </Link>
        ))}
        {projects.data?.length === 0 && <p className="muted">No active jobs.</p>}
      </div>
    </div>
  );
}
