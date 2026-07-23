import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  activeCaseCount,
  attributeServiceCases,
  ATTRIBUTION_UNKNOWN,
  listServiceCases,
  resolveServiceCase,
  scheduleServiceCase,
  SERVICE_STATUS_LABELS,
  type AttributionDimension,
  type ServiceCase,
  type ServiceCaseStatus,
} from "../lib/service";

interface ProjectLite {
  id: string;
  job_code: string;
  name: string;
}
interface TypeLite {
  id: string;
  type_code: string;
  name: string;
}
interface ProfileLite {
  id: string;
  display_name: string;
}
interface WindowLite {
  id: string;
  window_id: string;
}

async function fetchServiceRefs(): Promise<{
  projects: ProjectLite[];
  types: TypeLite[];
  profiles: ProfileLite[];
  windows: WindowLite[];
}> {
  const [projRes, typeRes, profRes, winRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name"),
    supabase.from("window_types").select("id, type_code, name"),
    supabase.from("profiles").select("id, display_name"),
    supabase.from("windows").select("id, window_id"),
  ]);
  if (projRes.error) throw projRes.error;
  if (typeRes.error) throw typeRes.error;
  if (profRes.error) throw profRes.error;
  if (winRes.error) throw winRes.error;
  return {
    projects: (projRes.data ?? []) as ProjectLite[],
    types: (typeRes.data ?? []) as TypeLite[],
    profiles: (profRes.data ?? []) as ProfileLite[],
    windows: (winRes.data ?? []) as WindowLite[],
  };
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  window_type: "Window type",
  installer: "Installer",
  fail_point: "Fail point",
};

export function Service() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ServiceCaseStatus | "all">(
    "open",
  );
  const [dimension, setDimension] = useState<AttributionDimension>("window_type");
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [whenValue, setWhenValue] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");

  const casesQ = useQuery({
    queryKey: ["serviceCasesAll"],
    queryFn: listServiceCases,
  });
  const refsQ = useQuery({ queryKey: ["serviceRefs"], queryFn: fetchServiceRefs });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["serviceCasesAll"] });
    queryClient.invalidateQueries({ queryKey: ["serviceCases"] });
  };

  const schedule = useMutation({
    mutationFn: ({ id, when }: { id: string; when: string }) =>
      scheduleServiceCase(id, new Date(when).toISOString()),
    onSuccess: () => {
      setSchedulingId(null);
      setWhenValue("");
      invalidate();
    },
  });

  const resolve = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      resolveServiceCase(id, note.trim() || null),
    onSuccess: () => {
      setResolvingId(null);
      setNoteValue("");
      invalidate();
    },
  });

  const typeById = useMemo(() => {
    const m = new Map<string, TypeLite>();
    for (const t of refsQ.data?.types ?? []) m.set(t.id, t);
    return m;
  }, [refsQ.data]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of refsQ.data?.profiles ?? []) m.set(p.id, p.display_name);
    return m;
  }, [refsQ.data]);
  const projectById = useMemo(() => {
    const m = new Map<string, ProjectLite>();
    for (const p of refsQ.data?.projects ?? []) m.set(p.id, p);
    return m;
  }, [refsQ.data]);
  const windowById = useMemo(() => {
    const m = new Map<string, WindowLite>();
    for (const w of refsQ.data?.windows ?? []) m.set(w.id, w);
    return m;
  }, [refsQ.data]);

  const all = useMemo(() => casesQ.data ?? [], [casesQ.data]);

  const visible = useMemo(
    () =>
      statusFilter === "all"
        ? all
        : all.filter((c) => c.status === statusFilter),
    [all, statusFilter],
  );

  // Attribution runs over the full set so leads see lifetime callback drivers,
  // not just whatever status is currently filtered.
  const attribution = useMemo(
    () => attributeServiceCases(all, dimension),
    [all, dimension],
  );

  const labelForKey = (key: string): string => {
    if (key === ATTRIBUTION_UNKNOWN) return "Unknown";
    if (dimension === "window_type")
      return typeById.get(key)?.type_code ?? key;
    if (dimension === "installer") return nameById.get(key) ?? key;
    return key;
  };

  const row = (c: ServiceCase) => {
    const type = c.window_type_id ? typeById.get(c.window_type_id) : null;
    const project = c.project_id ? projectById.get(c.project_id) : null;
    const win = windowById.get(c.window_id);
    const installer = c.installer_id ? nameById.get(c.installer_id) : null;
    return (
      <li key={c.id} className="find-row dispatch-row">
        <div style={{ minWidth: 0 }}>
          <div>
            <strong>{SERVICE_STATUS_LABELS[c.status]}</strong>{" "}
            {win ? (
              <Link to={`/w/${win.window_id}`}>{win.window_id}</Link>
            ) : (
              <span className="muted">unit?</span>
            )}
            <span className="muted">
              {" "}
              {type ? `· ${type.type_code}` : ""}
              {project ? ` · ${project.job_code}` : ""}
            </span>
          </div>
          <div style={{ fontSize: 13 }}>
            {c.reason ?? "service case"}
            {c.fail_point ? ` — ${c.fail_point}` : ""}
          </div>
          {c.description && (
            <div className="muted" style={{ fontSize: 12 }}>
              {c.description}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            {installer ? `installer ${installer} · ` : ""}
            opened {fmtWhen(c.created_at)}
            {c.status === "scheduled" && c.scheduled_at
              ? ` · revisit ${fmtWhen(c.scheduled_at)}`
              : ""}
            {c.status === "resolved"
              ? ` · resolved ${fmtWhen(c.resolved_at)}${
                  c.resolution_note ? ` — ${c.resolution_note}` : ""
                }`
              : ""}
          </div>

          {schedulingId === c.id && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <input
                type="datetime-local"
                value={whenValue}
                onChange={(e) => setWhenValue(e.target.value)}
              />
              <button
                className="link"
                disabled={!whenValue || schedule.isPending}
                onClick={() => schedule.mutate({ id: c.id, when: whenValue })}
              >
                Save revisit
              </button>
              <button className="link" onClick={() => setSchedulingId(null)}>
                Cancel
              </button>
            </div>
          )}
          {resolvingId === c.id && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <input
                value={noteValue}
                onChange={(e) => setNoteValue(e.target.value)}
                placeholder="Resolution note (optional)"
                style={{ flex: 1, minWidth: 160 }}
              />
              <button
                className="link"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: c.id, note: noteValue })}
              >
                Mark resolved
              </button>
              <button className="link" onClick={() => setResolvingId(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {c.status !== "resolved" && schedulingId !== c.id && resolvingId !== c.id && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              className="link"
              onClick={() => {
                setSchedulingId(c.id);
                setWhenValue("");
              }}
            >
              {c.status === "scheduled" ? "Reschedule" : "Schedule"}
            </button>
            <button
              className="link"
              onClick={() => {
                setResolvingId(c.id);
                setNoteValue("");
              }}
            >
              Resolve
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Cross-project · warranty</p>
          <h1>Service</h1>
        </div>
        <Link to="/issues" className="button-like">
          Issues →
        </Link>
      </header>

      <p className="muted">
        After-service &amp; warranty callbacks across every job. Open a case from
        any installed unit&apos;s history; schedule the revisit, then resolve it.{" "}
        {activeCaseCount(all)} still need action.
      </p>

      {(schedule.isError || resolve.isError) && (
        <p className="error">{String(schedule.error ?? resolve.error)}</p>
      )}

      <h2>Fail-point attribution</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Which products, people, and procedures drive warranty callbacks.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        <select
          value={dimension}
          onChange={(e) => setDimension(e.target.value as AttributionDimension)}
        >
          {(Object.keys(DIMENSION_LABELS) as AttributionDimension[]).map((d) => (
            <option key={d} value={d}>
              By {DIMENSION_LABELS[d].toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      {attribution.length === 0 ? (
        <p className="muted">No service cases yet.</p>
      ) : (
        <ul className="unit-list">
          {attribution.map((r) => (
            <li key={r.key} className="find-row">
              <div>
                <strong>{labelForKey(r.key)}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {" "}
                  · {r.open} open · {r.scheduled} scheduled · {r.resolved} resolved
                </span>
              </div>
              <strong style={{ marginLeft: "auto" }}>{r.total}</strong>
            </li>
          ))}
        </ul>
      )}

      <h2>Cases</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 16px" }}>
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as ServiceCaseStatus | "all")
          }
        >
          <option value="open">Open</option>
          <option value="scheduled">Scheduled</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>

      {casesQ.isLoading && <p className="muted">Loading service cases…</p>}
      {casesQ.isError && <p className="error">{String(casesQ.error)}</p>}

      {!casesQ.isLoading && !casesQ.isError && (
        <ul className="unit-list work-list">
          {visible.map(row)}
          {visible.length === 0 && (
            <p className="muted">No service cases match this filter.</p>
          )}
        </ul>
      )}
    </div>
  );
}
