import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  getTodayTalk,
  listIncidents,
  reportIncident,
  type SafetyTalk,
  type TalkSections,
} from "../lib/ops";
import {
  generateToolboxTalk,
  listMyCompletions,
  myTodayCompletion,
  signedRecordUrl,
  submitToolboxCompletion,
  todayCompliance,
  updateTalkSections,
} from "../lib/toolbox";
import { SignaturePad, type SignaturePadHandle } from "../components/SignaturePad";

const SEVERITY = [
  { v: "near_miss", l: "Near miss", mild: true },
  { v: "first_aid", l: "First aid", mild: true },
  { v: "recordable", l: "Recordable", mild: false },
  { v: "serious", l: "Serious", mild: false },
];

function PdfLink({ path, label }: { path: string; label: string }) {
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    const url = await signedRecordUrl(path);
    setLoading(false);
    if (url) window.open(url, "_blank", "noopener");
  };
  return (
    <button type="button" className="button-like" onClick={open} disabled={loading}>
      {loading ? "Opening…" : label}
    </button>
  );
}

function TalkContent({ talk }: { talk: SafetyTalk }) {
  const s = talk.sections_json ?? null;
  const aids = talk.visual_aids_json ?? [];
  if (!s || (!s.intro && !s.key_hazards?.length && !s.steps?.length)) {
    return <p className="muted" style={{ margin: 0, lineHeight: 1.65 }}>{talk.body}</p>;
  }
  return (
    <div>
      {s.intro && <p style={{ margin: "0 0 6px", lineHeight: 1.6 }}>{s.intro}</p>}
      {!!s.key_hazards?.length && (
        <div className="talk-section hazards">
          <h4>Key hazards</h4>
          <ul className="talk-list">
            {s.key_hazards.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}
      {!!s.steps?.length && (
        <div className="talk-section">
          <h4>Step by step</h4>
          <ol className="talk-list talk-steps">
            {s.steps.map((st, i) => <li key={i}>{st}</li>)}
          </ol>
        </div>
      )}
      {(!!s.dos?.length || !!s.donts?.length) && (
        <div className="talk-section">
          <div className="dodont-grid">
            <div className="do">
              <h4 style={{ color: "var(--ok)" }}>Do</h4>
              <ul className="talk-list">
                {(s.dos ?? []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
            <div className="dont">
              <h4 style={{ color: "var(--danger)" }}>Don't</h4>
              <ul className="talk-list">
                {(s.donts ?? []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
      {!!aids.length && (
        <div className="talk-section">
          <h4>Visual aids</h4>
          <div className="talk-aids">
            {aids.map((a, i) =>
              a.url ? (
                <figure key={i} className="talk-aid">
                  <img src={a.url} alt={a.prompt} />
                  <figcaption className="aid-caption">{a.prompt}</figcaption>
                </figure>
              ) : (
                <div key={i} className="talk-aid placeholder">
                  <strong>Diagram:</strong> {a.prompt}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function toLines(xs?: string[] | null): string {
  return (xs ?? []).join("\n");
}
function fromLines(v: string): string[] {
  return v.split("\n").map((l) => l.trim()).filter(Boolean);
}

function TalkEditor({ talk, onSaved }: { talk: SafetyTalk; onSaved: () => void }) {
  const s = talk.sections_json ?? {};
  const [intro, setIntro] = useState(s.intro ?? "");
  const [hazards, setHazards] = useState(toLines(s.key_hazards));
  const [steps, setSteps] = useState(toLines(s.steps));
  const [dos, setDos] = useState(toLines(s.dos));
  const [donts, setDonts] = useState(toLines(s.donts));

  const save = useMutation({
    mutationFn: () =>
      updateTalkSections(talk.id, {
        sections_json: {
          intro: intro.trim(),
          key_hazards: fromLines(hazards),
          steps: fromLines(steps),
          dos: fromLines(dos),
          donts: fromLines(donts),
        } satisfies TalkSections,
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="detail-card" style={{ marginTop: 10 }}>
      <label className="field-label">Intro</label>
      <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={3} />
      <label className="field-label">Key hazards (one per line)</label>
      <textarea value={hazards} onChange={(e) => setHazards(e.target.value)} rows={4} />
      <label className="field-label">Steps (one per line)</label>
      <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={5} />
      <label className="field-label">Do (one per line)</label>
      <textarea value={dos} onChange={(e) => setDos(e.target.value)} rows={3} />
      <label className="field-label">Don't (one per line)</label>
      <textarea value={donts} onChange={(e) => setDonts(e.target.value)} rows={3} />
      <button className="primary big" disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save content"}
      </button>
    </div>
  );
}

export function Safety() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const talk = useQuery({ queryKey: ["todayTalk"], queryFn: getTodayTalk });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const myDone = useQuery({
    queryKey: ["toolboxToday", me.data?.id],
    queryFn: () => myTodayCompletion(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const myHistory = useQuery({
    queryKey: ["toolboxHistory", me.data?.id],
    queryFn: () => listMyCompletions(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const compliance = useQuery({
    queryKey: ["toolboxCompliance"],
    queryFn: todayCompliance,
    enabled: lead,
  });
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: listIncidents, enabled: lead });

  const sigRef = useRef<SignaturePadHandle>(null);
  const [ack, setAck] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [sigEmpty, setSigEmpty] = useState(true);
  const [editing, setEditing] = useState(false);

  const [desc, setDesc] = useState("");
  const [sev, setSev] = useState("near_miss");
  const [proj, setProj] = useState("");
  const [sent, setSent] = useState(false);

  const sign = useMutation({
    mutationFn: () =>
      submitToolboxCompletion({
        talk: talk.data!,
        profileId: me.data!.id,
        typedName: typedName.trim(),
        signatureDataUrl: sigRef.current!.toDataUrl(),
      }),
    onSuccess: () => {
      setAck(false);
      setTypedName("");
      sigRef.current?.clear();
      queryClient.invalidateQueries({ queryKey: ["toolboxToday"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxHistory"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxCompliance"] });
    },
  });

  const regen = useMutation({
    mutationFn: () => generateToolboxTalk({ talkId: talk.data!.id, topic: talk.data!.title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["todayTalk"] }),
  });

  const report = useMutation({
    mutationFn: () =>
      reportIncident({ profileId: me.data?.id, projectId: proj || null, description: desc, severity: sev }),
    onSuccess: () => {
      setSent(true); setDesc("");
      queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  const canSubmit =
    ack && typedName.trim().length > 1 && !sigEmpty && Boolean(talk.data && me.data);

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
          <p className="next-label">Read + sign before you clock in</p>
          <h3>{talk.data.title}</h3>
          <TalkContent talk={talk.data} />

          {lead && (
            <div className="grade-row" style={{ marginTop: 4 }}>
              <button
                className="button-like"
                disabled={regen.isPending}
                onClick={() => regen.mutate()}
              >
                {regen.isPending ? "Generating…" : "Generate educational content (AI)"}
              </button>
              <button className="button-like" onClick={() => setEditing((v) => !v)}>
                {editing ? "Close editor" : "Edit content"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">No toolbox talk posted yet.</p>
      )}

      {lead && editing && talk.data && (
        <TalkEditor
          talk={talk.data}
          onSaved={() => {
            setEditing(false);
            queryClient.invalidateQueries({ queryKey: ["todayTalk"] });
          }}
        />
      )}

      {talk.data && (
        myDone.data ? (
          <div className="detail-card">
            <p className="ok" style={{ margin: 0 }}>Signed today ✓</p>
            <p className="muted" style={{ margin: "4px 0 8px" }}>
              {new Date(myDone.data.signed_at).toLocaleString()} · {myDone.data.typed_name}
            </p>
            {myDone.data.pdf_path && (
              <PdfLink path={myDone.data.pdf_path} label="View signed PDF" />
            )}
          </div>
        ) : (
          <div className="detail-card">
            <label className="ack-row">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I have read and understand this toolbox talk.</span>
            </label>
            <label className="field-label">Your full name</label>
            <input
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your full name"
            />
            <label className="field-label">Signature</label>
            <SignaturePad ref={sigRef} onChange={setSigEmpty} />
            <div className="grade-row">
              <button
                type="button"
                className="button-like"
                onClick={() => { sigRef.current?.clear(); }}
              >
                Clear signature
              </button>
            </div>
            {sign.isError && (
              <p className="error">Couldn't save: {String((sign.error as Error).message)}</p>
            )}
            <button
              className="primary big"
              disabled={!canSubmit || sign.isPending}
              onClick={() => sign.mutate()}
            >
              {sign.isPending ? "Signing…" : "Sign & complete"}
            </button>
            <p className="signin-footnote" style={{ textAlign: "left" }}>
              You must complete + sign this before your first clock-in today.
            </p>
          </div>
        )
      )}

      {(myHistory.data?.length ?? 0) > 0 && (
        <>
          <h2>My signed talks</h2>
          <ul className="unit-list work-list">
            {(myHistory.data ?? []).map((c) => (
              <li key={c.id} className="find-row">
                <div>
                  <strong>{c.safety_talks?.title ?? "Toolbox talk"}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {new Date(c.signed_at).toLocaleString()}
                  </div>
                </div>
                {c.pdf_path && (
                  <span style={{ marginLeft: "auto" }}>
                    <PdfLink path={c.pdf_path} label="PDF" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {lead && (
        <>
          <h2>Signed today ({(compliance.data ?? []).filter((r) => r.signed).length}/{compliance.data?.length ?? 0})</h2>
          <ul className="unit-list work-list">
            {(compliance.data ?? []).map((r) => (
              <li key={r.profile_id} className="find-row compliance-row">
                <div>
                  <strong>{r.display_name}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>{r.role}</div>
                </div>
                <span
                  className={r.signed ? "status-yes" : "status-no"}
                  style={{ marginLeft: "auto" }}
                >
                  {r.signed ? "Signed ✓" : "Not yet"}
                </span>
              </li>
            ))}
            {compliance.data?.length === 0 && <p className="muted">No active crew.</p>}
          </ul>
        </>
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
