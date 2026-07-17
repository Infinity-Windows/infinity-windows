import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import {
  ackTalk,
  getTodayTalk,
  listIncidents,
  myAck,
  reportIncident,
} from "../lib/ops";

const SEVERITY = [
  { v: "near_miss", l: "Near miss", mild: true },
  { v: "first_aid", l: "First aid", mild: true },
  { v: "recordable", l: "Recordable", mild: false },
  { v: "serious", l: "Serious", mild: false },
];

export function Safety() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isForemanPlus(me.data?.role);
  const talk = useQuery({ queryKey: ["todayTalk"], queryFn: getTodayTalk });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const acked = useQuery({
    queryKey: ["myAck", talk.data?.id, me.data?.id],
    queryFn: () => myAck(talk.data!.id, me.data!.id),
    enabled: Boolean(talk.data?.id && me.data?.id),
  });
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: listIncidents, enabled: lead });

  const [desc, setDesc] = useState("");
  const [sev, setSev] = useState("near_miss");
  const [proj, setProj] = useState("");
  const [sent, setSent] = useState(false);

  const ack = useMutation({
    mutationFn: () => ackTalk(talk.data!.id, me.data!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["myAck"] }),
  });
  const report = useMutation({
    mutationFn: () =>
      reportIncident({ profileId: me.data?.id, projectId: proj || null, description: desc, severity: sev }),
    onSuccess: () => {
      setSent(true); setDesc("");
      queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Safety</h1>
          <p className="muted" style={{ margin: 0 }}>
            Nobody gets hurt installing a window. Ever.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <h2>Today's toolbox talk</h2>
      {talk.data ? (
        <div className="talk-hero">
          <p className="next-label">Today's toolbox talk</p>
          <h3>{talk.data.title}</h3>
          <p className="muted" style={{ margin: 0, lineHeight: 1.65 }}>{talk.data.body}</p>
          {acked.data ? (
            <p className="ok" style={{ margin: 0 }}>Acknowledged ✓</p>
          ) : (
            <button className="primary big" disabled={ack.isPending} onClick={() => ack.mutate()}>
              I read this
            </button>
          )}
        </div>
      ) : (
        <p className="muted">No toolbox talk posted yet.</p>
      )}

      <h2>Report an incident</h2>
      {sent && <p className="ok">Reported. Stay safe out there.</p>}
      <div className="detail-card">
        <label className="field-label">Severity</label>
        <div className="sev-chip-row">
          {SEVERITY.map((s) => (
            <button
              key={s.v}
              type="button"
              className={
                sev === s.v
                  ? `sev-chip active${s.mild ? " mild" : ""}`
                  : "sev-chip"
              }
              onClick={() => setSev(s.v)}
            >
              {s.l}
            </button>
          ))}
        </div>
        <label className="field-label">What happened?</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the incident / near miss" />
        <label className="field-label">Job (optional)</label>
        <select value={proj} onChange={(e) => setProj(e.target.value)}>
          <option value="">— none —</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.job_code}</option>)}
        </select>
        <button className="primary big" disabled={report.isPending || !desc.trim()} onClick={() => report.mutate()}>
          Report
        </button>
        <p className="signin-footnote" style={{ textAlign: "left" }}>
          Recordables must hit the OSHA 300 log within 7 days — the clock starts when you hit Report.
        </p>
      </div>

      {lead && (
        <>
          <h2>Incident log ({incidents.data?.length ?? 0})</h2>
          <ul className="unit-list work-list">
            {(incidents.data ?? []).map((i) => (
              <li key={i.id} className="find-row">
                <div>
                  <strong>{i.description}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {i.projects?.job_code ?? ""} · {i.created_at.slice(0, 10)}
                  </div>
                </div>
                <span
                  className={i.severity === "serious" || i.severity === "recordable" ? "error" : "warn-text"}
                  style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}
                >
                  {i.severity.replace("_", " ")}
                </span>
              </li>
            ))}
            {incidents.data?.length === 0 && <p className="muted">No incidents logged. Keep it that way.</p>}
          </ul>
        </>
      )}
    </div>
  );
}
