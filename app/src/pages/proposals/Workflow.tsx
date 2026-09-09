import {
  useState,
  useEffect,
  useRef,
  useId,
  cloneElement,
  type FormEvent,
  type ReactElement,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Search,
  FileText,
  MapPin,
  Clock3,
  ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  createJob,
  loadWorkflow,
  loadJob,
  writeWorkflow,
  uploadJobFile,
  openJobFile,
} from "../../lib/proposals/api";
import {
  STAGES,
  STAGE_LABELS,
  KINDS,
  STATES,
  followUpDue,
  latestBids,
  money,
  startLabel,
  daysOld,
  localDay,
  type Job,
  type Bid,
  type Rate,
  type JobFile,
  type Kind,
  type Stage,
} from "../../lib/proposals/model";
import { formatApiError } from "../../lib/errors";
import { showUndoToast } from "../../lib/undoToast";
import "./workflow.css";

type Work = (action: () => Promise<unknown>) => Promise<boolean>;
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="pw-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
function KindSelect({
  value,
  onChange,
  id,
}: {
  value: Kind;
  onChange: (v: Kind) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as Kind)}
    >
      {Object.entries(KINDS).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
export function Workflow() {
  const client = useQueryClient();
  const [section, setSection] = useState("jobs");
  const [view, setView] = useState(() =>
    window.matchMedia("(max-width: 600px)").matches ? "list" : "board",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [contractor, setContractor] = useState("");
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const [closed, setClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["proposalWorkflow"],
    queryFn: loadWorkflow,
  });
  const work: Work = async (action) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (e) {
      setError(formatApiError(e));
      return false;
    } finally {
      await client.invalidateQueries({ queryKey: ["proposalWorkflow"] });
      await client.invalidateQueries({ queryKey: ["proposalJob"] });
      setBusy(false);
    }
  };
  const jobs = query.data?.jobs ?? [];
  const bids = query.data?.bids ?? [];
  const selectedJob = jobs.find((j) => j.id === selected);
  async function move(job: Job, stage: Stage) {
    if (stage === job.stage) return;
    await work(async () => {
      const result = await writeWorkflow("stage", {
        job_id: job.id,
        version: job.version,
        stage,
      });
      showUndoToast({
        message: `Moved to ${STAGE_LABELS[stage]}`,
        undo: async () => {
          await writeWorkflow("stage", {
            job_id: job.id,
            version: result.job.version,
            stage: job.stage,
          });
          await client.invalidateQueries({ queryKey: ["proposalWorkflow"] });
        },
      });
    });
  }
  const filtered = jobs.filter(
    (j) =>
      (!search ||
        [
          j.name,
          j.contractor,
          j.address,
          j.contact_name,
          j.contact_email,
          ...bids.filter((b) => b.job_id === j.id).map((b) => b.number),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!contractor || j.contractor === contractor) &&
      (!state || j.state === state) &&
      (!kind || j.kind === kind) &&
      (section === "followups"
        ? followUpDue(j)
        : closed || !["complete", "lost", "on_hold"].includes(j.stage)),
  );
  return (
    <div className="page pw">
      <header className="pw-header">
        <div>
          <p className="pw-eyebrow">ST. GEORGE, UTAH</p>
          <h1>Workflow</h1>
          <p className="muted">Every proposal. Every next step.</p>
        </div>
        {!selectedJob && section !== "rates" && (
          <button
            onClick={() => setAdding(true)}
            disabled={busy || !query.data?.available}
          >
            <Plus size={18} /> Add job
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {query.isPending ? (
        <p role="status">Loading Workflow…</p>
      ) : query.error ? (
        <div role="alert">
          {formatApiError(query.error)}{" "}
          <button onClick={() => void query.refetch()}>Retry</button>
        </div>
      ) : !query.data?.available ? (
        <p role="status">
          Workflow is being set up. Your existing jobs are unchanged.
        </p>
      ) : selectedJob ? (
        <JobDetail
          key={selectedJob.id}
          job={selectedJob}
          bids={bids.filter((b) => b.job_id === selectedJob.id)}
          work={work}
          busy={busy}
          onBack={() => setSelected(null)}
          onMove={(stage) => void move(selectedJob, stage)}
        />
      ) : (
        <>
          <nav className="pw-tabs" aria-label="Workflow sections">
            {[
              ["jobs", "Jobs"],
              [
                "followups",
                `Follow-ups (${jobs.filter((j) => followUpDue(j)).length})`,
              ],
              ["rates", "Rates"],
            ].map(([id, label]) => (
              <button
                className={section === id ? "active" : ""}
                aria-pressed={section === id}
                key={id}
                onClick={() => setSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          {section === "rates" ? (
            <RateBook rates={query.data.rates} work={work} busy={busy} />
          ) : (
            <>
              <div className="pw-stats">
                <div>
                  <strong>
                    {
                      jobs.filter((j) =>
                        ["intake", "drafting", "submitted"].includes(j.stage),
                      ).length
                    }
                  </strong>
                  <span>Open opportunities</span>
                </div>
                <div>
                  <strong>
                    {
                      jobs.filter((j) =>
                        ["approved", "scheduled"].includes(j.stage),
                      ).length
                    }
                  </strong>
                  <span>Approved / scheduled</span>
                </div>
                <div>
                  <strong>{jobs.filter((j) => followUpDue(j)).length}</strong>
                  <span>Follow-ups due</span>
                </div>
              </div>
              <div className="pw-filters">
                <label className="pw-search">
                  <Search size={17} />
                  <input
                    aria-label="Search jobs"
                    placeholder="Search jobs, contacts, bids…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Filter contractor"
                  value={contractor}
                  onChange={(e) => setContractor(e.target.value)}
                >
                  <option value="">All contractors</option>
                  {[...new Set(jobs.map((j) => j.contractor).filter(Boolean))]
                    .sort()
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
                <select
                  aria-label="Filter state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">All states</option>
                  {STATES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter work type"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="">All work</option>
                  {Object.entries(KINDS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="pw-view">
                <div>
                  <button
                    aria-pressed={view === "board"}
                    onClick={() => setView("board")}
                  >
                    Board
                  </button>
                  <button
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    List
                  </button>
                </div>
                {section === "jobs" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={closed}
                      onChange={(e) => setClosed(e.target.checked)}
                    />{" "}
                    Include held and closed jobs
                  </label>
                )}
              </div>
              {!filtered.length ? (
                <div className="pw-empty">
                  <FileText size={30} />
                  <h2>
                    {section === "followups"
                      ? "You’re caught up"
                      : "A clear place for your next job"}
                  </h2>
                  <p>
                    {section === "followups"
                      ? "No follow-ups are due."
                      : "Add a job, then attach its proposal and supporting files."}
                  </p>
                </div>
              ) : view === "board" ? (
                <div className="pw-board">
                  {STAGES.filter(
                    (s) =>
                      closed || !["complete", "on_hold", "lost"].includes(s),
                  ).map((s) => (
                    <section
                      className="pw-lane"
                      key={s}
                      aria-label={STAGE_LABELS[s]}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const j = jobs.find(
                          (x) => x.id === e.dataTransfer.getData("text/plain"),
                        );
                        if (j && !busy) void move(j, s);
                      }}
                    >
                      <h2>
                        {STAGE_LABELS[s]}{" "}
                        <span>
                          {filtered.filter((j) => j.stage === s).length}
                        </span>
                      </h2>
                      {filtered
                        .filter((j) => j.stage === s)
                        .map((j) => (
                          <JobCard
                            key={j.id}
                            job={j}
                            bids={bids.filter((b) => b.job_id === j.id)}
                            onOpen={() => setSelected(j.id)}
                            onMove={(s) => void move(j, s)}
                            busy={busy}
                          />
                        ))}
                    </section>
                  ))}
                </div>
              ) : (
                <div className="pw-list">
                  {filtered.map((j) => (
                    <JobCard
                      key={j.id}
                      job={j}
                      bids={bids.filter((b) => b.job_id === j.id)}
                      onOpen={() => setSelected(j.id)}
                      onMove={(s) => void move(j, s)}
                      busy={busy}
                    />
                  ))}
                </div>
              )}
              <p className="muted pw-footnote">
                Follow-ups use four calendar days in Mountain time. Email
                sending is not connected yet.
              </p>
            </>
          )}
          {adding && (
            <NewJob
              busy={busy}
              onCancel={() => setAdding(false)}
              onSave={(name, c, k) =>
                void work(async () => {
                  const j = await createJob(name, c, k);
                  setAdding(false);
                  setSelected(j.id);
                })
              }
            />
          )}
        </>
      )}
    </div>
  );
}
function JobCard({
  job,
  bids,
  onOpen,
  onMove,
  busy,
}: {
  job: Job;
  bids: Bid[];
  onOpen: () => void;
  onMove: (s: Stage) => void;
  busy: boolean;
}) {
  const current = latestBids(bids);
  const first = bids
    .map((b) => b.submitted_at)
    .filter((x): x is string => !!x)
    .sort()[0];
  return (
    <article
      className="pw-card"
      draggable={!busy}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", job.id)}
    >
      <button className="pw-card-title" onClick={onOpen}>
        {job.name}
      </button>
      <p>{job.contractor || "Contractor not set"}</p>
      <div className="pw-badges">
        <span>{KINDS[job.kind]}</span>
        <span>{job.state === "UT" ? "In-state" : "Out-of-state"}</span>
      </div>
      <p className="pw-location">
        <MapPin size={13} />
        {[job.city, job.state].filter(Boolean).join(", ")}
      </p>
      <strong>
        {current.length === 1
          ? money(current[0].amount)
          : current.length
            ? `${current.length} bids`
            : "No bid yet"}
      </strong>
      {bids.some((b) => b.accepted_at) && (
        <small>
          Accepted scope recorded
          {bids.some(
            (b) =>
              b.accepted_at && Number(b.accepted_amount) < Number(b.amount),
          )
            ? " · partial award"
            : ""}
        </small>
      )}
      <small>
        {first
          ? `${daysOld(first)} days since first submission`
          : "Not submitted"}
      </small>
      <small>{startLabel(job)}</small>
      {job.follow_up_on && (
        <div className={followUpDue(job) ? "pw-due" : "pw-next"}>
          <Clock3 size={14} /> Follow up {job.follow_up_on}
        </div>
      )}
      <select
        aria-label={`Move ${job.name}`}
        value={job.stage}
        disabled={busy}
        onChange={(e) => onMove(e.target.value as Stage)}
      >
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
    </article>
  );
}
function NewJob({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (n: string, c: string, k: Kind) => void;
}) {
  const [name, setName] = useState("");
  const [contractor, setContractor] = useState("STG Windows");
  const [kind, setKind] = useState<Kind>("installation");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onCancel();
      }}
      aria-label="Add job"
      className="pw-dialog"
    >
      <h2>Add a job</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name, contractor, kind);
        }}
      >
        <Field label="Job name">
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Contractor">
          <input
            value={contractor}
            onChange={(e) => setContractor(e.target.value)}
          />
        </Field>
        <Field label="Work type">
          <KindSelect value={kind} onChange={setKind} />
        </Field>
        <div className="pw-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Create job"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function JobDetail({
  job,
  bids,
  work,
  busy,
  onBack,
  onMove,
}: {
  job: Job;
  bids: Bid[];
  work: Work;
  busy: boolean;
  onBack: () => void;
  onMove: (s: Stage) => void;
}) {
  const [tab, setTab] = useState("overview");
  const q = useQuery({
    queryKey: ["proposalJob", job.id],
    queryFn: () => loadJob(job.id),
  });
  return (
    <>
      <button className="pw-back" onClick={onBack}>
        <ArrowLeft size={16} /> All jobs
      </button>
      <div className="pw-job-heading">
        <h2>{job.name}</h2>
        <select
          aria-label="Job stage"
          value={job.stage}
          disabled={busy}
          onChange={(e) => onMove(e.target.value as Stage)}
        >
          {STAGES.map((s) => (
            <option value={s} key={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <nav className="pw-tabs" aria-label="Job sections">
        {["overview", "bids", "files", "activity"].map((s) => (
          <button
            key={s}
            aria-pressed={tab === s}
            className={tab === s ? "active" : ""}
            onClick={() => setTab(s)}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </nav>
      {q.error && (
        <p role="alert">
          {formatApiError(q.error)}{" "}
          <button onClick={() => void q.refetch()}>Retry</button>
        </p>
      )}
      {tab === "overview" && <Overview job={job} work={work} busy={busy} />}
      {tab === "bids" && (
        <Bids
          job={job}
          bids={bids}
          files={q.data?.files ?? []}
          work={work}
          busy={busy}
        />
      )}
      {tab === "files" && (
        <Files job={job} files={q.data?.files ?? []} work={work} busy={busy} />
      )}
      {tab === "activity" && (
        <>
          <ActivityForm job={job} work={work} busy={busy} />
          <div className="pw-timeline">
            {(q.data?.activity ?? []).map((a) => (
              <article key={a.id}>
                <small>
                  {new Date(a.created_at).toLocaleString()} · {a.kind}
                </small>
                <p>{a.detail}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
function Overview({
  job,
  work,
  busy,
}: {
  job: Job;
  work: Work;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(job);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof Job, value: string) => {
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await work(async () => {
      const result = await writeWorkflow("edit", {
        ...draft,
        job_id: job.id,
        version: draft.version,
        target_start:
          draft.start_precision === "unknown" ? null : draft.target_start,
        target_end: draft.start_precision === "range" ? draft.target_end : null,
      });
      setDraft(result.job);
    });
    if (ok) setSaved(true);
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="pw-panel">
      <div className="pw-form-grid">
        {[
          ["name", "Job name"],
          ["contractor", "Contractor"],
          ["contact_name", "Contact name"],
          ["contact_email", "Contact email"],
          ["contact_phone", "Contact phone"],
          ["address", "Street address"],
          ["city", "City"],
        ].map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              required={key === "name"}
              type={key === "contact_email" ? "email" : "text"}
              value={String(draft[key as keyof Job] ?? "")}
              onChange={(e) => set(key as keyof Job, e.target.value)}
            />
          </Field>
        ))}
        <Field label="State">
          <select
            value={draft.state}
            onChange={(e) => set("state", e.target.value)}
          >
            {STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Work type">
          <KindSelect value={draft.kind} onChange={(v) => set("kind", v)} />
        </Field>
      </div>
      <Field label="Scope">
        <textarea
          rows={3}
          value={draft.scope}
          onChange={(e) => set("scope", e.target.value)}
        />
      </Field>
      <Field label="Internal notes">
        <textarea
          rows={3}
          value={draft.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
      <h3>Start timing</h3>
      <p className="muted">
        Your team proposes timing; record the contractor’s confirmation when it
        arrives.
      </p>
      <div className="pw-form-grid">
        <Field label="How specific is the target?">
          <select
            value={draft.start_precision}
            onChange={(e) => set("start_precision", e.target.value)}
          >
            {[
              ["unknown", "Not known"],
              ["month", "Month"],
              ["week", "Week starting"],
              ["range", "Date range"],
              ["date", "Exact day"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {draft.start_precision !== "unknown" && (
          <Field label="Target start">
            <input
              required
              type={draft.start_precision === "month" ? "month" : "date"}
              value={
                draft.start_precision === "month"
                  ? (draft.target_start ?? "").slice(0, 7)
                  : (draft.target_start ?? "")
              }
              onChange={(e) =>
                set(
                  "target_start",
                  e.target.value +
                    (draft.start_precision === "month" && e.target.value
                      ? "-01"
                      : ""),
                )
              }
            />
          </Field>
        )}
        {draft.start_precision === "range" && (
          <Field label="Target end">
            <input
              required
              type="date"
              min={draft.target_start ?? undefined}
              value={draft.target_end ?? ""}
              onChange={(e) => set("target_end", e.target.value)}
            />
          </Field>
        )}
        <Field label="Confirmed start">
          <input
            type="date"
            value={draft.confirmed_start ?? ""}
            onChange={(e) => set("confirmed_start", e.target.value)}
          />
        </Field>
        <Field label="Confirmation evidence">
          <input
            required={!!draft.confirmed_start}
            placeholder="Who confirmed it, when, and where"
            value={draft.confirmation_note}
            onChange={(e) => set("confirmation_note", e.target.value)}
          />
        </Field>
        <Field label="Next follow-up">
          <input
            type="date"
            value={draft.follow_up_on ?? ""}
            onChange={(e) => set("follow_up_on", e.target.value)}
          />
        </Field>
      </div>
      {job.project_id && (
        <Link to={`/projects/${job.project_id}`}>
          Open execution job <ExternalLink size={14} />
        </Link>
      )}
      <div className="pw-actions">
        <button disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  );
}
function Bids({
  job,
  bids,
  files,
  work,
  busy,
}: {
  job: Job;
  bids: Bid[];
  files: JobFile[];
  work: Work;
  busy: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState("");
  const [contractor, setContractor] = useState(job.contractor);
  const [amount, setAmount] = useState("");
  const [scope, setScope] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [lines, setLines] = useState("");
  const [accept, setAccept] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (
      await work(() =>
        writeWorkflow("bid", {
          job_id: job.id,
          version: job.version,
          number,
          contractor,
          amount,
          scope,
          line_items: lines
            .split("\n")
            .filter(Boolean)
            .map((description) => ({ description })),
          submitted_at: submitted
            ? new Date(submitted + "T12:00:00").toISOString()
            : null,
        }),
      )
    ) {
      setAdding(false);
      setNumber("");
      setAmount("");
      setScope("");
      setLines("");
      setSubmitted("");
    }
  }
  return (
    <div className="pw-panel">
      <div className="pw-job-heading">
        <div>
          <h3>Proposals and revisions</h3>
          <p className="muted">
            Each save keeps a new revision. Accepted amounts stay unchanged.
          </p>
        </div>
        <button onClick={() => setAdding(!adding)}>
          <Plus size={16} /> Add bid
        </button>
      </div>
      {adding && (
        <form onSubmit={(e) => void save(e)} className="pw-inset">
          <div className="pw-form-grid">
            <Field label="Proposal number">
              <input
                required
                value={number}
                onChange={(e) => setNumber(e.target.value)}
              />
            </Field>
            <Field label="Recipient contractor">
              <input
                required
                value={contractor}
                onChange={(e) => setContractor(e.target.value)}
              />
            </Field>
            <Field label="Bid amount">
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Submitted date">
              <input
                type="date"
                max={localDay()}
                value={submitted}
                onChange={(e) => setSubmitted(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Scope, phases and selected alternates">
            <textarea
              rows={3}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </Field>
          <Field label="Line item descriptions (one per line)">
            <textarea
              rows={4}
              value={lines}
              onChange={(e) => setLines(e.target.value)}
              placeholder="Attach the original proposal for its full pricing breakdown."
            />
          </Field>
          <div className="pw-actions">
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button disabled={busy}>Save new revision</button>
          </div>
        </form>
      )}
      {!bids.length && (
        <p className="pw-empty">
          No proposals yet. Add the first bid and upload its PDF in Files.
        </p>
      )}
      {bids.map((b) => (
        <article key={b.id} className="pw-bid">
          <div className="pw-job-heading">
            <h3>
              {b.number} <small>Revision {b.revision}</small>
            </h3>
            <strong>{money(Number(b.amount))}</strong>
          </div>
          <p>
            {b.contractor} ·{" "}
            {b.submitted_at
              ? `Submitted ${b.submitted_at.slice(0, 10)}`
              : "Not submitted"}
          </p>
          <p className="pw-prewrap">{b.scope}</p>
          {b.line_items.length > 0 && (
            <ul>
              {b.line_items.map((l, i) => (
                <li key={i}>{l.description}</li>
              ))}
            </ul>
          )}
          {!b.submitted_at && (
            <button
              disabled={busy}
              onClick={() =>
                void work(() =>
                  writeWorkflow("submit", {
                    job_id: job.id,
                    version: job.version,
                    bid_id: b.id,
                  }),
                )
              }
            >
              Record submitted today
            </button>
          )}
          {b.accepted_at ? (
            <p className="pw-approved">
              Accepted {money(Number(b.accepted_amount))} · {b.accepted_scope}
            </p>
          ) : (
            <button
              disabled={busy || !b.submitted_at}
              onClick={() => setAccept(accept === b.id ? null : b.id)}
            >
              Record acceptance
            </button>
          )}
          {accept === b.id && !b.accepted_at && (
            <Acceptance
              job={job}
              bid={b}
              files={files}
              work={work}
              busy={busy}
              onDone={() => setAccept(null)}
            />
          )}
        </article>
      ))}
    </div>
  );
}
function Acceptance({
  job,
  bid,
  files,
  work,
  busy,
  onDone,
}: {
  job: Job;
  bid: Bid;
  files: JobFile[];
  work: Work;
  busy: boolean;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(bid.amount));
  const [scope, setScope] = useState(bid.scope);
  const [email, setEmail] = useState("");
  const [file, setFile] = useState("");
  return (
    <form
      className="pw-inset"
      onSubmit={(e) => {
        e.preventDefault();
        void work(async () => {
          await writeWorkflow("accept", {
            job_id: job.id,
            version: job.version,
            bid_id: bid.id,
            accepted_amount: amount,
            accepted_scope: scope,
            acceptance_email: email,
            signed_document_id: file,
          });
          onDone();
        });
      }}
    >
      <Field label="Accepted amount">
        <input
          required
          type="number"
          min="0"
          max={bid.amount}
          step=".01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label="Exactly which work was accepted?">
        <textarea
          required
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        />
      </Field>
      <Field label="Acceptance email evidence">
        <textarea
          required
          placeholder="Paste the acceptance email, including sender and date, or its Gmail link."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Signed proposal">
        <select required value={file} onChange={(e) => setFile(e.target.value)}>
          <option value="">Choose a signed agreement from Files</option>
          {files
            .filter((f) => f.ready && f.kind === "signed_agreement")
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.filename}
              </option>
            ))}
        </select>
      </Field>
      <button disabled={busy}>Save acceptance evidence</button>
    </form>
  );
}
function Files({
  job,
  files,
  work,
  busy,
}: {
  job: Job;
  files: JobFile[];
  work: Work;
  busy: boolean;
}) {
  const [kind, setKind] = useState("proposal");
  const [picked, setPicked] = useState<File | null>(null);
  const [retry, setRetry] = useState<JobFile | undefined>();
  return (
    <div className="pw-panel">
      <h3>Job files</h3>
      <p className="muted">
        Private to supervisors and owners. Keep originals, including CADs,
        specifications and signed proposals.
      </p>
      <form
        className="pw-upload"
        onSubmit={(e) => {
          e.preventDefault();
          if (picked)
            void work(async () => {
              await uploadJobFile(job, picked, kind, retry);
              setPicked(null);
              setRetry(undefined);
            });
        }}
      >
        <Field label="Document type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries({
              proposal: "Proposal",
              signed_agreement: "Signed agreement",
              plans: "Plan set",
              cad: "CAD",
              specification: "Specification",
              photo: "Photo",
              email: "Email",
              other: "Other",
            }).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={retry ? `Select ${retry.filename} to retry` : "Choose a file"}
        >
          <input
            type="file"
            onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
            key={retry?.id ?? "new"}
          />
        </Field>
        <button
          disabled={
            busy ||
            !picked ||
            (!!retry &&
              (picked.name !== retry.filename || picked.size !== retry.bytes))
          }
        >
          {busy ? "Uploading…" : retry ? "Retry upload" : "Attach file"}
        </button>
      </form>
      {!files.length && (
        <p className="pw-empty">
          Attach your proposal, plans and supporting files here.
        </p>
      )}
      <div className="pw-file-list">
        {files.map((f) => (
          <article key={f.id}>
            <FileText size={22} />
            <div>
              <strong>{f.filename}</strong>
              <small>
                {f.kind.replaceAll("_", " ")} ·{" "}
                {(f.bytes / 1024 / 1024).toFixed(2)} MB ·{" "}
                {f.created_at.slice(0, 10)}
              </small>
            </div>
            {f.ready ? (
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const url = await openJobFile(f);
                    const a = document.createElement("a");
                    a.href = url;
                    a.target = "_blank";
                    a.rel = "noopener noreferrer";
                    a.click();
                  })
                }
              >
                Download
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => {
                  setRetry(f);
                  setPicked(null);
                  setKind(f.kind);
                }}
              >
                Retry unfinished upload
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
function ActivityForm({
  job,
  work,
  busy,
}: {
  job: Job;
  work: Work;
  busy: boolean;
}) {
  const [kind, setKind] = useState("note");
  const [detail, setDetail] = useState("");
  return (
    <form
      className="pw-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void work(async () => {
          await writeWorkflow("activity", {
            job_id: job.id,
            version: job.version,
            kind,
            detail,
          });
          setDetail("");
        });
      }}
    >
      <Field label="Activity type">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="note">Internal note</option>
          <option value="sent">Email already sent — log it</option>
          <option value="reply">Contractor response received</option>
        </select>
      </Field>
      <Field label="Details">
        <textarea
          required
          rows={3}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      </Field>
      <p className="muted">
        Recording a sent email sets follow-up in four days. Recording a response
        clears it. This does not send an email.
      </p>
      <button disabled={busy || !detail.trim()}>Record activity</button>
    </form>
  );
}
function RateBook({
  rates,
  work,
  busy,
}: {
  rates: Rate[];
  work: Work;
  busy: boolean;
}) {
  const [category, setCategory] = useState<Kind>("service_call");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("person-hour");
  const [amount, setAmount] = useState("");
  const [contractor, setContractor] = useState("");
  const [minimum, setMinimum] = useState("");
  const [notes, setNotes] = useState("");
  const [effective, setEffective] = useState(localDay());
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="pw-job-heading">
        <div>
          <h2>Your rate book</h2>
          <p className="muted">
            Customer prices, kept separately from internal costs. Changes create
            a new dated entry.
          </p>
        </div>
        <button onClick={() => setAdding(!adding)}>
          <Plus size={16} /> Add rate
        </button>
      </div>
      {adding && (
        <form
          className="pw-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              await writeWorkflow("rate", {
                category,
                name,
                unit,
                amount,
                contractor,
                minimum,
                notes,
                effective_on: effective,
              });
              setAdding(false);
              setName("");
              setAmount("");
            });
          }}
        >
          <div className="pw-form-grid">
            <Field label="Category">
              <KindSelect value={category} onChange={setCategory} />
            </Field>
            <Field label="Rate name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Unit">
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {[
                  "person-hour",
                  "crew-hour",
                  "callout",
                  "unit",
                  "trip",
                  "mile",
                  "day",
                  "fixed",
                ].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
            <Field label="Price (blank if not set)">
              <input
                type="number"
                min="0"
                step=".01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Contractor override (optional)">
              <input
                value={contractor}
                onChange={(e) => setContractor(e.target.value)}
              />
            </Field>
            <Field label="Effective date">
              <input
                required
                type="date"
                value={effective}
                onChange={(e) => setEffective(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Minimum and what it includes">
            <input
              value={minimum}
              onChange={(e) => setMinimum(e.target.value)}
            />
          </Field>
          <Field label="Travel, extras and other terms">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <button disabled={busy}>Save rate</button>
        </form>
      )}
      <div className="pw-rate-grid">
        {Object.entries(KINDS).map(([c, l]) => (
          <section className="pw-panel" key={c}>
            <h3>{l}</h3>
            {!rates.some((r) => r.category === c) && (
              <p className="muted">No rates set yet.</p>
            )}
            {rates
              .filter((r) => r.category === c)
              .map((r) => (
                <article className="pw-rate" key={r.id}>
                  <div className="pw-job-heading">
                    <strong>{r.name}</strong>
                    <strong>
                      {money(r.amount === null ? null : Number(r.amount))}
                    </strong>
                  </div>
                  <small>
                    Per {r.unit} · {r.contractor || "Standard"} · Effective{" "}
                    {r.effective_on}
                  </small>
                  <p>{r.minimum}</p>
                  <p>{r.notes}</p>
                </article>
              ))}
          </section>
        ))}
      </div>
    </>
  );
}
