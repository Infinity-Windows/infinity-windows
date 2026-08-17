// The foreman's estimating screen (CONTEXT.md fallback ladder; standing
// decision: foreman+ only — installers never see it). One row per unit:
// the ladder resolved for its signature, the honesty label always on the
// number, "no estimate yet" where the data is thin, and a local manual
// figure — clearly labelled — as the only substitute. Evidence is
// sessions-first with legacy wall-clock figures for units that predate
// sessions, counted once and said out loud.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  combineEvidence,
  estimateJobUnits,
  installEventsEvidence,
  sessionsEvidence,
} from "../../lib/estimate/cohorts";
import { listOpenings } from "../../lib/install/api";

export function SignatureEstimates({ projectId }: { projectId: string }) {
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const sessions = useQuery({
    queryKey: ["cohortEvidence", "sessions"],
    queryFn: sessionsEvidence,
    staleTime: 60_000,
  });
  const legacy = useQuery({
    queryKey: ["cohortEvidence", "legacy"],
    queryFn: installEventsEvidence,
    staleTime: 60_000,
  });
  // Local, unsaved, clearly labelled — never dressed as data.
  const [manual, setManual] = useState<Record<string, string>>({});

  const evidence = useMemo(
    () => combineEvidence(sessions.data ?? [], legacy.data ?? []),
    [sessions.data, legacy.data],
  );
  const job = useMemo(
    () =>
      estimateJobUnits(
        (openings.data ?? []).map((o) => ({
          id: o.id,
          opening_code: o.opening_code,
          status: o.status,
          sig_key: o.sig_key ?? null,
          signature: (o as { signature?: unknown }).signature ?? null,
        })),
        evidence,
      ),
    [openings.data, evidence],
  );

  const legacyCount = useMemo(() => {
    const covered = new Set(
      (sessions.data ?? []).map((e) => e.unitId).filter(Boolean),
    );
    return (legacy.data ?? []).filter((e) => !e.unitId || !covered.has(e.unitId)).length;
  }, [sessions.data, legacy.data]);

  const manualTotal = job.rows
    .filter((r) => !r.installed && r.estimate?.minutes == null)
    .reduce((t, r) => {
      const v = Number(manual[r.openingId]);
      return t + (Number.isFinite(v) && v > 0 ? v : 0);
    }, 0);

  if (openings.isLoading) return null;

  return (
    <div className="detail-card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0 }}>Estimates — by signature</h2>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
        Each unit's number comes from its cohort, labelled with where it came
        from and how many installs back it up. Thin cohorts fall back a rung;
        no rung means no number — type a manual figure instead.
        {legacyCount > 0 &&
          ` Includes ${legacyCount} legacy-timed unit${legacyCount === 1 ? "" : "s"} (pre-sessions wall clock).`}
      </p>

      <p style={{ margin: "0 0 8px", fontVariantNumeric: "tabular-nums" }}>
        <strong>
          Remaining work: {Math.round((job.remainingMin + manualTotal) / 60)}h{" "}
          {Math.round(job.remainingMin + manualTotal) % 60}m
        </strong>{" "}
        <span className="muted" style={{ fontSize: 12.5 }}>
          · {job.remainingCovered} from data
          {manualTotal > 0 ? " + manual figures" : ""}
          {job.remainingUncovered > 0 ? ` · ${job.remainingUncovered} without a number` : ""}
          {job.unsigned > 0
            ? ` · ${job.unsigned} unsigned (confirm specs, then Re-read)`
            : ""}
        </span>
      </p>

      <ul className="unit-list work-list">
        {job.rows.map((r) => (
          <li key={r.openingId} className="find-row" style={{ padding: "6px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong>{r.code}</strong>
              {r.installed && <span className="ok" style={{ fontSize: 11 }}>installed</span>}
              <span className="muted" style={{ fontSize: 12 }}>
                {r.described ?? "no signature yet"}
              </span>
              <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                {r.estimate?.minutes != null ? (
                  <>
                    <strong>{r.estimate.minutes}m</strong>{" "}
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {r.estimate.label}
                    </span>
                  </>
                ) : r.described ? (
                  <>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {r.estimate?.label ?? "no estimate yet"}
                    </span>{" "}
                    {!r.installed && (
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        placeholder="manual min"
                        style={{ width: 90 }}
                        value={manual[r.openingId] ?? ""}
                        onChange={(e) =>
                          setManual((m) => ({ ...m, [r.openingId]: e.target.value }))
                        }
                      />
                    )}
                  </>
                ) : (
                  <span className="muted" style={{ fontSize: 11.5 }}>—</span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
