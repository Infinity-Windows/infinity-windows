import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Wrench,
  Plus,
  Play,
  Square,
  ArrowLeft,
  FileDown,
  CheckCircle2,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  useServiceText,
  useServiceStage,
  type ServiceText,
} from "../../lib/servicing/text";
import { useService } from "../../lib/servicing/useService";
import { discardServiceQueue } from "../../lib/servicing/queue";
import { getServiceSupervisor } from "../../lib/servicing/api";
import {
  emptyServiceUnit,
  SERVICE_STAGES,
  serviceReadiness,
  serviceSeconds,
  timeNeedsReview,
  type ServiceUnit,
  type ServiceVisit,
} from "../../lib/servicing/model";
import { listProjectsAnyStatus } from "../../lib/api";
import { listProfiles, listOpenings } from "../../lib/install/api";
import { listWorkUnits } from "../../lib/customWork/api";
import { listVehicles } from "../../lib/vehicles/api";
import { clockIn, listCostCodes } from "../../lib/timeclock";
import { clockText } from "../../lib/customWork/model";
import { formatApiError } from "../../lib/errors";
import { isMissingTable, isMissingFunction } from "../../lib/schemaErrors";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { roleRank } from "../../lib/nav";
import { ServiceUnitEditor } from "./UnitEditor";
import { ServiceTripEditor } from "./TripEditor";
import { ServiceMediaCapture } from "./MediaCapture";
import { ServiceTimeReview } from "./TimeReview";
import "./servicing.css";
const LegacyService = lazy(() =>
  import("../Service").then((m) => ({ default: m.Service })),
);
export function Servicing() {
  const t = useT(),
    tx = useServiceText(),
    stageText = useServiceStage(),
    [params, setParams] = useSearchParams();
  const visitId = params.get("visit");
  const service = useService(visitId);
  const data = service.data,
    visit = data?.visit;
  const { effectiveRole } = useEffectiveRole(),
    lead = roleRank(effectiveRole) >= 1,
    boss = roleRank(effectiveRole) >= 2;
  const [view, setView] = useState<"visits" | "records" | "legacy">("visits"),
    [jobPick, setJobPick] = useState(params.get("job") ?? ""),
    [search, setSearch] = useState(""),
    [from, setFrom] = useState(""),
    [through, setThrough] = useState("");
  const [selection, setSelection] = useState<string[]>([]),
    [unitId, setUnitId] = useState(""),
    [editor, setEditor] = useState<ServiceUnit | null>(null),
    [tripOpen, setTripOpen] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stage, setStage] = useState("Diagnosis"),
    [activity, setActivity] = useState(""),
    [now, setNow] = useState(Date.now());
  const [allocation, setAllocation] = useState({
    manufacturer: 0,
    customer: 0,
    installer: 0,
    reason: "",
  });
  const projects = useQuery({
    queryKey: ["projectsAll"],
    queryFn: listProjectsAnyStatus,
  });
  const jobId = visit?.project_id ?? jobPick,
    job = projects.data?.find((p) => p.id === jobId),
    user = service.user;
  const refs = useQuery({
    queryKey: ["serviceReferences", user, jobId],
    queryFn: async () => {
      const [people, vehicles, saved, openings, codes] = await Promise.all([
        listProfiles(),
        listVehicles(),
        listWorkUnits(jobId),
        listOpenings(jobId),
        listCostCodes(),
      ]);
      return { people, vehicles, saved, openings, codes };
    },
    enabled: !!user && !!jobId,
  });
  const supervisor = useQuery({
    queryKey: ["serviceSupervisor", jobId],
    queryFn: () => getServiceSupervisor(jobId),
    enabled: !!jobId,
  });
  const shift = service.clock.shift;
  const timed =
    shift?.status === "open" &&
    !shift.break_started_at &&
    shift.project_id === jobId;
  const current =
    data?.sessions.find((s) => s.profile_id === user && !s.ended_at) ??
    service.active.data?.[0];
  const unit =
    data?.units.find((u) => u.id === unitId) ??
    data?.units.find((u) => u.id === current?.unit_id) ??
    data?.units[0];
  const canEditTrip = lead || visit?.created_by === user;
  const canEditUnit = canEditTrip || unit?.created_by === user;
  const blocked = busy || service.queue.some((c) => c.error) || !user;
  const pending =
    service.queue.length > 0 ||
    service.files.some((f) => f.visitId === visitId);
  const gaps = data ? serviceReadiness(data) : [];
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  function openVisit(v: ServiceVisit) {
    setParams({ visit: v.id });
    setUnitId("");
    setEditor(null);
    setTripOpen(false);
    setError("");
    setView("visits");
  }
  async function create(previous?: ServiceVisit) {
    if (!navigator.onLine) throw new Error(tx("offlineNew"));
    const project = previous?.project_id ?? jobPick;
    if (!project) return;
    const openingId = !previous ? params.get("opening") : null;
    const references = openingId ? (await refs.refetch()).data : refs.data;
    const mapped = references?.openings.find((o) => o.id === openingId);
    if (openingId && !mapped)
      throw new Error(
        "This mapped unit is unavailable. Open the job map and select it again.",
      );
    const id = crypto.randomUUID();
    await service.command("visit", {
      id,
      project_id: project,
      previous_visit_id: previous?.id ?? null,
      details: { scheduled_date: new Date().toLocaleDateString("en-CA") },
    });
    setParams({ visit: id });
    setUnitId("");
    setEditor(null);
    setView("visits");
    if (mapped && !previous)
      setEditor({
        ...emptyServiceUnit(id, project),
        opening_id: mapped.id,
        label: mapped.opening_code,
        type_label: mapped.window_types?.name ?? "",
        facts: {
          location: mapped.label ?? "",
          ...(mapped.window_types?.width_in
            ? { width_in: mapped.window_types.width_in }
            : {}),
          ...(mapped.window_types?.height_in
            ? { height_in: mapped.window_types.height_in }
            : {}),
        },
      });
  }
  async function start(
    target: ServiceUnit | null,
    kind: "unit" | "idle" | "travel" = "unit",
  ) {
    if (!visit || !shift || !timed || shift.id.startsWith("pending:"))
      throw new Error(tx("clockSwitch"));
    if (current && current.visit_id !== visit.id)
      throw new Error(tx("clockSwitch"));
    await service.command("start", {
      id: crypto.randomUUID(),
      visit_id: visit.id,
      unit_id: target?.id ?? null,
      shift_id: shift.id,
      kind,
      stage: kind === "unit" ? stage : kind === "idle" ? "Idle time" : "Travel",
      description: target ? "" : activity,
      at: new Date().toISOString(),
      expected_session_id: current?.id ?? null,
    });
    if (kind !== "unit") setActivity("");
  }
  async function save(u: ServiceUnit, begin: boolean) {
    await service.command("unit", { ...u });
    setUnitId(u.id);
    setEditor(null);
    if (begin) await start(u);
  }
  async function exportRows(ids: string[], format: "csv" | "pdf" | "zip") {
    if (pending) throw new Error(tx("queued"));
    const { exportServiceReports } = await import("../../lib/servicing/export");
    await exportServiceReports(ids, projects.data ?? [], format);
  }
  const openMap = jobId ? `/projects/${jobId}/map` : "";
  const failure =
    service.snapshot.error ??
    service.visits.error ??
    refs.error ??
    projects.error;
  return (
    <div className="page servicing">
      <header className="sv-header">
        <div>
          <p className="sv-eyebrow">FORGE WINDOWS &amp; DOORS</p>
          <h1>
            <Wrench aria-hidden="true" />
            {t("servicing.title")}
          </h1>
          <p className="muted">{tx("intro")}</p>
        </div>
        <button onClick={() => void run(service.sync)} disabled={busy}>
          {tx("sync")}
        </button>
      </header>
      <nav className="sv-tabs" aria-label={tx("title")}>
        <button
          aria-pressed={view === "visits"}
          onClick={() => setView("visits")}
        >
          {tx("current")}
        </button>
        <button
          aria-pressed={view === "records"}
          onClick={() => {
            setView("records");
            setParams({});
            setEditor(null);
          }}
        >
          {tx("records")}
        </button>
        {lead && (
          <button
            aria-pressed={view === "legacy"}
            onClick={() => setView("legacy")}
          >
            {tx("legacy")}
          </button>
        )}
      </nav>
      {(error || service.syncError) && (
        <p role="alert" className="sv-notice">
          {error || service.syncError}
        </p>
      )}
      {failure && (
        <p role="alert">
          {isMissingTable(failure) || isMissingFunction(failure)
            ? tx("unavailable")
            : formatApiError(failure)}
        </p>
      )}
      {pending && (
        <div className="sv-notice" role="status">
          <strong>{tx("queued")}</strong>
          <p>
            {service.queue.length} · {service.files.length} {tx("pendingFiles")}
          </p>
          {service.queue.some((c) => c.error) && <p>{tx("queueConflict")}</p>}
          <button onClick={() => void run(service.retry)} disabled={busy}>
            {tx("retry")}
          </button>
          {service.queue.some((c) => c.error) && (
            <div className="sv-actions">
              <button
                onClick={() =>
                  void run(async () => {
                    const { downloadService } = await import(
                      "../../lib/servicing/export"
                    );
                    downloadService(
                      new Blob([JSON.stringify(service.queue, null, 2)], {
                        type: "application/json",
                      }),
                      "Forge-service-recovery.json",
                    );
                  })
                }
              >
                {tx("recovery")}
              </button>
              <button
                onClick={() => {
                  if (user && window.confirm(tx("clearConfirm")))
                    void run(async () => {
                      await discardServiceQueue(user);
                      await service.sync();
                    });
                }}
              >
                {tx("clearSaved")}
              </button>
            </div>
          )}
        </div>
      )}
      {current && !visitId && (
        <button
          className="sv-card sv-resume"
          onClick={() => setParams({ visit: current.visit_id })}
        >
          <Play size={20} />
          {tx("current")} · {clockText(serviceSeconds(current, now))}
        </button>
      )}
      {view === "legacy" && lead ? (
        <Suspense fallback={<p>{tx("loading")}</p>}>
          <LegacyService />
        </Suspense>
      ) : visitId && view === "visits" ? (
        <>
          <button
            className="sv-back"
            onClick={() => {
              setParams({});
              setEditor(null);
            }}
          >
            <ArrowLeft size={16} />
            {tx("back")}
          </button>
          {service.snapshot.isPending && <p role="status">{tx("loading")}</p>}
          {data && visit && (
            <>
              <section className="sv-card">
                <div className="sv-row">
                  <div>
                    <h2>{job?.name ?? tx("loading")}</h2>
                    <p className="muted">
                      {visit.created_at.slice(0, 10)} ·{" "}
                      {tx(
                        visit.status === "completed" ? "completed" : "active",
                      )}{" "}
                      · {visit.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="sv-actions">
                    <Link to={`/projects/${jobId}`}>{tx("viewJob")}</Link>
                    <Link to={openMap}>{tx("map")}</Link>
                  </div>
                </div>
                <button
                  className="sv-details-button"
                  aria-expanded={tripOpen}
                  onClick={() => setTripOpen(!tripOpen)}
                >
                  {tx("crewTravel")}
                </button>
                {tripOpen && (
                  <ServiceTripEditor
                    key={visit.id}
                    visit={visit}
                    vehicles={refs.data?.vehicles ?? []}
                    people={refs.data?.people ?? []}
                    busy={blocked || !canEditTrip}
                    onSave={(details, revision) =>
                      void run(async () => {
                        await service.command("visit", {
                          visit_id: visit.id,
                          revision,
                          details,
                        });
                        setTripOpen(false);
                      })
                    }
                  />
                )}
                {visit.details.lodging && (
                  <div className="sv-notice">
                    <span>
                      {tx(
                        visit.lodging_message_id
                          ? "notifySent"
                          : "notifyPending",
                      )}
                    </span>
                    {!visit.lodging_message_id && (
                      <button
                        onClick={() =>
                          void run(() =>
                            service.command("notify", { visit_id: visit.id }),
                          )
                        }
                      >
                        {tx("retry")}
                      </button>
                    )}
                  </div>
                )}
                {boss && (
                  <label>
                    {tx("supervisor")}
                    <select
                      value={supervisor.data ?? ""}
                      disabled={blocked}
                      onChange={(e) =>
                        void run(async () => {
                          await service.command("supervisor", {
                            project_id: jobId,
                            profile_id: e.target.value || null,
                          });
                          await supervisor.refetch();
                        })
                      }
                    >
                      <option value="">{tx("allSupervisors")}</option>
                      {refs.data?.people
                        .filter((p) => ["supervisor", "owner"].includes(p.role))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.display_name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </section>
              <div className="sv-workspace">
                <aside className="sv-unit-list">
                  <div className="sv-row">
                    <h2>{tx("units")}</h2>
                    <button
                      disabled={blocked}
                      onClick={() =>
                        setEditor(emptyServiceUnit(visit.id, jobId))
                      }
                    >
                      <Plus size={18} />
                      {tx("addUnit")}
                    </button>
                  </div>
                  {!data.units.length && (
                    <p className="muted">{tx("noUnits")}</p>
                  )}
                  {data.units.map((u) => (
                    <button
                      key={u.id}
                      className="sv-unit"
                      aria-pressed={unit?.id === u.id}
                      onClick={() => {
                        setUnitId(u.id);
                        setEditor(null);
                      }}
                    >
                      <strong>{u.label}</strong>
                      <span>{u.type_label}</span>
                      <small>{tx(u.cause)}</small>
                    </button>
                  ))}
                </aside>
                <main className="sv-work-detail">
                  <section
                    className="sv-card sv-clock"
                    aria-label={tx("timer")}
                  >
                    <div className="sv-row">
                      <div>
                        <p className="sv-eyebrow">{tx("timer")}</p>
                        <strong className="sv-timer">
                          {current?.visit_id === visit.id
                            ? clockText(serviceSeconds(current, now))
                            : "0:00:00"}
                        </strong>
                        <p>
                          {current?.visit_id === visit.id
                            ? `${data.units.find((u) => u.id === current.unit_id)?.label ?? tx(current.kind === "travel" ? "travel" : "idle")} · ${stageText(current.stage)}`
                            : unit?.label}
                        </p>
                      </div>
                      <button onClick={service.clock.openClock}>
                        {tx("clockManage")}
                      </button>
                    </div>
                    {!timed && (
                      <div>
                        <p className="muted">{tx("clockHelp")}</p>
                        {shift ? (
                          <p>{tx("clockSwitch")}</p>
                        ) : (
                          <button
                            className="primary"
                            disabled={blocked}
                            onClick={() =>
                              void run(async () => {
                                const code =
                                  refs.data?.codes.find(
                                    (c) => String(c.code) === "11",
                                  ) ??
                                  refs.data?.codes.find(
                                    (c) => String(c.code) === "12",
                                  );
                                await clockIn(
                                  jobId,
                                  code?.id ?? null,
                                  undefined,
                                  "Service visit " + visit.id,
                                );
                                service.clock.refresh();
                              })
                            }
                          >
                            {tx("clockJob")}
                          </button>
                        )}
                      </div>
                    )}
                    {visit.status === "active" && (
                      <>
                        <label>
                          {tx("stage")}
                          <select
                            value={stage}
                            onChange={(e) => setStage(e.target.value)}
                          >
                            {SERVICE_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {stageText(s)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="sv-actions">
                          <button
                            className="primary"
                            disabled={blocked || !timed || !unit}
                            onClick={() => unit && void run(() => start(unit))}
                          >
                            <Play size={18} />
                            {tx("start")}
                          </button>
                          {current?.visit_id === visit.id && (
                            <button
                              disabled={blocked}
                              onClick={() =>
                                void run(() =>
                                  service.command("stop", {
                                    visit_id: visit.id,
                                    expected_session_id: current.id,
                                    at: new Date().toISOString(),
                                  }),
                                )
                              }
                            >
                              <Square size={18} />
                              {tx("stop")}
                            </button>
                          )}
                        </div>
                        <label>
                          {tx("activity")}
                          <input
                            disabled={busy}
                            value={activity}
                            onChange={(e) => setActivity(e.target.value)}
                            maxLength={4000}
                          />
                        </label>
                        <div className="sv-actions">
                          <button
                            disabled={blocked || !timed || !activity.trim()}
                            onClick={() => void run(() => start(null, "idle"))}
                          >
                            {tx("idle")}
                          </button>
                          <button
                            disabled={blocked || !timed || !activity.trim()}
                            onClick={() =>
                              void run(() => start(null, "travel"))
                            }
                          >
                            {tx("travel")}
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                  {editor ? (
                    <ServiceUnitEditor
                      key={editor.id}
                      unit={editor}
                      saved={refs.data?.saved ?? []}
                      openings={refs.data?.openings ?? []}
                      onSave={(u, begin) => void run(() => save(u, begin))}
                      onCancel={() => setEditor(null)}
                      busy={blocked}
                    />
                  ) : (
                    unit && (
                      <section className="sv-card">
                        <div className="sv-row">
                          <h2>
                            {unit.label} · {unit.type_label}
                          </h2>
                          <button
                            disabled={!canEditUnit}
                            onClick={() => setEditor(unit)}
                          >
                            {tx("edit")}
                          </button>
                        </div>
                        <p className="muted">
                          {[
                            unit.facts.material,
                            unit.facts.story,
                            unit.facts.location,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="sv-narrative">{unit.issue}</p>
                        <div className="sv-billing">
                          {tx(
                            unit.cause === "manufacturer"
                              ? "billManufacturer"
                              : unit.cause === "customer"
                                ? "billCustomer"
                                : unit.cause === "installer"
                                  ? "billInstaller"
                                  : "pending",
                          )}
                        </div>
                        {unit.fail_point && (
                          <p>
                            <strong>{tx("failPoint")}: </strong>
                            {unit.fail_point}
                          </p>
                        )}
                        {unit.repair && (
                          <>
                            <h3>{tx("repair")}</h3>
                            <p className="sv-narrative">{unit.repair}</p>
                          </>
                        )}
                        {unit.memo_text && (
                          <>
                            <h3>{tx("transcript")}</h3>
                            <p className="sv-narrative">{unit.memo_text}</p>
                          </>
                        )}
                      </section>
                    )
                  )}
                  {unit && user && !editor && (
                    <ServiceMediaCapture
                      key={unit.id}
                      unit={unit}
                      media={data.media.filter((m) => m.unit_id === unit.id)}
                      user={user}
                      canEditUnit={canEditUnit}
                      lead={lead}
                      busy={blocked}
                      sync={service.sync}
                      saveTranscript={async (m, text) => {
                        await service.command("transcript", {
                          visit_id: visit.id,
                          id: m.id,
                          revision: m.revision,
                          transcript: text,
                        });
                      }}
                      onUseTranscript={async (text) => {
                        await save(
                          {
                            ...unit,
                            memo_text: [unit.memo_text, text]
                              .filter(Boolean)
                              .join("\n\n"),
                          },
                          false,
                        );
                      }}
                    />
                  )}
                </main>
              </div>
              <section className="sv-card">
                <h2>{tx("hours")}</h2>
                <strong className="sv-total">
                  {clockText(
                    data.sessions.reduce(
                      (n, s) => n + serviceSeconds(s, now),
                      0,
                    ),
                  )}
                </strong>
                <div className="sv-labor-list">
                  {data.sessions.map((s) => (
                    <div key={s.id}>
                      <strong>
                        {s.profiles?.display_name ?? s.profile_id}
                      </strong>
                      <span>
                        {data.units.find((u) => u.id === s.unit_id)?.label ??
                          tx(s.kind === "travel" ? "travel" : "idle")}{" "}
                        · {stageText(s.stage)}
                      </span>
                      <span>{clockText(serviceSeconds(s, now))}</span>
                      {s.description && (
                        <p className="sv-narrative">{s.description}</p>
                      )}
                      {timeNeedsReview(s) && (
                        <>
                          <p role="status">{tx("timeReview")}</p>
                          {boss && s.ended_at && (
                            <ServiceTimeReview
                              key={s.started_at + s.ended_at}
                              session={s}
                              busy={blocked}
                              onSave={(data) =>
                                run(() => service.command("review_time", data))
                              }
                            />
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              <section className="sv-card sv-finish">
                <div className="sv-row">
                  <h2>
                    <CheckCircle2 size={22} />
                    {tx(gaps.length ? "reportPending" : "reportReady")}
                  </h2>
                  <span>
                    {tx(
                      visit.reviewed_at ? "billingApproved" : "billingPending",
                    )}
                  </span>
                </div>
                {gaps.length > 0 && (
                  <ul>
                    {gaps.map((k) => (
                      <li key={k}>{tx(`gap_${k}` as ServiceText)}</li>
                    ))}
                  </ul>
                )}
                {visit.status === "active" ? (
                  <>
                    <p className="muted">{tx("finishHelp")}</p>
                    <button
                      className="primary"
                      disabled={
                        blocked ||
                        pending ||
                        !canEditTrip ||
                        data.sessions.some((s) => !s.ended_at)
                      }
                      onClick={() =>
                        void run(() =>
                          service.command("finish", {
                            visit_id: visit.id,
                            revision: visit.revision,
                          }),
                        )
                      }
                    >
                      {tx("finish")}
                    </button>
                  </>
                ) : (
                  <button onClick={() => void run(() => create(visit))}>
                    {tx("returnVisit")}
                  </button>
                )}
                <div className="sv-actions">
                  {(["pdf", "csv", "zip"] as const).map((format) => (
                    <button
                      key={format}
                      disabled={blocked || pending || gaps.length > 0}
                      onClick={() =>
                        void run(() => exportRows([visit.id], format))
                      }
                    >
                      <FileDown size={18} />
                      {tx(
                        format === "pdf"
                          ? "exportPdf"
                          : format === "csv"
                            ? "exportCsv"
                            : "exportPacket",
                      )}
                    </button>
                  ))}
                </div>
                {boss && visit.status === "completed" && (
                  <details
                    onToggle={(e) => {
                      if (e.currentTarget.open)
                        setAllocation(
                          visit.allocation ?? {
                            manufacturer: 0,
                            customer: 0,
                            installer: 0,
                            reason: "",
                          },
                        );
                    }}
                  >
                    <summary>{tx("review")}</summary>
                    <p>{tx("reviewHelp")}</p>
                    <div className="sv-fields">
                      {(["manufacturer", "customer", "installer"] as const).map(
                        (key) => (
                          <label key={key}>
                            {tx(`${key}Pct`)}
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={allocation[key]}
                              onChange={(e) =>
                                setAllocation({
                                  ...allocation,
                                  [key]: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                        ),
                      )}
                    </div>
                    <label>
                      {tx("allocationReason")}
                      <textarea
                        rows={3}
                        value={allocation.reason}
                        onChange={(e) =>
                          setAllocation({
                            ...allocation,
                            reason: e.target.value,
                          })
                        }
                      />
                    </label>
                    <button
                      disabled={
                        blocked ||
                        pending ||
                        gaps.length > 0 ||
                        !allocation.reason.trim() ||
                        allocation.manufacturer +
                          allocation.customer +
                          allocation.installer !==
                          100
                      }
                      onClick={() =>
                        void run(() =>
                          service.command("review", {
                            visit_id: visit.id,
                            revision: visit.revision,
                            allocation,
                          }),
                        )
                      }
                    >
                      {tx("approve")}
                    </button>
                  </details>
                )}
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <section className="sv-card">
            <div className="sv-fields">
              <label>
                {tx("job")}
                <select
                  value={jobPick}
                  onChange={(e) => setJobPick(e.target.value)}
                >
                  <option value="">
                    {view === "records" ? tx("allJobs") : tx("chooseJob")}
                  </option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.job_code} · {p.name} ·{" "}
                      {tx(p.status === "active" ? "active" : "completed")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {tx("search")}
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            {view === "visits" ? (
              <button
                className="primary"
                disabled={blocked || !jobPick}
                onClick={() => void run(() => create())}
              >
                <Plus size={18} />
                {tx("newVisit")}
              </button>
            ) : (
              <>
                <div className="sv-fields">
                  <label>
                    {tx("from")}
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    {tx("through")}
                    <input
                      type="date"
                      value={through}
                      onChange={(e) => setThrough(e.target.value)}
                    />
                  </label>
                </div>
                <div className="sv-actions">
                  <button
                    onClick={() => {
                      setFrom("");
                      setThrough("");
                    }}
                  >
                    {tx("allDates")}
                  </button>
                  <button
                    disabled={
                      blocked ||
                      !selection.length ||
                      !!(from && through && from > through)
                    }
                    onClick={() => void run(() => exportRows(selection, "zip"))}
                  >
                    {tx("exportSelected")} ({selection.length})
                  </button>
                </div>
              </>
            )}
          </section>
          {service.visits.isPending && <p role="status">{tx("loading")}</p>}
          {!service.visits.isPending && !service.visits.data?.length && (
            <p>{tx("nothing")}</p>
          )}
          {[...(projects.data ?? [])]
            .filter(
              (p) =>
                (!jobPick || p.id === jobPick) &&
                `${p.job_code} ${p.name}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((p) => {
              const visits = (service.visits.data ?? [])
                .filter(
                  (v) =>
                    v.project_id === p.id &&
                    (!from ||
                      (v.details.scheduled_date ?? v.created_at.slice(0, 10)) >=
                        from) &&
                    (!through ||
                      (v.details.scheduled_date ?? v.created_at.slice(0, 10)) <=
                        through),
                )
                .sort((a, b) => b.created_at.localeCompare(a.created_at));
              return (
                visits.length > 0 && (
                  <section className="sv-card" key={p.id}>
                    <h2>
                      {p.job_code} · {p.name}
                    </h2>
                    {visits.map((v) => (
                      <div className="sv-visit-row" key={v.id}>
                        {view === "records" && (
                          <label className="sv-check">
                            <input
                              type="checkbox"
                              aria-label={`${tx("select")} ${v.id.slice(0, 8)}`}
                              checked={selection.includes(v.id)}
                              onChange={(e) =>
                                setSelection(
                                  e.target.checked
                                    ? [...selection, v.id]
                                    : selection.filter((x) => x !== v.id),
                                )
                              }
                            />
                          </label>
                        )}
                        <div>
                          <strong>
                            {v.details.scheduled_date ??
                              v.created_at.slice(0, 10)}
                          </strong>
                          <p className="muted">
                            {v.id.slice(0, 8)} ·{" "}
                            {tx(
                              v.status === "completed" ? "completed" : "active",
                            )}
                            {v.previous_visit_id
                              ? ` · ${tx("returnVisit")}`
                              : ""}
                          </p>
                          <p>{v.details.crew_names}</p>
                        </div>
                        <button onClick={() => openVisit(v)}>
                          {tx("open")}
                        </button>
                      </div>
                    ))}
                  </section>
                )
              );
            })}
        </>
      )}
    </div>
  );
}
