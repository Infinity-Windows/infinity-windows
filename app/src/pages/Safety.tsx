import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import {
  ackTalk,
  getTodayTalk,
  listIncidents,
  myAck,
  reportIncident,
} from "../lib/ops";

const SEVERITY = [
  { v: "near_miss", l: "Near miss" },
  { v: "first_aid", l: "First aid" },
  { v: "recordable", l: "Recordable" },
  { v: "serious", l: "Serious" },
];

export function Safety() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
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
        <h1>Safety</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">Nobody gets hurt installing a window. Ever.</p>

      <h2>Today's toolbox talk</h2>
      {talk.data ? (
        <div className="detail-card">
          <p><strong>{talk.data.title}</strong></p>
          <p className="muted">{talk.data.body}</p>
          {acked.data ? (
            <p className="ok">Acknowledged ✓</p>
          ) : (
            <button className="primary" disabled={ack.isPending} onClick={() => ack.mutate()}>
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
        <label className="field-label">What happened?</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the incident / near miss" />
        <label className="field-label">Severity</label>
        <select value={sev} onChange={(e) => setSev(e.target.value)}>
          {SEVERITY.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        <label className="field-label">Job (optional)</label>
        <select value={proj} onChange={(e) => setProj(e.target.value)}>
          <option value="">— none —</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.job_code}</option>)}
        </select>
        <button className="action-btn" disabled={report.isPending || !desc.trim()} onClick={() => report.mutate()}>
          Report
        </button>
      </div>

      {lead && (
        <>
          <h2>Incident log ({incidents.data?.length ?? 0})</h2>
          <ul className="unit-list">
            {(incidents.data ?? []).map((i) => (
              <li key={i.id}>
                <strong className={i.severity === "serious" ? "error" : ""}>{i.severity}</strong>{" "}
                <span className="muted">{i.projects?.job_code ?? ""} · {i.created_at.slice(0, 10)}</span>
                <div>{i.description}</div>
              </li>
            ))}
            {incidents.data?.length === 0 && <p className="muted">No incidents logged. Keep it that way.</p>}
          </ul>
        </>
      )}
    </div>
  );
}
