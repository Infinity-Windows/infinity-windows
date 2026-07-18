import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  getLocationByAddress,
  getMovements,
  getWindowByWindowId,
  loadWindow,
  moveWindow,
  suggestLocation,
} from "../lib/api";
import { listOpenings } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  listWindowServiceCases,
  openServiceCase,
  SERVICE_STATUS_LABELS,
} from "../lib/service";
import { STATUS_LABELS } from "../lib/types";

// Friendly labels for the movement log so the unit history reads in plain
// English (raw event codes fall through unchanged).
const EVENT_LABELS: Record<string, string> = {
  received: "Received",
  putaway: "Put away",
  moved: "Moved",
  staged: "Staged for job",
  loaded: "Loaded on truck",
  unloaded: "Unloaded on site",
  installed: "Installed",
  uninstalled: "Install undone",
  damaged: "Damaged",
  preissued: "Pre-issued",
  assigned: "Assigned",
  count_verified: "Count verified",
  count_missing: "Count missing",
  override: "Override",
};

export function WindowDetail() {
  const { windowId = "" } = useParams();
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const canService = isForemanPlus(effectiveRole);
  const [moving, setMoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [serviceForm, setServiceForm] = useState(false);
  const [reason, setReason] = useState("");
  const [failPoint, setFailPoint] = useState("");
  const [description, setDescription] = useState("");

  const unit = useQuery({
    queryKey: ["window", windowId],
    queryFn: () => getWindowByWindowId(windowId),
  });

  const openings = useQuery({
    queryKey: ["projectOpeningsForUnit", unit.data?.project_id],
    queryFn: () => listOpenings(unit.data!.project_id!),
    enabled: Boolean(unit.data?.project_id),
  });

  const suggestion = useQuery({
    queryKey: ["suggest", unit.data?.id],
    queryFn: () => suggestLocation(unit.data!.id),
    enabled: Boolean(unit.data?.id) && moving,
  });

  const movements = useQuery({
    queryKey: ["movements", unit.data?.id],
    queryFn: () => getMovements(unit.data!.id),
    enabled: Boolean(unit.data?.id),
  });

  const serviceCases = useQuery({
    queryKey: ["serviceCases", unit.data?.id],
    queryFn: () => listWindowServiceCases(unit.data!.id),
    enabled: Boolean(unit.data?.id) && canService,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["window", windowId] });
    queryClient.invalidateQueries({ queryKey: ["movements"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const openCase = useMutation({
    mutationFn: () =>
      openServiceCase({
        windowId: unit.data!.id,
        reason: reason.trim(),
        failPoint: failPoint.trim() || null,
        description: description.trim() || null,
      }),
    onSuccess: () => {
      setServiceForm(false);
      setReason("");
      setFailPoint("");
      setDescription("");
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["serviceCases", unit.data?.id] });
      queryClient.invalidateQueries({ queryKey: ["serviceCasesAll"] });
    },
    onError: (e) => setActionError(String(e)),
  });

  const moveTo = useMutation({
    mutationFn: async (address: string) => {
      const location = await getLocationByAddress(address);
      if (!location) throw new Error(`No slot with address ${address}`);
      return moveWindow(unit.data!.id, location.id);
    },
    onSuccess: () => {
      setMoving(false);
      setActionError(null);
      refresh();
    },
    onError: (e) => setActionError(String(e)),
  });

  const load = useMutation({
    mutationFn: () => loadWindow(unit.data!.id),
    onSuccess: refresh,
    onError: (e) => setActionError(String(e)),
  });

  if (unit.isLoading) return <div className="page">Loading...</div>;
  if (!unit.data) {
    return (
      <div className="page">
        <p className="error">No window found with ID {windowId}.</p>
      </div>
    );
  }

  const w = unit.data;
  const projectOpenings = openings.data ?? [];
  const hasOpenings = projectOpenings.length > 0;
  const linkedOpening = projectOpenings.find((o) => o.assigned_window_id === w.id);
  const matchingOpening =
    linkedOpening ??
    projectOpenings.find(
      (o) =>
        o.status !== "installed" &&
        o.window_type_id === w.window_type_id &&
        !o.assigned_window_id,
    );
  const canMarkInstalledQuick =
    (w.status === "loaded" || w.status === "staged") && !hasOpenings;

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Link to="/search" className="back-chip" aria-label="Back">‹</Link>
          <div>
            <h1 className="opening-code-title">{w.window_id}</h1>
            {w.short_code && (
              <p className="short-code-hero" style={{ margin: "2px 0 0" }}>
                Code <strong>{w.short_code}</strong>
              </p>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {w.window_types?.type_code} · {STATUS_LABELS[w.status]}
            </p>
          </div>
        </div>
      </header>

      <div className="detail-card">
        <p>
          <strong>{w.window_types?.name}</strong>{" "}
          <span className="muted">({w.window_types?.type_code})</span>
        </p>
        <p>
          Status: <strong>{STATUS_LABELS[w.status]}</strong>
        </p>
        <p className="location-line">
          Location:{" "}
          <strong className="big-address">
            {w.locations?.address ?? "not in a slot"}
          </strong>
        </p>
        {w.projects && (
          <p>
            Job:{" "}
            <Link to={`/projects/${w.project_id}`}>
              <strong>{w.projects.job_code}</strong>
            </Link>{" "}
            — {w.projects.name}
          </p>
        )}
        {w.window_types?.difficulty_rating && (
          <p>
            Install difficulty: {"\u2605".repeat(w.window_types.difficulty_rating)}
          </p>
        )}
        {w.window_types?.tutorial_url && (
          <p>
            <a href={w.window_types.tutorial_url}>Install tutorial</a>
          </p>
        )}
      </div>

      {actionError && <p className="error">{actionError}</p>}

      {!moving ? (
        <div className="action-list">
          <button className="action-btn primary" onClick={() => setMoving(true)}>
            Move / put away
          </button>
          {w.project_id && w.status !== "loaded" && w.status !== "installed" && (
            <button className="action-btn" onClick={() => load.mutate()}>
              Load on truck for {w.projects?.job_code}
            </button>
          )}
          {hasOpenings &&
            (w.status === "loaded" ||
              w.status === "staged" ||
              w.status === "in_warehouse") && (
              <Link
                className="action-btn primary"
                to={
                  matchingOpening
                    ? `/projects/${w.project_id}/opening/${matchingOpening.id}`
                    : `/projects/${w.project_id}?tab=map`
                }
              >
                {linkedOpening
                  ? `Open install memo (${linkedOpening.opening_code})`
                  : matchingOpening
                    ? `Install via opening ${matchingOpening.opening_code}`
                    : "Open job map to install"}
              </Link>
            )}
          {canMarkInstalledQuick && (
            <p className="muted">
              This job has no openings mapped — use the job hub Map tab to
              capture an install memo, or mark warehouse-only installs from the
              opening sheet once openings exist.
            </p>
          )}
          <button
            className="action-btn"
            onClick={async () => {
              const bytes = await windowLabelsPdf([
                {
                  window_id: w.window_id,
                  typeName: w.window_types?.name ?? "",
                  short_code: w.short_code,
                },
              ]);
              downloadPdf(bytes, `${w.window_id}.pdf`);
            }}
          >
            Reprint label
          </button>
          {canService && !serviceForm && (
            <button
              className="action-btn"
              onClick={() => {
                setActionError(null);
                setServiceForm(true);
              }}
            >
              Open service / warranty case
            </button>
          )}
        </div>
      ) : (
        <div>
          {suggestion.data && (
            <button
              className="action-btn primary"
              onClick={() => moveTo.mutate(suggestion.data!.address)}
            >
              Put in suggested slot: {suggestion.data.address}
            </button>
          )}
          <p className="scanner-hint">Or scan the destination slot label:</p>
          <Scanner
            onScan={(payload) => {
              if (payload.kind === "location") {
                moveTo.mutate(payload.address);
              } else {
                setActionError("That's a window label — scan a slot label.");
              }
            }}
          />
          <button className="link" onClick={() => setMoving(false)}>
            Cancel move
          </button>
        </div>
      )}

      {canService && (
        <>
          <h2>Service &amp; warranty</h2>
          {serviceForm && (
            <div className="detail-card">
              <p className="muted" style={{ marginTop: 0 }}>
                Open an after-service / warranty case against this unit. We link
                it back to the install and installer automatically.
              </p>
              <label className="field-label" htmlFor="svc-reason">
                What&apos;s wrong? *
              </label>
              <input
                id="svc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Air leak at bottom sash"
              />
              <label className="field-label" htmlFor="svc-fail">
                Fail point (optional)
              </label>
              <input
                id="svc-fail"
                value={failPoint}
                onChange={(e) => setFailPoint(e.target.value)}
                placeholder="e.g. seal / flashing / hardware / glass"
              />
              <label className="field-label" htmlFor="svc-desc">
                Details (optional)
              </label>
              <textarea
                id="svc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
              <div className="action-list" style={{ marginTop: 8 }}>
                <button
                  className="action-btn primary"
                  disabled={!reason.trim() || openCase.isPending}
                  onClick={() => openCase.mutate()}
                >
                  {openCase.isPending ? "Opening…" : "Open case"}
                </button>
                <button className="link" onClick={() => setServiceForm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {serviceCases.data && serviceCases.data.length > 0 ? (
            <ul className="history-list">
              {serviceCases.data.map((c) => (
                <li key={c.id}>
                  <Link to="/service">
                    <strong>{SERVICE_STATUS_LABELS[c.status]}</strong>
                  </Link>{" "}
                  {c.reason ?? "service case"}
                  {c.fail_point ? ` — ${c.fail_point}` : ""}
                  <span className="muted">
                    {" "}
                    · opened {new Date(c.created_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            !serviceForm && (
              <p className="muted">No service cases on this unit.</p>
            )
          )}
        </>
      )}

      <h2>History</h2>
      <ul className="history-list">
        {(movements.data ?? []).map((m) => (
          <li key={m.id}>
            <span className="muted">
              {new Date(m.created_at).toLocaleString()}
            </span>{" "}
            {EVENT_LABELS[m.event] ?? m.event}
            {m.actor ? ` by ${m.actor}` : ""}
            {m.reason ? ` — ${m.reason}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
