import { VoiceInput } from "../../components/voice/VoiceInput";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { roleRank } from "../../lib/nav";
import { listProfilesIncludingRemoved } from "../../lib/install/api";
import { listWorkHistory } from "../../lib/customWork/api";
import { useWork } from "../../lib/customWork/useWork";
import {
  clockText,
  FACT_LABELS,
  factText,
  unitSummary,
  workerSeconds,
  type WorkSession,
  type WorkUnit,
} from "../../lib/customWork/model";
import { formatApiError } from "../../lib/errors";
import { CrewWork } from "./CrewWork";
import { UnitEditor } from "./UnitEditor";
import { QueueNotice } from "./QueueNotice";
import "./customWork.css";

const localTime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const csv = (value: unknown) =>
  `"${String(value ?? "")
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`;
export function CustomData({ projectId }: { projectId: string }) {
  const work = useWork(projectId);
  const { effectiveRole } = useEffectiveRole();
  const lead = roleRank(effectiveRole) >= 1;
  const [query, setQuery] = useState(""),
    [worker, setWorker] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [edit, setEdit] = useState<WorkUnit | null>(null),
    [session, setSession] = useState<WorkSession | null>(null);
  const [reason, setReason] = useState(""),
    [typeName, setTypeName] = useState("");
  const [renameType, setRenameType] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [reviewTime, setReviewTime] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const crew = useQuery({
    queryKey: ["customWorkRosterAll"],
    queryFn: listProfilesIncludingRemoved,
  });
  const history = useQuery({
    queryKey: ["customWorkHistory", projectId, work.user],
    queryFn: () => listWorkHistory(projectId),
    enabled: historyOpen,
  });
  const names = new Map(
    crew.data?.map((p) => [p.id, p.display_name ?? "Former worker"]),
  );
  const allUnits = work.units.filter((u) => u.project_id === projectId);
  const units = allUnits.filter((u) =>
    `${u.label} ${u.type_label} ${u.facts.material ?? ""} ${u.facts.story ?? ""} ${u.facts.location ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const allSessions = work.sessions.filter((s) => s.project_id === projectId);
  const sessions = allSessions.filter(
    (s) =>
      (!worker || s.profile_id === worker) &&
      (!from || s.started_at.slice(0, 10) >= from) &&
      (!to || s.started_at.slice(0, 10) <= to),
  );
  const filtered = !!worker || !!from || !!to;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = allUnits
    .map((u) => unitSummary(u, allSessions))
    .filter((s) => s.ready);
  const byType = [...new Set(allUnits.map((u) => u.type_label))].map((type) => {
    const sample = allUnits
      .filter((u) => u.type_label === type)
      .map((u) => unitSummary(u, allSessions))
      .filter((r) => r.ready);
    const area = sample.reduce((sum, r) => sum + r.area!, 0);
    return {
      type,
      count: sample.length,
      area,
      hours: sample.reduce((sum, r) => sum + r.labor / 3600, 0),
    };
  });
  const totalArea = ready.reduce((sum, s) => sum + s.area!, 0),
    totalLabor = ready.reduce((sum, s) => sum + s.labor, 0);
  const exportRows = () => {
    const headers = [
      "Unit",
      "Type",
      "Unit SQF (repeated; count once per Unit ID)",
      "Worker",
      "Activity",
      "Stage",
      "Start UTC",
      "End UTC",
      "Description",
      "Outcome",
      "Delay",
      "Details",
      "Unit ID",
      "Capture ID",
      "Shift ID",
      "Shift status",
      "Needs review",
      "Closed worker seconds",
    ];
    const lines = sessions.map((s) => {
      const u = allUnits.find((x) => x.id === s.unit_id);
      return [
        u?.label,
        u?.type_label,
        u ? unitSummary(u, allSessions).area : null,
        names.get(s.profile_id) ?? s.profile_id,
        s.kind,
        s.stage,
        s.started_at,
        s.ended_at,
        s.description,
        s.outcome,
        s.delay_reason,
        JSON.stringify(u?.facts ?? {}),
        u?.id,
        s.id,
        s.shift_id,
        s.shift_status,
        s.review_required,
        s.ended_at ? workerSeconds([s]) : null,
      ]
        .map(csv)
        .join(",");
    });
    const url = URL.createObjectURL(
      new Blob([[headers.map(csv).join(","), ...lines].join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "forge-custom-data.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="custom-work">
      <div className="cw-heading">
        <div>
          <h2>Custom Data</h2>
          <p>Unit work and prep time captured by the crew.</p>
        </div>
        <Link className="cw-link" to={`/current-work?job=${projectId}`}>
          Start / record work
        </Link>
      </div>
      <QueueNotice work={work} />
      <CrewWork work={work} jobId={projectId} canRecord={lead} />
      {(error || work.error) && (
        <p role="alert" className="cw-error">
          {error || formatApiError(work.error)}
        </p>
      )}
      {work.loading && <p>Loading custom records…</p>}
      {!work.error && !work.loading && (
        <>
          <div className="cw-metrics">
            <div>
              <strong>{allUnits.length}</strong>
              <span>Recorded units</span>
            </div>
            <div>
              <strong>
                {(
                  workerSeconds(allSessions.filter((s) => s.kind === "unit")) /
                  3600
                ).toFixed(1)}
                h
              </strong>
              <span>Closed unit man-hours</span>
            </div>
            <div>
              <strong>
                {(
                  workerSeconds(allSessions.filter((s) => s.kind === "idle")) /
                  3600
                ).toFixed(1)}
                h
              </strong>
              <span>Closed prep-time man-hours</span>
            </div>
            <div>
              <strong>
                {ready.length}/{allUnits.length}
              </strong>
              <span>Candidate pricing samples</span>
            </div>
          </div>
          <p className="muted">
            All-time custom capture only. Job-clock hours, existing unit
            sessions, open timers and unallocated work are not added again here.
            A finish records the work reported, not QC approval.
          </p>
          {totalArea > 0 && (
            <p>
              Completed samples:{" "}
              <strong>
                {(totalLabor / 3600 / totalArea).toFixed(3)} worker-hours / SQF
              </strong>{" "}
              across {ready.length} units and {totalArea.toFixed(1)} SQF. Verify
              scope, helpers and measurements before setting prices.
            </p>
          )}
          <details>
            <summary>Labor per SQF by unit type</summary>
            <p className="muted">
              Whole-unit completion must be marked in Unit details. Finishing
              one work session is not the same as finishing the entire
              installation.
            </p>
            {byType.map((row) => (
              <p key={row.type}>
                <strong>{row.type}</strong> · {row.count} complete samples ·{" "}
                {row.area > 0
                  ? (row.hours / row.area).toFixed(3) + " worker-hours / SQF"
                  : "Not enough complete data"}
                {row.count < 5 ? " · Small sample" : ""}
              </p>
            ))}
          </details>
          <div className="cw-grid">
            <label>
              Find unit / type / material / floor
              <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label>
              Worker
              <select
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
              >
                <option value="">Everyone</option>
                {crew.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From date (UTC)
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              Through date (UTC)
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <button onClick={exportRows}>Export displayed time records</button>
          {filtered && (
            <p className="muted">
              Worker/date filters apply to the timeline and export. Unit
              benchmarks keep all crew visits so partial time is not divided by
              a whole unit’s area.
            </p>
          )}
          <div className="cw-unit-list">
            {units.map((u) => {
              const stats = unitSummary(u, allSessions);
              return (
                <section className="cw-card" key={u.id}>
                  <div className="cw-heading">
                    <h3>{u.label}</h3>
                    <span className="cw-badge">
                      {stats.running
                        ? "Running"
                        : stats.finished
                          ? "Entire install reported complete"
                          : "In progress"}
                    </span>
                  </div>
                  <p>
                    {u.type_label} · {stats.area?.toFixed(1) ?? "Unknown"} SQF ·{" "}
                    {(stats.labor / 3600).toFixed(2)} crew hours
                  </p>
                  <dl className="cw-facts">
                    {Object.entries(u.facts).map(([k, v]) => (
                      <div key={k}>
                        <dt>{FACT_LABELS[k] ?? k.replaceAll("_", " ")}</dt>
                        <dd>{factText(k, v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {!stats.ready && (
                    <p className="cw-notice">
                      Not yet a pricing sample: check size, type, completed
                      work, closed job clocks and any time review flags. Units
                      with older tracking time stay out of these benchmarks
                      because this report only totals custom capture. Work filed without timers is also excluded: its hours were not measured.
                    </p>
                  )}
                  <div className="cw-actions">
                    <Link to={`/current-work?job=${projectId}&unit=${u.id}`}>
                      Work / join
                    </Link>
                    {u.opening_id && (
                      <Link to={`/projects/${projectId}?tab=maps-interactive`}>
                        View map
                      </Link>
                    )}
                    {(lead || u.created_by === work.user) && (
                      <button onClick={() => setEdit(u)}>
                        Edit / assign record
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          {!allUnits.length && (
            <p>
              No custom units yet. Start work to record one, even without plans
              or a unit list.
            </p>
          )}
          {edit && (
            <UnitEditor
              unit={edit}
              types={work.types}
              busy={busy}
              onCancel={() => setEdit(null)}
              onSave={async (d) =>
                run(async () => {
                  await work.command("unit", d);
                  setEdit(null);
                })
              }
            />
          )}
          <h3>Work timeline</h3>
          <div className="cw-unit-list">
            {sessions
              .slice()
              .sort((a, b) => b.started_at.localeCompare(a.started_at))
              .map((s) => (
                <article className="cw-card" key={s.id}>
                  <strong>
                    {names.get(s.profile_id) ?? "Worker"} ·{" "}
                    {s.kind === "idle"
                      ? "Prep time"
                      : (allUnits.find((u) => u.id === s.unit_id)?.label ??
                        "Unit")}
                  </strong>
                  <p>
                    {s.kind === "idle"
                      ? "Support work"
                      : `${s.stage} · ${s.participation}`}{" "}
                    · {new Date(s.started_at).toLocaleString()} →{" "}
                    {s.ended_at
                      ? new Date(s.ended_at).toLocaleString()
                      : "Running"}
                  </p>
                  <p>
                    {s.ended_at ? clockText(workerSeconds([s])) : "Open timer"}{" "}
                    · {s.outcome ?? s.end_reason ?? "In progress"}
                  </p>
                  <p>{s.description || "No accomplishment note yet."}</p>
                  {s.review_required && (
                    <p className="cw-notice">
                      Time or job attribution needs review.
                    </p>
                  )}
                  {s.delay_reason && <p>Delay: {s.delay_reason}</p>}
                  {(lead || s.profile_id === work.user) && (
                    <button
                      onClick={() => {
                        setSession(s);
                        setReason("");
                        setReviewTime(false);
                      }}
                    >
                      Correct details
                    </button>
                  )}
                </article>
              ))}
          </div>
          {session && (
            <section className="cw-card">
              <h3>Correct work details</h3>
              <label>
                Accomplishment / idle description
                <VoiceTextarea
                  value={session.description}
                  onChange={(e) =>
                    setSession({ ...session, description: e.target.value })
                  }
                />
              </label>
              <label>
                Outcome
                <select
                  value={session.outcome ?? ""}
                  onChange={(e) =>
                    setSession({
                      ...session,
                      outcome: (e.target.value ||
                        null) as WorkSession["outcome"],
                    })
                  }
                >
                  <option value="">Not finished</option>
                  {["finished", "partial", "blocked", "rework"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Delay reason
                <VoiceInput
                  value={session.delay_reason}
                  onChange={(e) =>
                    setSession({ ...session, delay_reason: e.target.value })
                  }
                />
              </label>
              {lead && session.ended_at && (
                <>
                  <label>
                    Started (local time)
                    <input
                      type="datetime-local"
                      value={localTime(session.started_at)}
                      onChange={(e) => {
                        if (e.target.value) {
                          setSession({
                            ...session,
                            started_at: new Date(e.target.value).toISOString(),
                          });
                          setReviewTime(true);
                        }
                      }}
                    />
                  </label>
                  <label>
                    Ended (local time)
                    <input
                      type="datetime-local"
                      value={localTime(session.ended_at)}
                      onChange={(e) => {
                        if (e.target.value) {
                          setSession({
                            ...session,
                            ended_at: new Date(e.target.value).toISOString(),
                          });
                          setReviewTime(true);
                        }
                      }}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewTime}
                      onChange={(e) => setReviewTime(e.target.checked)}
                    />
                    I checked these times, breaks and the job assignment
                  </label>
                </>
              )}
              <label>
                Correction reason
                <VoiceInput
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="cw-actions">
                <button
                  disabled={busy || reason.trim().length < 3}
                  onClick={() =>
                    void run(async () => {
                      await work.command("session", {
                        id: session.id,
                        revision: session.revision,
                        description: session.description,
                        outcome: session.outcome,
                        delay_reason: session.delay_reason,
                        reason,
                        ...(reviewTime
                          ? {
                              started_at: session.started_at,
                              ended_at: session.ended_at,
                              review_time: true,
                            }
                          : {}),
                      });
                      setSession(null);
                    })
                  }
                >
                  Save correction
                </button>
                <button onClick={() => setSession(null)}>Cancel</button>
              </div>
              <p className="muted">
                These corrections change captured activity only. The job clock
                must be closed and its job and time bounds must match. Timecard
                corrections remain in the existing timecard workflow.
              </p>
            </section>
          )}
          {lead && (
            <details>
              <summary>Manage reusable unit types</summary>
              <div className="cw-actions">
                <label>
                  New type
                  <input
                    value={typeName}
                    onChange={(e) => setTypeName(e.target.value)}
                    maxLength={100}
                  />
                </label>
                <button
                  disabled={busy || !typeName.trim()}
                  onClick={() =>
                    void run(async () => {
                      await work.command("type", {
                        id: crypto.randomUUID(),
                        revision: 0,
                        label: typeName.trim(),
                        archived: false,
                      });
                      setTypeName("");
                    })
                  }
                >
                  Add type
                </button>
              </div>
              {work.types.map((t) => (
                <div className="cw-actions" key={t.id}>
                  <span>
                    {t.label}
                    {t.archived ? " (archived)" : ""}
                  </span>
                  {renameType?.id === t.id ? (
                    <>
                      <input
                        aria-label="Rename type"
                        value={renameType.label}
                        onChange={(e) =>
                          setRenameType({
                            ...renameType,
                            label: e.target.value,
                          })
                        }
                      />
                      <button
                        disabled={busy || !renameType.label.trim()}
                        onClick={() =>
                          void run(async () => {
                            await work.command("type", {
                              ...t,
                              label: renameType.label.trim(),
                            });
                            setRenameType(null);
                          })
                        }
                      >
                        Save name
                      </button>
                      <button onClick={() => setRenameType(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        setRenameType({ id: t.id, label: t.label })
                      }
                    >
                      Rename
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        work.command("type", { ...t, archived: !t.archived }),
                      )
                    }
                  >
                    {t.archived ? "Restore" : "Archive"}
                  </button>
                </div>
              ))}
            </details>
          )}
          <details onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
            <summary>Record history</summary>
            {history.error && (
              <p role="alert">{formatApiError(history.error)}</p>
            )}
            {history.data?.map((h) => (
              <div className="cw-history" key={h.id}>
                <strong>
                  {h.action} · {names.get(h.actor_id) ?? "Worker"}
                </strong>
                <p>
                  {new Date(h.created_at).toLocaleString()} · {h.reason}
                </p>
                <details>
                  <summary>Before / after</summary>
                  <pre>
                    {JSON.stringify(
                      { before: h.before_value, after: h.after_value },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}
