import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EmptyState,
  QueryError,
  SkeletonList,
} from "../../components/ui/States";
import {
  partnerWorkflow,
  partnerReply,
  sharedFileUrl,
  type SharedJob,
} from "../../lib/proposals/partner";
import { KINDS, STAGE_LABELS, startLabel } from "../../lib/proposals/model";
import { formatApiError } from "../../lib/errors";

function SharedCard({ job }: { job: SharedJob }) {
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function respond(confirm: boolean) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await partnerReply(job, note, confirm);
      setNote("");
      setSaved(true);
      await client.invalidateQueries({ queryKey: ["stgWorkflow"] });
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="find-row" style={{ display: "block", padding: 16 }}>
      <div className="row-between">
        <h2 style={{ fontSize: 18, margin: 0 }}>{job.name}</h2>
        <span>{STAGE_LABELS[job.stage]}</span>
      </div>
      <p className="muted">
        {KINDS[job.kind]} ·{" "}
        {[job.address, job.city, job.state].filter(Boolean).join(", ")}
      </p>
      <p>{startLabel(job)}</p>
      <details>
        <summary>Proposals ({job.bids.length})</summary>
        {job.bids.map((b) => (
          <div key={b.id} style={{ padding: "12px 0" }}>
            <strong>
              {b.number} · revision {b.revision} ·{" "}
              {Number(b.amount).toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })}
            </strong>
            <p style={{ whiteSpace: "pre-wrap" }}>{b.scope}</p>
            {b.accepted_at && (
              <p>
                Accepted:{" "}
                {Number(b.accepted_amount).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}{" "}
                · {b.accepted_scope}
              </p>
            )}
          </div>
        ))}
      </details>
      <details>
        <summary>Files ({job.files.length})</summary>
        {job.files.map((f) => (
          <p key={f.id}>
            <button
              onClick={async () => {
                setError("");
                try {
                  const url = await sharedFileUrl(f);
                  window.location.assign(url);
                } catch (e) {
                  setError(formatApiError(e));
                }
              }}
            >
              {f.filename}
            </button>
          </p>
        ))}
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void respond(false);
        }}
        style={{ marginTop: 16 }}
      >
        <label>
          Response for {job.name}
          <textarea
            style={{ display: "block", width: "100%", boxSizing: "border-box", minHeight: 100, marginTop: 8, marginBottom: 12, padding: 12, font: "inherit", color: "inherit", background: "var(--surface, #fff)", border: "1px solid var(--border, #ddd)", borderRadius: 10, resize: "vertical" }}
            value={note}
            required
            maxLength={4000}
            disabled={busy}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
            placeholder="Questions, site details, or a scheduling update"
          />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={busy || !note.trim()}>Save response</button>
          {job.start_precision === "date" && job.target_start && (
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => void respond(true)}
            >
              Approve start {job.target_start}
            </button>
          )}
        </div>
        <small className="muted">Saved to this job. No email is sent.</small>
      </form>
      {saved && <p role="status">Response saved.</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
export function StgWorkflow() {
  const q = useQuery({ queryKey: ["stgWorkflow"], queryFn: partnerWorkflow });
  if (q.isLoading) return <SkeletonList rows={3} />;
  if (q.error)
    return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length)
    return (
      <EmptyState
        title="No proposals shared yet"
        message="Your shared jobs, proposals, and documents will appear here."
      />
    );
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {q.data.map((j) => (
        <SharedCard key={j.id} job={j} />
      ))}
    </div>
  );
}
