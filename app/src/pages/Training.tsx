import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listWindowTypes } from "../lib/api";
import {
  getMyProfile,
  listClearances,
  listInstallerTypeStats,
  listProfiles,
  setClearance,
} from "../lib/install/api";
import { isLeadLike, ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { knowledgeScore } from "../lib/glossary";
import { listMyProgress } from "../lib/learn";

const CLEAR_MIN_INSTALLS = 2;
const CLEAR_MIN_GRADE = 3.5;
const CLEAR_MIN_KNOWLEDGE = 40; // must know the terms before we clear them

export function Training() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
  const stats = useQuery({
    queryKey: ["installerTypeStats"],
    queryFn: listInstallerTypeStats,
  });
  const clearances = useQuery({ queryKey: ["clearances"], queryFn: listClearances });

  const isLead = isLeadLike(me.data?.role);
  const [selected, setSelected] = useState<string>("");
  const installerId = isLead ? selected || me.data?.id || "" : me.data?.id || "";

  const progress = useQuery({
    queryKey: ["learnProgress", installerId],
    queryFn: () => listMyProgress(installerId),
    enabled: Boolean(installerId),
  });
  const knowledge = knowledgeScore(progress.data ?? []);

  const clear = useMutation({
    mutationFn: (args: { typeId: string; cleared: boolean }) =>
      setClearance(installerId, args.typeId, args.cleared),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clearances"] });
    },
  });

  const rows = useMemo(() => {
    const clearedSet = new Set(
      (clearances.data ?? [])
        .filter((c) => c.installer_id === installerId)
        .map((c) => c.window_type_id),
    );
    const statByType = new Map(
      (stats.data ?? [])
        .filter((s) => s.installer_id === installerId)
        .map((s) => [s.window_type_id, s]),
    );
    return (types.data ?? [])
      .map((t) => {
        const st = statByType.get(t.id);
        const cleared = clearedSet.has(t.id);
        const eligible =
          !!st &&
          (st.n ?? 0) >= CLEAR_MIN_INSTALLS &&
          (st.avg_grade ?? 0) >= CLEAR_MIN_GRADE &&
          knowledge >= CLEAR_MIN_KNOWLEDGE;
        return { type: t, st, cleared, eligible };
      })
      // Show cleared, worked, or eligible types (skip the full 100-type catalog).
      .filter((r) => r.cleared || r.st || r.eligible)
      .sort((a, b) => Number(b.cleared) - Number(a.cleared));
  }, [types.data, stats.data, clearances.data, installerId, knowledge]);

  const allTypes = types.data ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Training</h1>
          <p className="muted" style={{ margin: 0 }}>
            Clearance says who can install what.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>
      <p className="muted">
        A cleared apprentice can be routed to a harder type — training changes
        dispatch.
      </p>

      {isLead && (
        <>
          <label className="field-label">Installer</label>
          <select value={installerId} onChange={(e) => setSelected(e.target.value)}>
            {(crew.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} (skill {c.skill_level}
                {c.role !== "installer" ? `, ${ROLE_LABELS[c.role as CrewRole] ?? c.role}` : ""})
              </option>
            ))}
          </select>
        </>
      )}

      <div className="stat-grid">
        <div className="stat-card accent">
          <span className="stat-num">{knowledge}</span>
          <span>knowledge score</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{rows.filter((r) => r.cleared).length}</span>
          <span>types cleared</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Clearance needs {CLEAR_MIN_INSTALLS}+ installs at grade {CLEAR_MIN_GRADE}+
        AND knowledge {CLEAR_MIN_KNOWLEDGE}+.{" "}
        {knowledge < CLEAR_MIN_KNOWLEDGE
          ? `Do more in Education to raise the score (at ${knowledge}).`
          : "Knowledge bar met."}
      </p>

      <ul className="unit-list work-list">
        {rows.map(({ type, st, cleared, eligible }) => (
          <li key={type.id} className="find-row">
            <div>
              <Link to={`/brain/${type.id}`}>
                <strong>{type.type_code}</strong>
              </Link>{" "}
              <span className="muted">{type.name}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {st ? `${st.n} installs · avg ${st.avg_grade ?? "—"}` : "no installs yet"}
                {!cleared && eligible ? " · ready to clear" : ""}
              </div>
            </div>
            {isLead ? (
              <button
                className={cleared ? "grade-btn selected" : "grade-btn"}
                style={{ marginLeft: "auto", flex: "0 0 auto" }}
                disabled={clear.isPending}
                onClick={() => clear.mutate({ typeId: type.id, cleared: !cleared })}
              >
                {cleared ? "Cleared ✓" : "Clear"}
              </button>
            ) : (
              <span style={{ marginLeft: "auto" }} className={cleared ? "ok" : "muted"}>
                {cleared ? "cleared" : eligible ? "ready" : "learning"}
              </span>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <p className="muted">
            No install history yet for this installer. Clearances can still be
            added below.
          </p>
        )}
      </ul>

      {isLead && (
        <>
          <h2>Clear another type</h2>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                clear.mutate({ typeId: e.target.value, cleared: true });
                e.target.value = "";
              }
            }}
          >
            <option value="">— pick a window type —</option>
            {allTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.type_code} {t.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
