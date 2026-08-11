import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  getLocationByAddress,
  getLocationBySerial,
  getMovements,
  getWindowByWindowId,
  loadWindow,
  moveWindow,
  suggestLocation,
  updateWindow,
} from "../lib/api";
import { resolveLocationFromScan } from "../lib/scanResolve";
import { listMarkSpecs, listOpenings } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { indexSpecsByMark, specForOpeningCode } from "../lib/install/specs";
import { SpecCard } from "../components/install/SpecCard";
import { MissingSpecNotice } from "../components/install/MissingSpecNotice";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  FAIL_POINT_OPTIONS,
  listWindowServiceCases,
  openServiceCase,
  SERVICE_STATUS_LABELS,
} from "../lib/service";
import { STATUS_LABELS } from "../lib/types";
import { formatApiError } from "../lib/errors";

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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const unit = useQuery({
    queryKey: ["window", windowId],
    queryFn: () => getWindowByWindowId(windowId),
  });

  const openings = useQuery({
    queryKey: ["projectOpeningsForUnit", unit.data?.project_id],
    queryFn: () => listOpenings(unit.data!.project_id!),
    enabled: Boolean(unit.data?.project_id),
  });

  const markSpecs = useQuery({
    queryKey: ["markSpecs", unit.data?.project_id],
    queryFn: () => listMarkSpecs(unit.data!.project_id!),
    enabled: Boolean(unit.data?.project_id),
  });

  const suggestion = useQuery({
    queryKey: ["suggest", unit.data?.id],
    queryFn: () => suggestLocation(unit.data!.id, unit.data!.project_id ?? null),
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
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
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
    onError: (e) => setActionError(formatApiError(e)),
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
    onError: (e) => setActionError(formatApiError(e)),
  });

  const load = useMutation({
    mutationFn: () => loadWindow(unit.data!.id),
    onSuccess: refresh,
    onError: (e) => setActionError(formatApiError(e)),
  });

  const saveName = useMutation({
    mutationFn: () => updateWindow(unit.data!.id, { display_name: nameDraft }),
    onSuccess: () => {
      setEditingName(false);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["window", windowId] });
    },
    onError: (e) => setActionError(formatApiError(e)),
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

  // Rich spec for the opening this unit is linked to (or would fill).
  const unitOpening = linkedOpening ?? matchingOpening;
  const unitSpec = specForOpeningCode(
    indexSpecsByMark(markSpecs.data ?? []),
    unitOpening?.opening_code,
  );

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <BackChip fallback="/warehouse" label="Back" />
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
        {w.serial && (
          <p className="muted" style={{ margin: 0 }}>
            Serial: <strong>{w.serial}</strong>
          </p>
        )}
        {!editingName ? (
          <p>
            Name: <strong>{w.display_name || "—"}</strong>{" "}
            <button
              className="link"
              onClick={() => {
                setNameDraft(w.display_name ?? "");
                setActionError(null);
                setEditingName(true);
              }}
            >
              Edit
            </button>
          </p>
        ) : (
          <div className="manual-entry" style={{ marginTop: 4 }}>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Friendly name (optional)"
              aria-label="Window display name"
            />
            <button disabled={saveName.isPending} onClick={() => saveName.mutate()}>
              {saveName.isPending ? "…" : "Save"}
            </button>
            <button className="link" onClick={() => setEditingName(false)}>
              Cancel
            </button>
          </div>
        )}
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

      {unitSpec ? (
        <SpecCard spec={unitSpec} projectId={unit.data?.project_id ?? null} />
      ) : (
        // Same calm note as the install sheet, and on the same terms: only when
        // the specs sheet has been read and this mark still isn't in it.
        unitOpening &&
        (markSpecs.data?.length ?? 0) > 0 && (
          <MissingSpecNotice
            projectId={unit.data?.project_id ?? null}
            openingCode={unitOpening.opening_code}
          />
        )
      )}

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
                  serial: w.serial,
                  display_name: w.display_name,
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
          {suggestion.data?.warning && (
            <div className="sched-conflict-inline is-emphasized" role="alert">
              <div>
                <p style={{ margin: 0 }}>{suggestion.data.warning}</p>
                {suggestion.data.missingBay && w.project_id && (
                  <Link
                    to={`/projects/${w.project_id}?tab=warehouse`}
                    className="action-btn"
                    style={{ marginTop: 8 }}
                  >
                    Fix it: open this job&apos;s Warehouse tab →
                  </Link>
                )}
              </div>
            </div>
          )}
          {suggestion.data?.location && (
            <button
              className="action-btn primary"
              onClick={() => moveTo.mutate(suggestion.data!.location!.address)}
            >
              {suggestion.data.warning ? "Put in shared shelf anyway: " : "Put in suggested slot: "}
              {suggestion.data.location.address}
            </button>
          )}
          <p className="scanner-hint">Or scan the destination slot label:</p>
          <Scanner
            onScan={async (payload) => {
              const res = await resolveLocationFromScan(payload, {
                getLocationByAddress,
                getLocationBySerial,
              });
              if (res.status === "ok") {
                moveTo.mutate(res.location.address);
              } else if (res.status === "not-found") {
                setActionError(`No slot found for ${res.query}.`);
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
                list="svc-fail-options"
                value={failPoint}
                onChange={(e) => setFailPoint(e.target.value)}
                placeholder="e.g. Installation / Seal / Hardware / Manufacturer"
              />
              <datalist id="svc-fail-options">
                {FAIL_POINT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
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
